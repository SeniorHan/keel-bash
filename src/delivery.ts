// Reliable delivery of a task's completion notice.
//
// Pi's `sendMessage` cannot fail loudly: the extension API wraps
// `session.sendCustomMessage` in `.catch(emitError)`, so a wake that pi drops —
// a steer queued as the run ends, a settle-window deferral, a `_startRun` that
// throws — leaves no trace in the caller and no trace in the session. A notice
// that must arrive therefore cannot trust the send: it is written under
// `pending/` first, sent, and kept until the transcript shows it. What the
// session holds is the only proof there is; a notice that has not landed is not
// reported as delivered, and nothing downstream is told otherwise.
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { guaranteedWake } from "./config.ts";
import { debug, debugError, taskFields } from "./debug.ts";
import { gzipLog } from "./logs.ts";
import { completionText, MESSAGE_TYPE, noticeLine, noticePhrase } from "./notify.ts";
import { processPort } from "./port.ts";
import type { Registry, Task } from "./registry.ts";

/** Where a session keeps the notices it has not yet seen land. */
const PENDING_DIR = "pending";
/** How long a sent notice has to appear in the transcript before the next step. */
const GRACE_MS = 2000;
/** Waits between user-channel attempts, the last one repeated. */
const USER_BACKOFF_MS = [8000, 30_000, 60_000, 120_000];
/** How much of the session file's end is searched for a notice. */
const TAIL_BYTES = 256 * 1024;
/** How many of the session's last entries are searched in memory. */
const RECENT_ENTRIES = 40;

/**
 * A task's end, as far as delivery is concerned: the two texts, where the record
 * is, and how far the attempts have got. The texts are composed once, so every
 * channel carries the same words and the same first line.
 */
export type Notice = {
	id: string;
	/** The whole notice, for a custom message. */
	text: string;
	/** The notice as one line, for a user message, which starts a turn. */
	line: string;
	/** The record under `pending/`, removed only once the transcript holds it. */
	file: string;
	attempts: number;
	/** Set once the custom channel was accepted and still never landed: from then on only the user channel is used. */
	escalated: boolean;
	/** Whether the last send threw, which means pi was not ready rather than the message being dropped. */
	lastThrew: boolean;
	/** When the next attempt is due. */
	nextAt: number;
};

/** The directory a session's pending notices live in. */
export function pendingDir(sessionDir: string): string {
	return join(sessionDir, PENDING_DIR);
}

/** Report a task's end: compose the notice, write it down, and take the first delivery step. Never throws. */
export function reportEnd(registry: Registry, task: Task): void {
	if (task.reported || registry.notices.has(task.id)) return;
	const sessionDir = dirname(task.logPath);
	const file = join(pendingDir(sessionDir), `${task.id}.json`);
	const notice: Notice = {
		id: task.id,
		text: completionText(task),
		line: noticeLine(task),
		file,
		attempts: 0,
		escalated: false,
		lastThrew: false,
		nextAt: Date.now(),
	};
	task.reported = true;
	registry.notices.set(task.id, notice);
	persist(notice);
	debug("notice", { ...taskFields(task), file });
	scheduleDelivery(registry);
}

/**
 * Deliver once the current call has finished registering its notices: tasks that
 * end in the same poll share one message and one wake, while a kill still reports
 * before the call that killed it returns. A send from the previous pass is inside
 * its grace window, so a second pass sends nothing.
 */
function scheduleDelivery(registry: Registry): void {
	queueMicrotask(() => {
		try {
			deliverNotices(registry);
		} catch (error) {
			debugError("notice-deliver", error);
		}
	});
}

/** Forget a notice that must never be sent (the agent asked for the kill, or the session ended). */
export function suppressNotice(registry: Registry, id: string): void {
	const notice = registry.notices.get(id);
	if (notice === undefined) return;
	registry.notices.delete(id);
	drop(notice);
}

/** Forget every notice: the session that owned them is over. */
export function clearNotices(registry: Registry): void {
	for (const notice of registry.notices.values()) drop(notice);
	registry.notices.clear();
}

/**
 * Deliver whatever is due: first confirm what the transcript already holds, then
 * send. Custom notices that come due together share one message, since one wake
 * is enough for all of them; user-channel notices share one line, which also
 * starts a turn.
 */
export function deliverNotices(registry: Registry): void {
	if (registry.notices.size === 0) return;
	// A notice still pending is work for the poller, whatever created it.
	registry.ensurePolling?.();
	const ctx = registry.ctx;
	const pi = registry.pi;
	const now = Date.now();
	const toCustom: Notice[] = [];
	const toUser: Notice[] = [];
	for (const notice of registry.notices.values()) {
		if (delivered(ctx, notice.id)) {
			commit(registry, notice);
			continue;
		}
		if (now < notice.nextAt) continue;
		// A custom message pi accepted but the transcript never saw was dropped on
		// the way in (a steer queued as the turn ended, a settle-window deferral, a
		// run that would not start). Only the user channel is guaranteed to start a turn.
		if (!notice.escalated && notice.attempts > 0 && !notice.lastThrew && guaranteedWake()) notice.escalated = true;
		(notice.escalated ? toUser : toCustom).push(notice);
	}
	if (pi === undefined || ctx === undefined) return;
	if (toCustom.length > 0) sendCustom(pi, toCustom);
	if (toUser.length > 0) sendUser(pi, toUser);
}

/**
 * Report the notices a previous run of this session left behind: nothing has
 * woken the agent for them, so they go out on the user channel, which always
 * starts a turn. A record that cannot be read is dropped rather than kept.
 */
export function replayNotices(registry: Registry, sessionDir: string): void {
	let names: string[];
	try {
		names = readdirSync(pendingDir(sessionDir)).filter((name) => name.endsWith(".json"));
	} catch {
		return; // no pending directory: nothing was left behind
	}
	for (const name of names) {
		const file = join(pendingDir(sessionDir), name);
		const record = read(file);
		if (record === undefined) {
			try {
				rmSync(file, { force: true });
			} catch (error) {
				debugError("notice-replay-drop", error, { file });
			}
			continue;
		}
		if (registry.notices.has(record.id)) continue;
		registry.notices.set(record.id, { ...record, attempts: 1, escalated: true, lastThrew: false, nextAt: Date.now() });
		debug("notice-replay", { id: record.id, file });
	}
	deliverNotices(registry);
}

/**
 * Whether the transcript holds this notice. Its first line is the phrase, and
 * only a notice carries it, so one string answers for both channels. The
 * session's entries are checked first (a message that landed is there at once),
 * then the file's tail, for a session whose entries are not in memory.
 */
export function delivered(ctx: ExtensionContext | undefined, id: string): boolean {
	const phrase = noticePhrase(id);
	const manager = ctx?.sessionManager;
	try {
		const entries = manager?.getEntries();
		if (entries !== undefined) {
			for (const entry of entries.slice(-RECENT_ENTRIES)) if (JSON.stringify(entry).includes(phrase)) return true;
		}
	} catch (error) {
		debugError("notice-entries", error, { id });
	}
	const file = manager?.getSessionFile();
	if (file === undefined || !existsSync(file)) return false;
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buffer, 0, buffer.length, start);
		} finally {
			closeSync(fd);
		}
		return buffer.toString("utf8").includes(phrase);
	} catch (error) {
		debugError("notice-transcript", error, { id, file });
		return false;
	}
}

/** The notice is in the transcript: forget the record, and only now gzip the log (Q21). */
function commit(registry: Registry, notice: Notice): void {
	registry.notices.delete(notice.id);
	drop(notice);
	debug("notice-delivered", { id: notice.id, attempts: notice.attempts, escalated: notice.escalated });
	const task = registry.tasks.get(notice.id);
	// A group that is still alive (a `stuck` group, or a child the command left) may
	// still write to the log, so leave it plain; the 7-day cleanup handles it.
	if (task !== undefined && !processPort().groupAlive(task.pid))
		void gzipLog(task).catch((error) => debugError("gzip", error, taskFields(task)));
}

/** One message carrying every custom notice due now. */
function sendCustom(pi: ExtensionAPI, notices: Notice[]): void {
	const details = notices.length === 1 ? { id: notices[0].id } : { ids: notices.map((notice) => notice.id) };
	let threw = false;
	try {
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: notices.map((notice) => notice.text).join("\n\n"),
				display: true,
				details,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	} catch (error) {
		threw = true;
		debugError("notice-send", error, { ids: notices.map((notice) => notice.id) });
	}
	for (const notice of notices) {
		notice.attempts++;
		notice.lastThrew = threw;
		notice.nextAt = Date.now() + GRACE_MS;
	}
}

/** One user message carrying every escalated notice due now: it always starts a turn. */
function sendUser(pi: ExtensionAPI, notices: Notice[]): void {
	let threw = false;
	try {
		pi.sendUserMessage(notices.map((notice) => notice.line).join(" "));
	} catch (error) {
		threw = true;
		debugError("notice-wake", error, { ids: notices.map((notice) => notice.id) });
	}
	for (const notice of notices) {
		notice.attempts++;
		notice.lastThrew = threw;
		const wait = USER_BACKOFF_MS[Math.min(notice.attempts - 2, USER_BACKOFF_MS.length - 1)];
		notice.nextAt = Date.now() + (threw ? GRACE_MS : wait);
	}
}

/** Write the record before the send, so a crash between them loses nothing. */
function persist(notice: Notice): void {
	try {
		mkdirSync(dirname(notice.file), { recursive: true, mode: 0o700 });
		const tmp = `${notice.file}.${process.pid}.tmp`;
		writeFileSync(
			tmp,
			JSON.stringify({ id: notice.id, text: notice.text, line: notice.line, attempts: notice.attempts }),
			{ mode: 0o600 },
		);
		renameSync(tmp, notice.file);
	} catch (error) {
		debugError("notice-persist", error, { id: notice.id });
	}
}

function drop(notice: Notice): void {
	try {
		rmSync(notice.file, { force: true });
	} catch (error) {
		debugError("notice-drop", error, { id: notice.id });
		return;
	}
	// The session's directory stays as it was when the last record goes: `pending/`
	// holds nothing an ended session has no record of.
	try {
		rmdirSync(dirname(notice.file));
	} catch {
		// not empty: other notices are still pending
	}
}

/** A record read back from `pending/`, or `undefined` when it is not one. */
function read(file: string): { id: string; text: string; line: string; file: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; text?: unknown; line?: unknown };
		if (typeof parsed.id !== "string" || typeof parsed.text !== "string" || typeof parsed.line !== "string")
			return undefined;
		return { id: parsed.id, text: parsed.text, line: parsed.line, file };
	} catch (error) {
		debugError("notice-read", error, { file });
		return undefined;
	}
}
