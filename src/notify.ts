// The completion message: what the agent hears when a task ends.
import { debugError } from "./debug.ts";
import { openView } from "./logview.ts";
import type { KillReason, Task, TaskState } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

export const MESSAGE_TYPE = "pi-bg-bash";
/** How many lines of the log's end the message carries. */
const TAIL_LINES = 20;
/** The byte cap on that tail. */
const TAIL_BYTES = 4096;
/** How much of the log's end is read to find those lines. */
const READ_WINDOW = 64 * 1024;

/** `1.2s`, or `2m 5s` from a minute on. */
export function formatRuntime(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** Drop leading continuation bytes so the buffer does not start inside a multi-byte character. */
function fromCharacterBoundary(buffer: Buffer): Buffer {
	let start = 0;
	while (start < buffer.length && start < 3 && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start);
}

/** The last lines of the log, marker removed, stripped for the agent (the log stays raw), capped in lines and bytes, and whether the cap cut anything. Never moves the read position. `maxBytes` must stay below the 64 KiB read window. */
export function logTail(task: Task, maxLines = TAIL_LINES, maxBytes = TAIL_BYTES): { text: string; cut: boolean } {
	let buffer: Buffer;
	let size: number;
	try {
		const view = openView(task);
		try {
			size = view.size;
			buffer = view.read(Math.max(0, size - READ_WINDOW), size);
		} finally {
			view.close();
		}
	} catch (error) {
		debugError("log-tail", error, { task: task.id, log: task.logPath });
		return { text: "(log unavailable)", cut: false };
	}
	const lines = sanitize(fromCharacterBoundary(buffer).toString("utf8")).replace(/\n$/, "").split("\n");
	const tail = lines.slice(-maxLines).join("\n");
	const bytes = Buffer.from(tail, "utf8");
	const cut = size > READ_WINDOW || lines.length > maxLines || bytes.length > maxBytes;
	if (bytes.length <= maxBytes) return { text: tail, cut };
	return { text: fromCharacterBoundary(bytes.subarray(bytes.length - maxBytes)).toString("utf8"), cut };
}

/**
 * The one wording of a task's state, for `bash_tasks`, `/bg`, `bash_output` and the
 * completion message: `running`, `exited (code 0)`, `killed (timed out)`, `exit unknown`.
 * `markerCode` is a marker the caller has read that the registry has not yet settled.
 */
export function stateText(task: Task, markerCode?: number): string {
	if (task.state === "killed") return `killed (${task.reason})`;
	if (task.state === "exited") return `exited (code ${task.exitCode})`;
	if (task.state === "running") return markerCode === undefined ? "running" : `exited (code ${markerCode})`;
	return "exit unknown";
}

export type StateData = { state: TaskState; exit_code?: number; reason?: KillReason };
export type TaskData = StateData & {
	task_id: string;
	command: string;
	started_at_ms: number;
	ended_at_ms?: number;
	runtime_ms: number;
};

/** `stateText` as data for structured results: `exit_code` only when exited, `reason` only when killed. */
export function stateData(task: Task, markerCode?: number): StateData {
	if (task.state === "killed") return { state: "killed", reason: task.reason };
	if (task.state === "exited") return { state: "exited", exit_code: task.exitCode };
	if (task.state === "running" && markerCode !== undefined) return { state: "exited", exit_code: markerCode };
	return { state: task.state };
}

/** One task for `bash_tasks` and `bash_kill`, the data `taskLine` prints, with the full command. */
export function taskData(task: Task): TaskData {
	return {
		task_id: task.id,
		command: task.command,
		...stateData(task),
		started_at_ms: task.startedAt,
		...(task.endedAt === undefined ? {} : { ended_at_ms: task.endedAt }),
		runtime_ms: (task.endedAt ?? Date.now()) - task.startedAt,
	};
}

/** How long the task has run, or ran: frozen at its end. */
export function runtimeText(task: Task): string {
	return formatRuntime((task.endedAt ?? Date.now()) - task.startedAt);
}

/** One line per task for `bash_tasks` and `/bg`: `id | state | runtime | command`, the command on one line. */
export function taskLine(task: Task): string {
	return `${task.id} | ${stateText(task)} | ${runtimeText(task)} | ${oneLine(task.command)}`;
}

/** A command on one line (newlines shown as ⏎), cut to 200 characters. */
export function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ⏎ ");
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The line every notice opens with. Both materials of a notice keep it word for
 * word, because delivery's only proof is finding it in the transcript.
 */
export function noticePhrase(id: string): string {
	return `Background task ${id} finished:`;
}

/**
 * Whether the command sends its output through `|`, and so exits with the last
 * stage's code rather than its own: `false` only for a command with no pipe.
 * Quoted text is dropped first, so `grep "a|b"` is not a pipe.
 */
export function pipesOutput(command: string): boolean {
	return /\|/.test(command.replace(/'[^']*'|"[^"]*"/g, "").replace(/\|\|/g, ""));
}

/** A line that reads as a failure, for a notice whose exit code cannot be trusted. */
const ERROR_LINE = /^(?:\[ERROR\]|ERROR\b|COMPILATION ERROR|BUILD FAILURE|npm ERR!|Error:|error:|FAIL(?:ED|URE)?\b|✗)/;

/** The first line of the log that reads as a failure, cut to 200 characters, or `undefined` when none does. */
export function firstErrorLine(tail: string): string | undefined {
	for (const line of tail.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "" && ERROR_LINE.test(trimmed)) return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
	}
	return undefined;
}

/**
 * The completion text: id, command, state, runtime and the output's last lines.
 * A command that pipes its output reports the last stage's exit code, so a
 * `code 0` from a pipeline says nothing about the command: the notice says so,
 * and quotes the first line that reads as a failure.
 */
export function completionText(task: Task): string {
	const { text: tail, cut } = logTail(task);
	const label = cut
		? `Last output, cut to the last ${TAIL_LINES} lines or ${TAIL_BYTES / 1024} KiB; \`bash_output ${task.id}\` reads it all:`
		: "Last output:";
	const piped = pipesOutput(task.command) && task.state === "exited" && task.exitCode === 0;
	const error = piped ? firstErrorLine(tail) : undefined;
	const lines = [
		`${noticePhrase(task.id)} ${stateText(task)}, ran ${runtimeText(task)}.`,
		`Command: ${oneLine(task.command)}`,
	];
	if (piped)
		lines.push(
			"Note: the command pipes its output, so `exited (code 0)` is the last stage's and the command itself may have failed.",
		);
	if (error !== undefined) lines.push(`First error line in the log: ${error}`);
	lines.push(tail === "" ? "(no output)" : `${label}\n${tail}`);
	return lines.join("\n");
}

/** The same notice as one line, for a user message: it starts a turn, so it must stay short. */
export function noticeLine(task: Task): string {
	return `${noticePhrase(task.id)} ${stateText(task)}, ran ${runtimeText(task)}. The full output is in \`bash_output ${task.id}\`.`;
}
