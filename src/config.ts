// The user-tunable promotion threshold: how long a foreground command without a
// declared expectation may run before it moves to the background. Precedence:
// the `PI_BG_BASH_PROMOTE_MS` environment variable (the contract test's hook and
// a per-invocation override), then `promoteMs` in the project's
// `.pi/pi-bg-bash.json`, then in the user's `~/.pi/pi-bg-bash.json`, then the
// built-in default. Read once per load; `/reload` re-reads.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The threshold without any configuration: 30 seconds. */
export const DEFAULT_PROMOTE_MS = 30_000;

/** User and project config, in precedence order: the project's wins. */
const CONFIG_FILES = [join(process.cwd(), ".pi", "pi-bg-bash.json"), join(homedir(), ".pi", "pi-bg-bash.json")];

/** The `promoteMs` of one config file, or undefined when it has none. A broken or mis-typed file is ignored, not an error. */
function fileMs(path: string): number | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { promoteMs?: unknown };
		const ms = Number(parsed?.promoteMs);
		return Number.isFinite(ms) && ms > 0 ? ms : undefined;
	} catch {
		return undefined;
	}
}

/** The `guaranteedWake` of one config file, or undefined when it has none: only a boolean counts. */
function fileWake(path: string): boolean | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { guaranteedWake?: unknown };
		return typeof parsed?.guaranteedWake === "boolean" ? parsed.guaranteedWake : undefined;
	} catch {
		return undefined;
	}
}

let cachedWake: boolean | undefined;

/**
 * Whether a notice that did not land may be sent as a user message, the one
 * channel that always starts a turn. On unless a config file says otherwise:
 * `PI_BG_BASH_GUARANTEED_WAKE=0` wins over the files, which beat the default.
 */
export function guaranteedWake(): boolean {
	const env = process.env.PI_BG_BASH_GUARANTEED_WAKE;
	if (env === "0") return false;
	if (env === "1") return true;
	if (cachedWake === undefined) cachedWake = CONFIG_FILES.map(fileWake).find((wake) => wake !== undefined) ?? true;
	return cachedWake;
}

let cachedFiles: number | undefined;

/** The configured default threshold in milliseconds; the env var wins (read every call, the contract test sets it after load), then project, then user, then the built-in default. */
export function defaultPromoteMs(): number {
	const env = Number(process.env.PI_BG_BASH_PROMOTE_MS);
	if (Number.isFinite(env) && env > 0) return env;
	if (cachedFiles === undefined)
		cachedFiles = CONFIG_FILES.map(fileMs).find((ms) => ms !== undefined) ?? DEFAULT_PROMOTE_MS;
	return cachedFiles;
}
