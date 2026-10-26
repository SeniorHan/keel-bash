// Behaviour tier: reliable delivery of the completion notice — the pending
// record, the channel ladder, the transcript as the only proof — over the fake
// process table and fake time.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getRegistry } from "../src/registry.ts";
import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	gzipped,
	resetRegistry,
	restoreProcesses,
	session,
	start,
	text,
} from "./harness.ts";

let clock: ReturnType<typeof fakeClock>;
let procs: FakeProcesses;
beforeEach(() => {
	procs = fakeProcesses();
	clock = fakeClock();
});
afterEach(() => {
	clock.restore();
	resetRegistry();
	restoreProcesses();
	delete process.env.PI_BG_BASH_GUARANTEED_WAKE;
});
after(cleanup);

const pendingFiles = (dir: string) => {
	const pending = join(dir, "pending");
	return existsSync(pending) ? readdirSync(pending) : [];
};

describe("a notice that lands at once", () => {
	it("is sent on the custom channel, kept on disk until the transcript holds it, and only then gzipped", async () => {
		const s = session();
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sentUser.length, 0);
		// The record is written before the send, and the send leaves the transcript behind.
		assert.equal(s.entries.length > 0, true);
		await clock.until(() => gzipped(s, id));
		assert.deepEqual(pendingFiles(s.logDir()), []);
		assert.equal(existsSync(join(s.logDir(), "pending")), false);
	});

	it("does not gzip a log while its notice is still pending", async () => {
		const s = session();
		s.faults.dropCustom = true;
		s.faults.dropUser = true;
		const id = await start(s, "echo done");
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		await clock.tick(3);
		assert.equal(existsSync(join(s.logDir(), `${id}.log`)), true);
		assert.equal(gzipped(s, id), false);
		assert.deepEqual(pendingFiles(s.logDir()), [`${id}.json`]);
	});
});

describe("a notice pi drops silently", () => {
	it("escalates to a user message, which always starts a turn, and commits once that lands", async () => {
		const s = session();
		s.faults.dropCustom = true; // accepted, dropped: the bug this exists for
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.sentUser.length > 0);
		assert.equal(s.sent.length, 0);
		assert.match(s.sentUser[0].content, new RegExp(`^Background task ${id} finished: exited \\(code 0\\)`));
		assert.match(s.sentUser[0].content, new RegExp(`bash_output ${id}`));
		await clock.until(() => gzipped(s, id));
		assert.deepEqual(pendingFiles(s.logDir()), []);
	});

	it("keeps retrying on the user channel when every send is dropped, and commits when one finally lands", async () => {
		const s = session();
		s.faults.dropCustom = true;
		s.faults.dropUser = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.userAttempts >= 2);
		assert.deepEqual(pendingFiles(s.logDir()), [`${id}.json`]);
		s.faults.dropUser = false;
		await clock.until(() => gzipped(s, id));
		assert.deepEqual(pendingFiles(s.logDir()), []);
	});

	it("never escalates while the custom send throws: a pi that is not ready is not a dropped message", async () => {
		const s = session();
		s.faults.failSend = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 3);
		assert.equal(s.faults.userAttempts, 0);
		s.faults.failSend = false;
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sentUser.length, 0);
	});
});

describe("notices left behind", () => {
	it("are reported on the next session start, from the record on disk", async () => {
		const first = session();
		first.faults.dropCustom = true;
		first.faults.dropUser = true;
		const id = await start(first, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => first.faults.userAttempts >= 1);
		await clock.until(() => pendingFiles(first.logDir()).length === 1);
		resetRegistry(); // a new Pi process: the tasks are gone, the records are not
		const second = session({ id: first.id });
		second.faults.dropCustom = true; // and it goes out on the user channel, which starts a turn
		await clock.settle(second.sessionStart());
		assert.equal(second.sentUser.length, 1);
		assert.match(second.sentUser[0].content, new RegExp(`^Background task ${id} finished:`));
		await clock.until(() => pendingFiles(second.logDir()).length === 0);
	});

	it("are dropped with the session that owns them, so nothing leaks into the next one", async () => {
		const s = session();
		s.faults.dropCustom = true;
		s.faults.dropUser = true;
		const id = await start(s, "long job");
		procs.of(id).exit(0);
		await clock.until(() => pendingFiles(s.logDir()).length === 1);
		await clock.settle(s.shutdown("new"));
		assert.deepEqual(pendingFiles(s.logDir()), []);
		const fresh = session({ id: s.id });
		await clock.settle(fresh.sessionStart());
		await clock.tick(2);
		assert.equal(fresh.sent.length + fresh.sentUser.length, 0);
	});
});

describe("notices that end together", () => {
	it("share one custom message, one wake for both", async () => {
		const s = session();
		const first = await start(s, "echo one");
		const second = await start(s, "echo two");
		procs.of(first).exit(0);
		procs.of(second).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, new RegExp(`Background task ${first} finished:`));
		assert.match(s.sent[0].message.content, new RegExp(`Background task ${second} finished:`));
		await clock.until(() => gzipped(s, first));
		await clock.until(() => gzipped(s, second));
	});
});

describe("what the agent sees", () => {
	it("never mentions an undelivered notice: a pending one is not a state of the task", async () => {
		const s = session();
		s.faults.dropCustom = true;
		s.faults.dropUser = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.userAttempts >= 2);
		const tasks = text(await s.toolCall("bash_tasks", {}));
		assert.match(tasks, new RegExp(`^${id} \\| exited \\(code 0\\)`));
		assert.doesNotMatch(tasks, /pending|undelivered|notice|未送达/i);
		assert.match(text(await s.toolCall("bash_output", { id })), /exited \(code 0\)/);
	});
});

describe("a piped command", () => {
	it("says its exit code is the last stage's and quotes the first line that reads as a failure", async () => {
		const s = session();
		const id = await start(s, "mvn test 2>&1 | tail -30");
		procs.of(id).write("[INFO] Scanning for projects\n[ERROR] COMPILATION ERROR :\n[INFO] BUILD FAILURE\n");
		procs.of(id).exit(0); // `tail` succeeded: the pipeline hides the command's own code
		await clock.until(() => s.sent.length > 0);
		const message = s.sent[0].message.content;
		assert.match(message, /exited \(code 0\)/);
		assert.match(message, /exited \(code 0\)` is the last stage's/);
		assert.match(message, /First error line in the log: \[ERROR\] COMPILATION ERROR :/);
	});

	it("says nothing of the kind for a command without a pipe", async () => {
		const s = session();
		const id = await start(s, "mvn test");
		procs.of(id).write("[ERROR] COMPILATION ERROR :\n");
		procs.of(id).exit(1);
		await clock.until(() => s.sent.length > 0);
		const message = s.sent[0].message.content;
		assert.doesNotMatch(message, /last stage|First error line/);
	});

	it("is not fooled by a pipe inside quotes", async () => {
		const s = session();
		const id = await start(s, `grep "a|b" file`);
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.doesNotMatch(s.sent[0].message.content, /last stage/);
	});
});

describe("the report", () => {
	it("carries the notice texts as it wrote them, for a restart that only has the record", async () => {
		const s = session();
		s.faults.dropCustom = true;
		s.faults.dropUser = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => pendingFiles(s.logDir()).length === 1);
		const record = JSON.parse(readFileSync(join(s.logDir(), "pending", `${id}.json`), "utf8")) as {
			id: string;
			text: string;
			line: string;
		};
		assert.equal(record.id, id);
		assert.match(record.text, /^Background task bg-\d+ finished: exited \(code 0\)/);
		assert.match(record.line, /^Background task bg-\d+ finished: /);
	});
	it("keeps one record per task while two are pending", async () => {
		const s = session();
		s.faults.dropCustom = true;
		s.faults.dropUser = true;
		const first = await start(s, "echo one");
		const second = await start(s, "echo two");
		procs.of(first).exit(0);
		procs.of(second).exit(0);
		await clock.until(() => s.faults.userAttempts >= 1);
		assert.deepEqual(pendingFiles(s.logDir()).sort(), [`${first}.json`, `${second}.json`].sort());
		assert.equal(getRegistry().notices.size, 2);
	});
});
