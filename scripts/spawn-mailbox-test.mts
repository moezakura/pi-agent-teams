/** Deterministic file/protocol integration tests; RPC start and UI are mocked, no model API. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsNode from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runLeader } from "../extensions/teams/leader.js";
import { runWorker } from "../extensions/teams/worker.js";
import { TeammateRpc } from "../extensions/teams/teammate-rpc.js";
import { getInboxPath, retireShutdownRequests, writeToMailbox } from "../extensions/teams/mailbox.js";
import { TEAM_MAILBOX_NS } from "../extensions/teams/protocol.js";
import { getTeamsRootDir } from "../extensions/teams/paths.js";
import { ensureTeamConfig, setMemberStatus, upsertMember, loadTeamConfig } from "../extensions/teams/team-config.js";
import { withLock } from "../extensions/teams/fs-lock.js";

const taskRoot = getTeamsRootDir();
const fixtureParent = process.env.PI_TEAMS_TEST_FIXTURES ?? path.join(taskRoot, "mailbox-fixtures");
await fs.mkdir(fixtureParent, { recursive: true });
const root = await fs.mkdtemp(path.join(fixtureParent, "run-"));
const old = { from: "team-lead", text: JSON.stringify({ type: "shutdown_request", requestId: "old" }), timestamp: "2026-09-01T00:00:00Z", read: false, extra: { preserve: true } };
const read = async (file: string): Promise<unknown[]> => JSON.parse(await fs.readFile(file, "utf8")) as unknown[];
async function put(file: string, contents: unknown) {
 await fs.mkdir(path.dirname(file), { recursive: true });
 await fs.writeFile(file, JSON.stringify(contents));
}
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
async function harness(id: string) {
 const teamDir = path.join(root, id);
 const teamId = path.relative(taskRoot, teamDir);
 const notifications: string[] = [];
 let command: Command | undefined;
 const pi = {
  on() {}, registerTool() {},
  registerCommand(name: string, options: { handler: Command }) { if (name === "team") command = options.handler; },
  getThinkingLevel: () => "off", getActiveTools: () => [],
 } as unknown as ExtensionAPI;
 const ctx = {
  cwd: root, model: { provider: "test", id: "test" },
  sessionManager: { getSessionId: () => teamId, getSessionFile: () => undefined },
  ui: { setWidget() {}, notify(text: string) { notifications.push(text); } },
 } as unknown as ExtensionCommandContext;
 runLeader(pi);
 assert.ok(command);
 const invoke = command;
 return { teamDir, teamId, ctx, notifications, command: (args: string) => invoke(args, ctx), spawn: (name = "worker", extra = "") => invoke(`spawn ${name} fresh ${extra}`, ctx) };
}
let starts = 0;
let failStart = false;
const failedRpcs: TeammateRpc[] = [];
const originalStart = TeammateRpc.prototype.start;
const originalSetName = TeammateRpc.prototype.setSessionName;
TeammateRpc.prototype.start = async function (opts) {
 starts++;
 const dir = path.join(taskRoot, opts.env.PI_TEAMS_TEAM_ID ?? "");
 for (const ns of [TEAM_MAILBOX_NS, opts.env.PI_TEAMS_TASK_LIST_ID ?? ""]) {
  const inbox = getInboxPath(dir, ns, this.name);
  try {
   for (const message of await read(inbox)) {
    if (typeof message === "object" && message !== null && "text" in message && message.text === old.text) {
     assert.ok("read" in message && message.read === true, "old shutdown must be retired before actual spawn start");
    }
   }
  } catch (err) { if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err; }
 }
 if (failStart) { failedRpcs.push(this); throw new Error("synthetic start failure"); }
};
TeammateRpc.prototype.setSessionName = async function () {};
try {
 const h = await harness("preservation");
 const messages = [old, { ...old, read: true }, { ...old, text: "ordinary DM" }, { ...old, text: JSON.stringify({ type: "task_assignment", taskId: "1" }) }, { ...old, text: JSON.stringify({ type: "abort_request", requestId: "a" }) }, { ...old, text: '{"type":"shutdown_request"}' }, { opaque: 42 }, null, 9];
 for (const ns of [TEAM_MAILBOX_NS, h.teamId]) await put(getInboxPath(h.teamDir, ns, "worker"), messages);
 await h.spawn();
 for (const ns of [TEAM_MAILBOX_NS, h.teamId]) assert.deepEqual((await read(getInboxPath(h.teamDir, ns, "worker"))).slice(0, messages.length), [{ ...old, read: true }, ...messages.slice(1)]);
 console.log("PASS T12: actual spawn clears both namespaces, retains DM/task/other control/unknown values and fields");
 const count = starts;
 const before = await fs.readFile(getInboxPath(h.teamDir, TEAM_MAILBOX_NS, "worker"), "utf8");
 await h.spawn();
 assert.equal(starts, count);
 assert.equal(await fs.readFile(getInboxPath(h.teamDir, TEAM_MAILBOX_NS, "worker"), "utf8"), before);
 console.log("PASS T15: owned duplicate does not clean or start");

 const invalid = await harness("invalid-model");
 const invalidInbox = getInboxPath(invalid.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(invalidInbox, [old]);
 await invalid.spawn("worker", "--model test/");
 assert.equal(starts, count);
 assert.deepEqual(await read(invalidInbox), [old]);
 console.log("PASS T15: invalid model leaves inbox untouched");

 const manual = await harness("manual");
 await ensureTeamConfig(manual.teamDir, { teamId: manual.teamId, taskListId: manual.teamId, leadName: "team-lead" });
 await upsertMember(manual.teamDir, { name: "worker", role: "worker", status: "online" });
 const manualInbox = getInboxPath(manual.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(manualInbox, [old]);
 await manual.spawn();
 assert.equal(starts, count);
 assert.deepEqual(await read(manualInbox), [old]);
 assert.ok(manual.notifications.some((n) => n.includes("not owned")));
 await setMemberStatus(manual.teamDir, "worker", "offline");
 await manual.spawn();
 assert.equal(starts, count + 1);
 console.log("PASS T15: nonowned online collision fails closed, explicit offline permits retry");

 for (const [label, raw] of [["invalid-json", "{"], ["invalid-array", "{}"]]) {
  const bad = await harness(label ?? "bad");
  const inbox = getInboxPath(bad.teamDir, TEAM_MAILBOX_NS, "worker");
  await put(inbox, []); await fs.writeFile(inbox, raw ?? "{");
  const n = starts; await bad.spawn();
  assert.equal(starts, n); assert.equal(await fs.readFile(inbox, "utf8"), raw);
 }
 for (const raw of ["{", '{"version":1,"members":[]}', '{"version":1,"teamId":"x","taskListId":"x","leadName":"lead","createdAt":"t","updatedAt":"t","members":[{}]}']) {
  const bad = await harness(`config-${raw.length}`);
  const inbox = getInboxPath(bad.teamDir, TEAM_MAILBOX_NS, "worker");
  await put(inbox, [old]); await fs.writeFile(path.join(bad.teamDir, "config.json"), raw);
  const n = starts; await bad.spawn();
  assert.equal(starts, n); assert.deepEqual(await read(inbox), [old]);
  assert.equal(await fs.readFile(path.join(bad.teamDir, "config.json"), "utf8"), raw);
 }
 const unreadable = await harness("unreadable-config");
 await fs.mkdir(path.join(unreadable.teamDir, "config.json"), { recursive: true });
 const unreadableInbox = getInboxPath(unreadable.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(unreadableInbox, [old]);
 const unreadableCount = starts; await unreadable.spawn();
 assert.equal(starts, unreadableCount); assert.deepEqual(await read(unreadableInbox), [old]);
 const partial = await harness("partial");
 const first = getInboxPath(partial.teamDir, TEAM_MAILBOX_NS, "worker");
 const second = getInboxPath(partial.teamDir, partial.teamId, "worker");
 await put(first, [old]); await put(second, []); await fs.writeFile(second, "{");
 const n = starts; await partial.spawn();
 assert.equal(starts, n); assert.deepEqual(await read(first), [{ ...old, read: true }]);
 assert.equal(await fs.readFile(second, "utf8"), "{");
 await put(second, [old]); await partial.spawn(); assert.equal(starts, n + 1);
 console.log("PASS T14: invalid JSON/array/config and second namespace failure prevent start; partial cleanup preserved; retry works");

 const dedup = await harness("dedup");
 await dedup.command(`task use ${TEAM_MAILBOX_NS}`);
 const dedupInbox = getInboxPath(dedup.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(dedupInbox, [old]);
 const originalRead = fsNode.promises.readFile;
 const dedupStarts = starts;
 let readsBeforeStart = 0;
 fsNode.promises.readFile = new Proxy(originalRead, {
  apply(target, thisArg, args: Parameters<typeof originalRead>) {
   if (args[0] === dedupInbox && starts === dedupStarts) readsBeforeStart++;
   return Reflect.apply(target, thisArg, args);
  },
 });
 try { await dedup.spawn(); } finally { fsNode.promises.readFile = originalRead; }
 assert.equal(starts, dedupStarts + 1); assert.equal(readsBeforeStart, 1);
 console.log("PASS T12: identical namespaces are read for cleanup once before start");

 const lock = await harness("lock");
 const lockInbox = getInboxPath(lock.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(lockInbox, [old]);
 await put(`${lockInbox}.lock`, { pid: process.pid });
 const beforeLock = starts;
 await lock.spawn();
 assert.equal(starts, beforeLock); assert.deepEqual(await read(lockInbox), [old]);
 assert.ok(lock.notifications.some((m) => m.includes("Timeout acquiring lock")));
 await fs.unlink(`${lockInbox}.lock`);
 await lock.spawn(); assert.equal(starts, beforeLock + 1);
 console.log("PASS T14: live lock timeout fails closed and releases spawn reservation");

 const failed = await harness("start-failed");
 const failedInbox = getInboxPath(failed.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(failedInbox, [old]); failStart = true; await failed.spawn(); failStart = false;
 assert.deepEqual(await read(failedInbox), [{ ...old, read: true }]);
 assert.equal((await loadTeamConfig(failed.teamDir))?.members.some((m) => m.name === "worker" && m.status === "online") ?? false, false);
 const listeners = failedRpcs[0] as unknown as { eventListeners: unknown[]; closeListeners: unknown[] };
 assert.equal(listeners.eventListeners.length, 0); assert.equal(listeners.closeListeners.length, 0);
 const retryCount = starts; await failed.spawn(); assert.equal(starts, retryCount + 1);
 console.log("PASS T16: start failure removes map entry and subscriptions, keeps retired requests, permits retry");

 const race = await harness("race");
 const raceCount = starts;
 await Promise.all([race.spawn(), race.spawn()]);
 assert.equal(starts, raceCount + 1);
 console.log("PASS: concurrent same-name calls start only one worker");

 const append = getInboxPath(root, "append", "worker");
 await put(append, [old]);
 await withLock(`${append}.lock`, async () => { /* same production lock path */ });
 await retireShutdownRequests(root, "append", "worker");
 const fresh = { ...old, text: JSON.stringify({ type: "shutdown_request", requestId: "new" }) };
 await writeToMailbox(root, "append", "worker", fresh);
 assert.equal((await read(append) as Array<{read: boolean}>)[1]?.read, false);
 console.log("PASS T13: new request appended after cleanup remains unread");

 // Real worker polling/approval path, using a mock ExtensionContext shutdown callback.
 const workerHarness = await harness("worker-protocol");
 const workerInbox = getInboxPath(workerHarness.teamDir, TEAM_MAILBOX_NS, "worker");
 await put(workerInbox, [old]); await workerHarness.spawn();
 Object.assign(process.env, { PI_TEAMS_TEAM_ID: workerHarness.teamId, PI_TEAMS_AGENT_NAME: "worker", PI_TEAMS_TASK_LIST_ID: workerHarness.teamId, PI_TEAMS_AUTO_CLAIM: "0", PI_TEAMS_PLAN_REQUIRED: "0" });
 type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;
 const events = new Map<string, EventHandler>();
 let shutdowns = 0;
 let resolveDm: (() => void) | undefined;
 const receivedDm = new Promise<void>((resolve) => { resolveDm = resolve; });
 const workerPi = { on(name: string, cb: EventHandler) { events.set(name, cb); }, registerTool() {}, registerCommand() {}, sendUserMessage() { resolveDm?.(); }, setSessionName() {}, getSessionName: () => "" } as unknown as ExtensionAPI;
 runWorker(workerPi);
 const workerCtx = { ...workerHarness.ctx, abort() {}, shutdown() { shutdowns++; } } as unknown as ExtensionCommandContext;
 await writeToMailbox(workerHarness.teamDir, TEAM_MAILBOX_NS, "worker", { ...old, text: "probe DM" });
 const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "worker poll timeout");
 };
 try {
  await events.get("session_start")?.({}, workerCtx);
  let dmReceived = false; void receivedDm.then(() => { dmReceived = true; });
  await wait(() => dmReceived);
  assert.equal(shutdowns, 0);
  await writeToMailbox(workerHarness.teamDir, TEAM_MAILBOX_NS, "worker", fresh);
  await wait(() => shutdowns === 1);
  const approvals = await read(getInboxPath(workerHarness.teamDir, TEAM_MAILBOX_NS, "team-lead")) as Array<{text: string}>;
  const ids = approvals.map((m) => JSON.parse(m.text) as {type?: string; requestId?: string}).filter((m) => m.type === "shutdown_approved").map((m) => m.requestId);
  assert.deepEqual(ids, ["new"]);
  console.log("PASS T13/T17/T18 protocol boundary: production worker consumes DM, ignores old shutdown, approves only new shutdown and invokes shutdown once");
 } finally { await events.get("session_shutdown")?.({}, workerCtx); }
 console.log("PASS: spawn/mailbox regression suite (no model API, no real RPC subprocess)");
} finally {
 TeammateRpc.prototype.start = originalStart;
 TeammateRpc.prototype.setSessionName = originalSetName;
}
