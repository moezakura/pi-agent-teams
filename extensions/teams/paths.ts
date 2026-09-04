import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Root directory for all team artifacts (config, sessions, mailboxes, tasks).
 *
 * Default: `/tmp/{repo}/{uuidv7}`. The leader creates this once per process and
 * exports it so spawned workers inherit the same task root.
 * Override: set `PI_TEAMS_ROOT_DIR` to the leader-selected task root.
 */
function uuidv7(): string {
	const bytes = randomBytes(16);
	let timestamp = BigInt(Date.now());
	for (let i = 5; i >= 0; i -= 1) {
		bytes[i] = Number(timestamp & 0xffn);
		timestamp >>= 8n;
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let generatedRoot: string | undefined;

function isTaskRoot(value: string): boolean {
	return /^\/tmp\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireTaskRoot(value: string, source: string): string {
	const root = value.trim();
	if (!isTaskRoot(root)) {
		throw new Error(`${source} must be an absolute /tmp/{REPO_NAME}/{UUIDv7} path`);
	}
	return root;
}

export function getTeamsRootDir(): string {
	const taskRoot = process.env.TASK_TMP_ROOT?.trim();
	const teamsRoot = process.env.PI_TEAMS_ROOT_DIR?.trim();
	if (taskRoot) {
		const root = requireTaskRoot(taskRoot, "TASK_TMP_ROOT");
		if (teamsRoot && requireTaskRoot(teamsRoot, "PI_TEAMS_ROOT_DIR") !== root) {
			throw new Error("TASK_TMP_ROOT and PI_TEAMS_ROOT_DIR must match");
		}
		process.env.PI_TEAMS_ROOT_DIR = root;
		return root;
	}
	if (teamsRoot) {
		const root = requireTaskRoot(teamsRoot, "PI_TEAMS_ROOT_DIR");
		process.env.TASK_TMP_ROOT = root;
		return root;
	}
	if (process.env.PI_TEAMS_WORKER === "1") {
		throw new Error("PI_TEAMS_ROOT_DIR is required for workers; the leader must provide TASK_TMP_ROOT");
	}
	if (!generatedRoot) {
		const repoName = path.basename(process.cwd()) || "repo";
		generatedRoot = requireTaskRoot(path.join("/tmp", repoName, uuidv7()), "generated task root");
		process.env.PI_TEAMS_ROOT_DIR = generatedRoot;
		process.env.TASK_TMP_ROOT = generatedRoot;
	}
	return generatedRoot;
}

export function getTeamDir(teamId: string): string {
	return path.join(getTeamsRootDir(), teamId);
}

/** Directory for custom team UI styles (terminology + name rules). */
export function getTeamsStylesDir(): string {
	return path.join(getTeamsRootDir(), "_styles");
}

/** Directory for hook scripts and hook configuration (quality gates). */
export function getTeamsHooksDir(): string {
	const override = process.env.PI_TEAMS_HOOKS_DIR;
	if (override && override.trim()) {
		const p = override.trim();
		return path.isAbsolute(p) ? p : path.join(getTeamsRootDir(), p);
	}
	return path.join(getTeamsRootDir(), "_hooks");
}
