// The configured default promotion threshold (`config.ts`): the built-in 30 s,
// the `PI_BG_BASH_PROMOTE_MS` environment variable, and `promoteMs` in the
// user's and the project's `.pi/pi-bg-bash.json`, in that order. Each case runs
// in a subprocess: `config.ts` fixes both file paths and caches the resolved
// files at first use, so only a fresh process sees a fresh home or project.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { promisify } from "node:util";

const run = promisify(execFile);
const configTs = fileURLToPath(new URL("../src/config.ts", import.meta.url));

/** A fresh home with `.pi/`, a fresh project directory, and nothing else. */
function home() {
	const root = mkdtempSync(join(tmpdir(), "pi-bg-config-"));
	mkdirSync(join(root, "home", ".pi"), { recursive: true });
	mkdirSync(join(root, "project", ".pi"), { recursive: true });
	return root;
}

/** Run `defaultPromoteMs()` in a subprocess with this home, project and environment. */
async function read(root: string, env: Record<string, string | undefined> = {}): Promise<number> {
	const { stdout } = await run(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { defaultPromoteMs } from ${JSON.stringify(new URL(`file://${configTs}`).href)};` +
				`process.stdout.write(String(defaultPromoteMs()));`,
		],
		{
			cwd: join(root, "project"),
			env: {
				...process.env,
				HOME: join(root, "home"),
				PI_BG_BASH_PROMOTE_MS: undefined,
				...env,
			},
		},
	);
	return Number(stdout);
}

const write = (root: string, where: "home" | "project", json: string) =>
	writeFileSync(join(root, where, ".pi", "pi-bg-bash.json"), json);

test("the built-in default is 30 s", async () => {
	const root = home();
	try {
		assert.equal(await read(root), 30_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the environment variable wins over everything", async () => {
	const root = home();
	try {
		write(root, "home", JSON.stringify({ promoteMs: 50_000 }));
		write(root, "project", JSON.stringify({ promoteMs: 70_000 }));
		assert.equal(await read(root, { PI_BG_BASH_PROMOTE_MS: "1500" }), 1500);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a config file beats the built-in default", async () => {
	const root = home();
	try {
		write(root, "home", JSON.stringify({ promoteMs: 50_000 }));
		assert.equal(await read(root), 50_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the project file beats the user file", async () => {
	const root = home();
	try {
		write(root, "home", JSON.stringify({ promoteMs: 50_000 }));
		write(root, "project", JSON.stringify({ promoteMs: 70_000 }));
		assert.equal(await read(root), 70_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a broken or nonsensical config file is ignored, not fatal", async () => {
	const root = home();
	try {
		write(root, "home", "{ not json");
		write(root, "project", JSON.stringify({ promoteMs: "later" }));
		assert.equal(await read(root), 30_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
