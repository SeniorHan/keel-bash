// `pi-bg-bash`: the model's `bash` tool with a `background: true` flag.
//
// A background call starts the command detached, logs it under
// `$XDG_STATE_HOME/pi-bg/<session-id>/`, and returns a task id at once. When
// the command exits the agent gets one completion message, which starts a turn
// if the agent is idle. The footer shows `bg: N` while N tasks run. A call
// without `background` is Pi's own `bash` over the same wrapper (`foreground.ts`),
// and moves to the background when it outlasts the call's declared
// `expectedSeconds`, or the default 30 s with none.
import { createBashToolDefinition, type ExtensionAPI, type InputEventResult } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { bgCommand } from "./bg.ts";
import { defaultPromoteMs } from "./config.ts";
import { rotateDebugLog } from "./debug.ts";
import { COMPLETION_TEXT, foregroundRuns, runForeground } from "./foreground.ts";
import { GRACE_MS } from "./kill.ts";
import { cleanupOldLogs } from "./logs.ts";
import { stateText, taskData, taskLine } from "./notify.ts";
import { readOutput } from "./output.ts";
import { attach, endSession, getRegistry, killTask, setContext, startTask } from "./registry.ts";
import { withTaskTimer } from "./render.ts";

// Telegraphic Chinese per the naming spec's language policy: draft EN and ZH, keep the shorter.
const EXPECTED_DESCRIPTION =
	"长任务(构建/部署/服务)设 `background: true`:立即返回 task_id,完成即通知并开新回合,勿 sleep 或轮询 bash_output 等待。" +
	"等外部事件(如 CI):后台跑阻塞命令(如 `gh run watch <run-id> --exit-status`),勿 sleep N 后自查。" +
	"前台必填 expectedSeconds,后台忽略。" +
	`无 timeout 前台命令超 expectedSeconds(无预期则 ${defaultPromoteMs() / 1000} s,sleep 开头除外)自动转后台。` +
	"timeout 是硬杀线:到点杀进程,勿仅为记录预期而设;仅 expectedSeconds 更早才提前转后台,task 保留该 deadline。" +
	"waitFor 命中即返回已有输出,命令转后台续跑,timeout 转而限制 task。";

// No guard for a Pi without `outputSchema`, unlike bash's: these schemas stand alone,
// and such a Pi ignores the unknown fields.
const STATE_FIELDS = {
	task_id: Type.String(),
	state: Type.Union([
		Type.Literal("running"),
		Type.Literal("exited"),
		Type.Literal("killed"),
		Type.Literal("exit-unknown"),
	]),
	exit_code: Type.Optional(Type.Number({ description: "Set when state is exited" })),
	reason: Type.Optional(
		Type.Union(
			[
				Type.Literal("killed by agent"),
				Type.Literal("killed by user"),
				Type.Literal("timed out"),
				Type.Literal("log limit passed"),
			],
			{ description: "Set when state is killed" },
		),
	),
};
const TASK_FIELDS = {
	...STATE_FIELDS,
	command: Type.String(),
	started_at_ms: Type.Number({ description: "Epoch milliseconds" }),
	ended_at_ms: Type.Optional(Type.Number({ description: "Epoch milliseconds; absent while running" })),
	runtime_ms: Type.Number(),
};

export default function (pi: ExtensionAPI): void {
	attach(pi);
	// The user can move the running foreground command to the background at once.
	pi.registerShortcut("ctrl+shift+b", {
		description: "Move the running foreground command to the background",
		handler: (ctx) => {
			setContext(ctx);
			// One press promotes every foreground call in flight: with parallel tool
			// calls the turn stays blocked until all finish, so several can be running
			// at once.
			for (const run of foregroundRuns()) run.promote("shortcut");
		},
	});
	// A message queued while a foreground call runs promotes every call in flight at
	// once: the turn must free up so the model can answer the user. Only eavesdrop —
	// "continue" keeps the queueing pipeline untouched; the promoted call's result
	// explains the move. Deliberate waits (`followUp`) do not promote.
	pi.on("input", (event): InputEventResult => {
		if (event.streamingBehavior !== "steer") return { action: "continue" };
		for (const run of foregroundRuns()) run.promote("userInput");
		return { action: "continue" };
	});
	const builtin = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} ${EXPECTED_DESCRIPTION}`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			expectedSeconds: Type.Optional(Type.Number({ description: "预计耗时,秒;0=无预期" })),
			waitFor: Type.Optional(Type.String({ description: '输出中等待出现的文本,如 "listening on"' })),
			background: Type.Optional(Type.Boolean({ description: "分离后台运行命令,返回 task_id" })),
		}),
		// A Pi whose bash has no output schema returns no structured result to extend.
		outputSchema:
			builtin.outputSchema &&
			Type.Object({
				...(builtin.outputSchema as TObject).properties,
				exit_code: Type.Optional(Type.Number({ description: "Absent while the command runs on as task_id" })),
				task_id: Type.Optional(
					Type.String({
						description: "Set when the command runs on as a background task; pass it to bash_output or bash_kill",
					}),
				),
			}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		renderResult: builtin.renderResult && withTaskTimer(builtin.renderResult),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			setContext(ctx);
			if (params.waitFor !== undefined && params.background)
				throw new Error("waitFor applies to foreground calls: drop `background: true`, or drop `waitFor`.");
			// Required from the model on foreground calls even though the schema marks it optional: the
			// built-in's `prepareArguments` does not know this field, so a required entry here breaks its type.
			if (!params.background && typeof params.expectedSeconds !== "number")
				throw new Error(
					"expectedSeconds is required: your estimate of how long the command will take, in seconds, or 0 when you have no estimate.",
				);
			if (!params.background) return runForeground(toolCallId, params, signal, onUpdate, ctx);
			const startedAt = Date.now();
			const task = await startTask(params.command, ctx, { timeout: params.timeout });
			task.toolCallId = toolCallId;
			return {
				structuredContent: {
					output: "",
					truncated: false,
					wall_time_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
					task_id: task.id,
				},
				content: [
					{
						type: "text",
						text: `Started background task ${task.id}. ${COMPLETION_TEXT}`,
					},
				],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "bash_output",
		label: "bash_output",
		description:
			"从上次停点起读取后台任务输出,上限同 `bash`。每次调用只返回尚未读取的输出,并注明剩余量;结果同时说明任务在运行或已结束。" +
			"勿为等待任务结束而反复调用:完成会自动送达。",
		parameters: Type.Object({
			id: Type.String({ description: "后台调用返回的 task_id" }),
			latest: Type.Optional(Type.Boolean({ description: "跳至日志末尾取最新输出" })),
			filter: Type.Optional(Type.String({ description: "正则;仅返回已读输出的匹配行" })),
		}),
		outputSchema: Type.Object({
			...STATE_FIELDS,
			output: Type.String({ description: "The unread output this call returned, after `filter`" }),
			truncated: Type.Boolean({ description: "More output remains unread, or `latest` skipped some" }),
			unread_bytes: Type.Number({
				description: "Log bytes not yet read; the task is done when state is not running and this is 0",
			}),
		}),
		// Not read-only: each call moves the task's read position.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. bash_tasks lists this session's tasks.`);
			const read = readOutput(task, params);
			return { structuredContent: read.data, content: [{ type: "text", text: read.text }], details: undefined };
		},
	});
	pi.registerTool({
		name: "bash_tasks",
		label: "bash_tasks",
		description: "列出本会话的全部后台任务,含已结束的。",
		parameters: Type.Object({}),
		outputSchema: Type.Object({ tasks: Type.Array(Type.Object(TASK_FIELDS)) }),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute() {
			const tasks = [...getRegistry().tasks.values()];
			const text = tasks.length === 0 ? "No background tasks." : tasks.map(taskLine).join("\n");
			return {
				structuredContent: { tasks: tasks.map(taskData) },
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "bash_kill",
		label: "bash_kill",
		description: `杀后台任务及其子进程:进程组先 SIGTERM,约 ${GRACE_MS / 1000} s 后残留则 SIGKILL。无完成消息,结果报最终状态。`,
		parameters: Type.Object({
			id: Type.String({ description: "后台调用返回的 task_id" }),
		}),
		outputSchema: Type.Object({
			...TASK_FIELDS,
			outcome: Type.Union(
				[
					Type.Literal("killed"),
					Type.Literal("finished"),
					Type.Literal("gone"),
					Type.Literal("cleared"),
					Type.Literal("stuck"),
					Type.Literal("leftover-stuck"),
				],
				{
					description:
						"killed: stopped now; finished: had already ended; gone: had already ended, exit unknown; " +
						"cleared: had ended, its leftover processes stopped; stuck or leftover-stuck: survived SIGKILL",
				},
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. bash_tasks lists this session's tasks.`);
			const outcome = await killTask(task, "killed by agent", { notify: false });
			const text =
				outcome === "finished"
					? `Task ${task.id} has already finished: ${stateText(task)}.`
					: outcome === "gone"
						? `Task ${task.id} had already ended: exit unknown.`
						: outcome === "cleared"
							? `Task ${task.id} had already finished: ${stateText(task)}; stopped the processes it left running.`
							: outcome === "leftover-stuck"
								? `Task ${task.id} had already finished: ${stateText(task)}; the processes it left running survived SIGKILL and are still running.`
								: outcome === "stuck"
									? `Task ${task.id} was sent SIGKILL, but its process group is still running.`
									: `Task ${task.id} killed; its process group is gone.`;
			return {
				structuredContent: { ...taskData(task), outcome },
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	});
	pi.registerCommand("bg", {
		description: "List background bash tasks: enter shows a task's output, x kills it",
		handler: async (_args, ctx) => {
			setContext(ctx);
			await bgCommand(ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		setContext(ctx);
		rotateDebugLog();
		cleanupOldLogs(getRegistry().tasks.values());
	});
	// Tasks belong to the session: a reload keeps them (the new load takes them over), every other end kills them.
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "reload") await endSession();
	});
}
