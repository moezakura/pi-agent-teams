/** Deterministic CLI lifecycle regression: real handlers/storage, mocked RPC stop and UI. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleTeamDoneCommand, handleTeamShutdownCommand } from "../extensions/teams/leader-lifecycle-commands.js";
import { getInboxPath } from "../extensions/teams/mailbox.js";
import { getTeamDir, getTeamsRootDir } from "../extensions/teams/paths.js";
import { TEAM_MAILBOX_NS } from "../extensions/teams/protocol.js";
import { createTask, listTasks, updateTask, type TeamTask } from "../extensions/teams/task-store.js";
import type { TeamConfig } from "../extensions/teams/team-config.js";
import type { TeammateRpc } from "../extensions/teams/teammate-rpc.js";

const root = getTeamsRootDir();
const fixtureParent = path.join(root, "cli-fixtures");
await fs.mkdir(fixtureParent, { recursive: true });
const fixtureRoot = await fs.mkdtemp(path.join(fixtureParent, "run-"));
console.log(`CLI lifecycle fixture: ${fixtureRoot}`);

async function fixture(label: string, busy = false, stopFails = false) {
	const teamId = path.relative(root, path.join(fixtureRoot, label));
	const teamDir = getTeamDir(teamId);
	await fs.mkdir(teamDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const cfg: TeamConfig = {
		version: 1, teamId, taskListId: "tasks", leadName: "leader", createdAt: timestamp, updatedAt: timestamp,
		members: ["rpc1", "rpc2", "manual", "busy"].map((name) => ({ name, role: "worker", status: "online", addedAt: timestamp })),
	};
	await fs.writeFile(path.join(teamDir, "config.json"), JSON.stringify(cfg));
	if (busy) {
		const task = await createTask(teamDir, "tasks", { subject: "working", description: "fixture", owner: "busy" });
		await updateTask(teamDir, "tasks", task.id, (current) => ({ ...current, status: "in_progress" }));
	}
	let tasks: TeamTask[] = [];
	const refreshTasks = async () => { tasks = await listTasks(teamDir, "tasks"); };
	const teammates = new Map<string, TeammateRpc>(["rpc1", "rpc2"].map((name) => [name, {} as TeammateRpc]));
	const notices: string[] = [];
	const state = { stopped: 0, hidden: 0, rendered: 0 };
	const ctx = { cwd: teamDir, ui: { notify: (message: string) => notices.push(message), confirm: async () => true } } as unknown as ExtensionCommandContext;
	const common = {
		ctx, teamId, teammates, getTeamConfig: () => cfg, leadName: "leader", style: "normal",
		refreshTasks, getTasks: () => tasks,
		stopAllTeammates: async () => {
			state.stopped++;
			teammates.delete("rpc1");
			if (stopFails) throw new Error("second RPC stop failed");
			teammates.clear(); // Cached online config intentionally remains stale.
		},
	};
	const done = (rest: string[] = []) => handleTeamDoneCommand({ ...common, rest, hideWidget: () => { state.hidden++; } });
	const shutdown = () => handleTeamShutdownCommand({
		...common, rest: [], getCurrentCtx: () => ctx, getActiveTeamId: () => teamId,
		renderWidget: () => { state.rendered++; },
	});
	const inbox = async (name: string): Promise<unknown[]> => {
		try { return JSON.parse(await fs.readFile(getInboxPath(teamDir, TEAM_MAILBOX_NS, name), "utf8")) as unknown[]; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	};
	return { done, shutdown, inbox, state, notices, teammates, teamDir };
}

let passed = 0;
let failed = 0;
async function test(label: string, body: () => Promise<void>) {
	try { await body(); passed++; console.log(`PASS ${label}`); }
	catch (error) { failed++; console.error(`FAIL ${label}`, error); }
}

for (const command of ["done", "shutdown"] as const) {
	await test(`${command}: stopped RPCs receive no request; manual workers still do`, async () => {
		const f = await fixture(command);
		await f[command]();
		assert.equal(f.state.stopped, 1);
		assert.deepEqual(await f.inbox("rpc1"), []);
		assert.deepEqual(await f.inbox("rpc2"), []);
		assert.equal((await f.inbox("manual")).length, 1);
		assert.equal((await f.inbox("busy")).length, 1);
		assert.equal(command === "done" ? f.state.hidden : f.state.rendered, 1);
	});
	await test(`${command}: partial stop failure propagates without manual shutdown or success UI`, async () => {
		const f = await fixture(`${command}-failure`, false, true);
		await assert.rejects(f[command](), /second RPC stop failed/);
		assert.equal(f.teammates.has("rpc2"), true);
		assert.equal(f.state.hidden + f.state.rendered, 0);
		assert.deepEqual(f.notices, []);
		for (const name of ["rpc1", "rpc2", "manual", "busy"]) assert.deepEqual(await f.inbox(name), []);
	});
}

await test("done: busy task refuses shutdown without force", async () => {
	const f = await fixture("done-busy", true);
	await f.done();
	assert.equal(f.state.stopped, 0);
	assert.equal(f.state.hidden, 0);
	assert.match(f.notices.join("\n"), /still in progress/);
	for (const name of ["rpc1", "rpc2", "manual", "busy"]) assert.deepEqual(await f.inbox(name), []);
});

await test("done --force: manual busy worker receives shutdown and task is unassigned", async () => {
	const f = await fixture("done-force", true);
	await f.done(["--force"]);
	assert.deepEqual(await f.inbox("rpc1"), []);
	assert.equal((await f.inbox("busy")).length, 1);
	const tasks = await listTasks(f.teamDir, "tasks");
	assert.equal(tasks[0]?.owner, undefined);
	assert.equal(tasks[0]?.status, "pending");
	assert.equal(f.state.hidden, 1);
});

await test("shutdown: busy manual worker stays active without receiving shutdown", async () => {
	const f = await fixture("shutdown-busy", true);
	await f.shutdown();
	assert.deepEqual(await f.inbox("rpc1"), []);
	assert.deepEqual(await f.inbox("busy"), []);
	assert.equal((await f.inbox("manual")).length, 1);
	const tasks = await listTasks(f.teamDir, "tasks");
	assert.equal(tasks[0]?.owner, "busy");
	assert.equal(tasks[0]?.status, "in_progress");
});

console.log(`CLI lifecycle: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
