/**
 * Smoke test for pi-agent-teams extension primitives.
 *
 * Tests: fs-lock, mailbox, task-store, team-config, protocol parsers, names.
 * Does NOT require a running Pi session — exercises the library code directly.
 *
 * Usage:  npx tsx scripts/smoke-test.mts
 */

import * as fs from "node:fs";
import * as path from "node:path";

// We import from .ts source (tsx handles it)
import { withLock } from "../extensions/teams/fs-lock.js";
import { writeToMailbox, popUnreadMessages, getInboxPath } from "../extensions/teams/mailbox.js";
import {
	createTask,
	listTasks,
	getTask,
	updateTask,
	completeTask,
	clearTasks,
	startAssignedTask,
	claimNextAvailableTask,
	unassignTasksForAgent,
	formatTaskLine,
	addTaskDependency,
	removeTaskDependency,
	isTaskBlocked,
} from "../extensions/teams/task-store.js";
import { ensureTeamConfig, loadTeamConfig, upsertMember, setMemberStatus, updateTeamHooksPolicy } from "../extensions/teams/team-config.js";
import { sanitizeName } from "../extensions/teams/names.js";
import { formatProviderModel, isDeprecatedTeammateModelId, resolveTeammateModelSelection } from "../extensions/teams/model-policy.js";
import { getMemberModel, getMemberThinking, shortModelLabel } from "../extensions/teams/teams-ui-shared.js";
import { getTeamsNamingRules, getTeamsStrings } from "../extensions/teams/teams-style.js";
import {
	HOOK_CONTRACT_VERSION,
	buildHookContextPayload,
	getTeamsHookFailureAction,
	getTeamsHookFollowupOwnerPolicy,
	getTeamsHookMaxReopensPerTask,
	resolveTeamsHookFollowupOwner,
	runTeamsHook,
	shouldCreateHookFollowupTask,
	shouldReopenTaskOnHookFailure,
} from "../extensions/teams/hooks.js";
import { ActivityTracker, TranscriptTracker, type TranscriptEntry } from "../extensions/teams/activity-tracker.js";
import { listDiscoveredTeams } from "../extensions/teams/team-discovery.js";
import {
	acquireTeamAttachClaim,
	assessAttachClaimFreshness,
	heartbeatTeamAttachClaim,
	releaseTeamAttachClaim,
} from "../extensions/teams/team-attach-claim.js";
import { getTeamHelpText } from "../extensions/teams/leader-team-command.js";
import { handleTeamCleanupCommand } from "../extensions/teams/leader-lifecycle-commands.js";
import { registerTeamsTool } from "../extensions/teams/leader-teams-tool.js";
import { startWaitPollLoop } from "../extensions/teams/wait-poll-loop.js";
import { isTeamDone, formatElapsed, lastMessageSummary } from "../extensions/teams/teams-ui-shared.js";
import {
	TEAM_MAILBOX_NS,
	isIdleNotification,
	isShutdownApproved,
	isShutdownRejected,
	isTaskAssignmentMessage,
	isShutdownRequestMessage,
	isSetSessionNameMessage,
	isPlanApprovalRequest,
	isPeerDmSent,
	isAbortRequestMessage,
	isPlanApprovedMessage,
	isPlanRejectedMessage,
} from "../extensions/teams/protocol.js";
import { DelegationTracker, TeamWaitTracker, formatTeamWaitWake, pollLeaderInbox } from "../extensions/teams/leader-inbox.js";
import { PendingLeaderWakeQueue } from "../extensions/teams/pending-wake-queue.js";
import { getParentSessionId, shouldSilenceInheritedParentAttachClaimWarning } from "../extensions/teams/session-parent.js";
import { branchSelectionNote, ensureSessionFileMaterialized, resolveBranchLeafSelection } from "../extensions/teams/session-branching.js";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ── helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

function assertEq(actual: unknown, expected: unknown, label: string) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) {
		console.error(`    actual:   ${JSON.stringify(actual)}`);
		console.error(`    expected: ${JSON.stringify(expected)}`);
	}
	assert(ok, label);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

// paths.ts validates the shared teams root as /tmp/{repo}/{UUIDv7}. Keep the
// smoke sandbox in that same shape so style/hook tests exercise the production
// root validation instead of bypassing it with mkdtemp's arbitrary suffix.
const smokeRunSuffix = `${process.pid.toString(16)}${process.hrtime.bigint().toString(16)}`.slice(-12).padStart(12, "0");
const tmpRoot = path.join("/tmp", "pi-teams-smoke", `01900000-0000-7000-8000-${smokeRunSuffix}`);
fs.mkdirSync(tmpRoot, { recursive: true });
const teamDir = path.join(tmpRoot, "team-test");
const taskListId = "smoke-tl";

console.log(`\nSmoke test root: ${tmpRoot}\n`);

// ── 1. names ─────────────────────────────────────────────────────────
console.log("1. names.sanitizeName");
// sanitizeName replaces non-alnum/underscore/hyphen with hyphens, preserves case
assertEq(sanitizeName("Hello World!"), "Hello-World-", "non-alnum → hyphens");
assertEq(sanitizeName("agent_1"), "agent_1", "underscores kept");
assertEq(sanitizeName(""), "", "empty stays empty");
assertEq(sanitizeName("UPPER"), "UPPER", "case preserved");

// ── 1b. model policy ────────────────────────────────────────────────
console.log("\n1b. model-policy");
assert(isDeprecatedTeammateModelId("claude-sonnet-4"), "marks sonnet-4 alias as deprecated");
assert(
	isDeprecatedTeammateModelId("anthropic.claude-sonnet-4-20250514-v1:0"),
	"marks sonnet-4 dated/bedrock variants as deprecated",
);
assert(!isDeprecatedTeammateModelId("claude-sonnet-4-5"), "does not block sonnet-4-5");
assert(!isDeprecatedTeammateModelId("claude-sonnet-4.5"), "does not block sonnet-4.5");
assert(!isDeprecatedTeammateModelId("gpt-5.1-codex-mini"), "keeps current models allowed");

const modelResolvedExplicit = resolveTeammateModelSelection({
	modelOverride: "openai-codex/gpt-5.1-codex-mini",
	leaderProvider: "anthropic",
	leaderModelId: "claude-sonnet-4-5",
});
assert(modelResolvedExplicit.ok, "resolveTeammateModelSelection accepts provider/model override");
if (modelResolvedExplicit.ok) {
	assertEq(modelResolvedExplicit.value.source, "override", "explicit override source");
	assertEq(formatProviderModel(modelResolvedExplicit.value.provider, modelResolvedExplicit.value.modelId), "openai-codex/gpt-5.1-codex-mini", "explicit override keeps provider/model");
}

const modelResolvedModelOnly = resolveTeammateModelSelection({
	modelOverride: "gpt-5.1-codex-mini",
	leaderProvider: "openai-codex",
	leaderModelId: "gpt-5.1-codex-mini",
});
assert(modelResolvedModelOnly.ok, "resolveTeammateModelSelection accepts model-only override");
if (modelResolvedModelOnly.ok) {
	assertEq(formatProviderModel(modelResolvedModelOnly.value.provider, modelResolvedModelOnly.value.modelId), "openai-codex/gpt-5.1-codex-mini", "model-only override inherits leader provider");
}

const modelResolvedInvalid = resolveTeammateModelSelection({ modelOverride: "openai-codex/" });
assert(!modelResolvedInvalid.ok, "resolveTeammateModelSelection rejects invalid provider/model override");
if (!modelResolvedInvalid.ok) {
	assertEq(modelResolvedInvalid.reason, "invalid_override", "invalid override reason");
}

const modelResolvedDeprecated = resolveTeammateModelSelection({ modelOverride: "claude-sonnet-4" });
assert(!modelResolvedDeprecated.ok, "resolveTeammateModelSelection rejects deprecated override");
if (!modelResolvedDeprecated.ok) {
	assertEq(modelResolvedDeprecated.reason, "deprecated_override", "deprecated override reason");
}

const modelResolvedDeprecatedLeader = resolveTeammateModelSelection({
	leaderProvider: "anthropic",
	leaderModelId: "claude-sonnet-4-20250514",
});
assert(modelResolvedDeprecatedLeader.ok, "resolveTeammateModelSelection handles deprecated leader model fallback");
if (modelResolvedDeprecatedLeader.ok) {
	assertEq(modelResolvedDeprecatedLeader.value.source, "default", "deprecated leader model is not inherited");
	assertEq(formatProviderModel(modelResolvedDeprecatedLeader.value.provider, modelResolvedDeprecatedLeader.value.modelId), null, "deprecated leader fallback has no explicit model");
}

// ── 1c. UI shared helpers ────────────────────────────────────────────
console.log("\n1c. teams-ui-shared helpers");
{
	// shortModelLabel
	assertEq(shortModelLabel("anthropic/claude-sonnet-4-5-20250514"), "claude-sonnet-4-5", "shortModelLabel strips provider and date");
	assertEq(shortModelLabel("openai-codex/gpt-5.1-codex-mini"), "gpt-5.1-codex-mini", "shortModelLabel strips provider, no date");
	assertEq(shortModelLabel("claude-sonnet-4-5-20250514"), "claude-sonnet-4-5", "shortModelLabel strips date without provider");
	assertEq(shortModelLabel("claude-opus-4-20250514-v2"), "claude-opus-4", "shortModelLabel strips date with variant suffix");
	assertEq(shortModelLabel("gpt-5.1-codex-mini"), "gpt-5.1-codex-mini", "shortModelLabel keeps clean model id");

	// getMemberModel
	assertEq(getMemberModel(undefined), null, "getMemberModel returns null for undefined member");
	assertEq(
		getMemberModel({ name: "a", role: "worker", addedAt: "", status: "online" }),
		null,
		"getMemberModel returns null when no meta",
	);
	assertEq(
		getMemberModel({ name: "a", role: "worker", addedAt: "", status: "online", meta: { model: "anthropic/claude-sonnet-4-5" } }),
		"anthropic/claude-sonnet-4-5",
		"getMemberModel extracts model from meta",
	);

	// getMemberThinking
	assertEq(getMemberThinking(undefined), null, "getMemberThinking returns null for undefined member");
	assertEq(
		getMemberThinking({ name: "a", role: "worker", addedAt: "", status: "online", meta: { thinkingLevel: "high" } }),
		"high",
		"getMemberThinking extracts thinking from meta",
	);
}

// ── 2. fs-lock ───────────────────────────────────────────────────────
console.log("\n2. fs-lock.withLock");
{
	const lockFile = path.join(tmpRoot, "test.lock");
	const result = await withLock(lockFile, async () => 42, { label: "smoke" });
	assertEq(result, 42, "withLock returns fn result");
	assert(!fs.existsSync(lockFile), "lock file cleaned up after");
}

{
	// Stale lock is removed.
	const lockFile = path.join(tmpRoot, "stale.lock");
	fs.writeFileSync(lockFile, "stale");
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lockFile, old, old);

	const result = await withLock(lockFile, async () => "ok", { staleMs: 1, timeoutMs: 500 });
	assertEq(result, "ok", "withLock removes stale lock file");
	assert(!fs.existsSync(lockFile), "stale lock cleaned up after");
}

{
	// A lock with a live holder PID must not be stolen just because it is old.
	const lockFile = path.join(tmpRoot, "live-old.lock");
	fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 120_000).toISOString() }));
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lockFile, old, old);

	let entered = false;
	let timedOut = false;
	try {
		await withLock(
			lockFile,
			async () => {
				entered = true;
			},
			{ staleMs: 1, timeoutMs: 50, pollMs: 5 },
		);
	} catch (err: unknown) {
		timedOut = err instanceof Error && err.message.startsWith("Timeout acquiring lock:");
	}

	assert(timedOut, "withLock times out instead of stealing a live old lock");
	assert(!entered, "withLock does not enter critical section for a live old lock");
	assert(fs.existsSync(lockFile), "live old lock remains for the holder to release");
	fs.unlinkSync(lockFile);
}

{
	// Contention: many concurrent callers should serialize without throwing.
	const lockFile = path.join(tmpRoot, "contended.lock");
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	let counter = 0;

	const runners = Array.from({ length: 20 }, () =>
		withLock(
			lockFile,
			async () => {
				counter += 1;
				await sleep(5);
				return counter;
			},
			{ timeoutMs: 5_000, pollMs: 2 },
		),
	);

	await Promise.all(runners);
	assertEq(counter, 20, "withLock serializes contended callers");
	assert(!fs.existsSync(lockFile), "contended lock cleaned up after");
}

// ── 3. mailbox ───────────────────────────────────────────────────────
console.log("\n3. mailbox");
{
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "team-lead",
		text: "hello agent1",
		timestamp: "2025-01-01T00:00:00Z",
	});
	const inboxPath = getInboxPath(teamDir, TEAM_MAILBOX_NS, "agent1");
	assert(fs.existsSync(inboxPath), "inbox file created");

	const raw: unknown = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
	assert(Array.isArray(raw), "inbox json is array");
	assertEq(Array.isArray(raw) ? raw.length : 0, 1, "one message in inbox");
	const first = Array.isArray(raw) ? raw.at(0) : undefined;
	assert(isRecord(first) && typeof first.read === "boolean", "message has boolean read");
	if (isRecord(first) && typeof first.read === "boolean") {
		assertEq(first.read, false, "message initially unread");
	}

	// pop
	const msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs.length, 1, "popUnreadMessages returns 1");
	const m0 = msgs.at(0);
	assert(m0 !== undefined, "pop returned first message");
	if (m0) assertEq(m0.text, "hello agent1", "message text correct");

	// re-pop should be empty
	const msgs2 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs2.length, 0, "second pop returns 0 (already read)");

	// multiple messages
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "team-lead",
		text: "msg2",
		timestamp: "2025-01-01T00:01:00Z",
	});
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "peer",
		text: "msg3",
		timestamp: "2025-01-01T00:02:00Z",
	});
	const msgs3 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs3.length, 2, "pop returns 2 new unread messages");

	// urgent messages
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "peer",
		text: "urgent interrupt",
		timestamp: "2025-01-01T00:03:00Z",
		urgent: true,
	});
	const msgs4 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs4.length, 1, "pop returns 1 urgent message");
	{
		const m = msgs4.at(0);
		assertEq(m?.urgent, true, "urgent flag preserved");
		assertEq(m?.text, "urgent interrupt", "urgent message text correct");
	}

	// non-urgent messages default to no urgent field
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "peer",
		text: "normal msg",
		timestamp: "2025-01-01T00:04:00Z",
	});
	const msgs5 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs5.length, 1, "pop returns 1 normal message");
	assertEq(msgs5.at(0)?.urgent, undefined, "non-urgent message has no urgent flag");
}

// ── 4. task-store ────────────────────────────────────────────────────
console.log("\n4. task-store");
{
	const t1 = await createTask(teamDir, taskListId, {
		subject: "Write tests",
		description: "Write unit tests for the extension",
		owner: "agent1",
	});
	assert(typeof t1.id === "string" && t1.id.length > 0, "task created with id");
	assertEq(t1.status, "pending", "new task is pending");
	assertEq(t1.owner, "agent1", "owner set");

	const t2 = await createTask(teamDir, taskListId, {
		subject: "Fix lint",
		description: "Fix all lint errors",
	});

	const all = await listTasks(teamDir, taskListId);
	assertEq(all.length, 2, "listTasks returns 2");

	const fetched = await getTask(teamDir, taskListId, t1.id);
	assertEq(fetched?.subject, "Write tests", "getTask returns correct task");

	// update
	const updated = await updateTask(teamDir, taskListId, t1.id, (cur) => ({
		...cur,
		status: "in_progress",
	}));
	assertEq(updated?.status, "in_progress", "updateTask changes status");

	// startAssignedTask — requires task.owner === agentName && status === pending
	// First assign t2 to agent2, then start it
	await updateTask(teamDir, taskListId, t2.id, (cur) => ({ ...cur, owner: "agent2" }));
	await startAssignedTask(teamDir, taskListId, t2.id, "agent2");
	const t2after = await getTask(teamDir, taskListId, t2.id);
	assertEq(t2after?.status, "in_progress", "startAssignedTask sets in_progress");
	assertEq(t2after?.owner, "agent2", "startAssignedTask preserves owner");

	// completeTask
	await completeTask(teamDir, taskListId, t1.id, "agent1", "All tests passing");
	const t1done = await getTask(teamDir, taskListId, t1.id);
	assertEq(t1done?.status, "completed", "completeTask sets completed");

	// formatTaskLine
	assert(t1done !== null, "completed task can be re-fetched");
	if (t1done) {
		const line = formatTaskLine(t1done);
		assert(line.includes("completed"), "formatTaskLine includes status");
		assert(line.includes("Write tests"), "formatTaskLine includes subject");
	}

	// claimNextAvailableTask
	const t3 = await createTask(teamDir, taskListId, {
		subject: "Unclaimed task",
		description: "nobody owns this",
	});
	const claimed = await claimNextAvailableTask(teamDir, taskListId, "agent3");
	assert(claimed !== null, "claimNextAvailableTask finds a task");
	assertEq(claimed?.owner, "agent3", "claimed task now owned by agent3");

	// unassignTasksForAgent — unassigns all non-completed tasks for agent
	// agent3 claimed a task above, unassign it
	await unassignTasksForAgent(teamDir, taskListId, "agent3", "agent3 left");
	const t3unassigned = await getTask(teamDir, taskListId, t3.id);
	assertEq(t3unassigned?.owner, undefined, "unassignTasksForAgent clears owner");

	// dependencies
	const depRes = await addTaskDependency(teamDir, taskListId, t3.id, t2.id);
	assert(depRes.ok, "addTaskDependency ok");
	const t3fetched = await getTask(teamDir, taskListId, t3.id);
	assert(t3fetched !== null, "getTask returns dependency task");
	const blocked = t3fetched ? await isTaskBlocked(teamDir, taskListId, t3fetched) : false;
	assert(blocked, "task is blocked by dependency");

	const rmDep = await removeTaskDependency(teamDir, taskListId, t3.id, t2.id);
	assert(rmDep.ok, "removeTaskDependency ok");

	// clearTasks (completed only)
	const clearResult = await clearTasks(teamDir, taskListId, "completed");
	assert(clearResult.deletedTaskIds.length >= 1, "clearTasks deleted completed tasks");
	assert(clearResult.skippedTaskIds.length >= 1, "clearTasks skipped non-completed");
}

// ── 5. team-config ───────────────────────────────────────────────────
console.log("\n5. team-config");
{
	const cfg = await ensureTeamConfig(teamDir, {
		teamId: "smoke-team",
		taskListId: "smoke-tl",
		leadName: "team-lead",
		style: "normal",
	});
	assertEq(cfg.version, 1, "config version 1");
	assertEq(cfg.teamId, "smoke-team", "teamId set");
	assert(cfg.members.length >= 1, "has at least lead member");
	const firstMember = cfg.members.at(0);
	assert(firstMember !== undefined, "first member exists");
	if (firstMember) assertEq(firstMember.role, "lead", "first member is lead");

	// idempotent
	const cfg2 = await ensureTeamConfig(teamDir, {
		teamId: "smoke-team",
		taskListId: "smoke-tl",
		leadName: "team-lead",
		style: "normal",
	});
	assertEq(cfg2.teamId, cfg.teamId, "ensureTeamConfig idempotent");

	// upsertMember
	const cfg3 = await upsertMember(teamDir, {
		name: "agent1",
		role: "worker",
		status: "online",
	});
	assert(cfg3.members.some((m) => m.name === "agent1" && m.role === "worker"), "upsertMember adds worker");

	// setMemberStatus
	const cfg4 = await setMemberStatus(teamDir, "agent1", "offline");
	assert(cfg4 !== null, "setMemberStatus returns config");
	if (cfg4) {
		assert(
			cfg4.members.some((m) => m.name === "agent1" && m.status === "offline"),
			"setMemberStatus changes status",
		);
	}

	// loadTeamConfig
	const loaded = await loadTeamConfig(teamDir);
	assert(loaded !== null, "loadTeamConfig returns config");
	assertEq(loaded?.teamId, "smoke-team", "loadTeamConfig correct teamId");

	// updateTeamHooksPolicy
	const withHooks = await updateTeamHooksPolicy(teamDir, () => ({
		failureAction: "reopen_followup",
		maxReopensPerTask: 2,
		followupOwner: "member",
	}));
	assert(withHooks !== null, "updateTeamHooksPolicy returns config");
	assertEq(withHooks?.hooks?.failureAction, "reopen_followup", "updateTeamHooksPolicy sets failure action");
	assertEq(withHooks?.hooks?.maxReopensPerTask, 2, "updateTeamHooksPolicy sets max reopens");
	assertEq(withHooks?.hooks?.followupOwner, "member", "updateTeamHooksPolicy sets followup owner");

	const clearedHooks = await updateTeamHooksPolicy(teamDir, () => undefined);
	assert(clearedHooks !== null, "updateTeamHooksPolicy can clear policy");
	assertEq(clearedHooks?.hooks, undefined, "updateTeamHooksPolicy clears hooks policy");
}

// ── 6. protocol parsers ──────────────────────────────────────────────
console.log("\n6. protocol parsers");
{
	// idle notification
	const idle = isIdleNotification(
		JSON.stringify({ type: "idle_notification", from: "agent1", timestamp: "2025-01-01T00:00:00Z" }),
	);
	assert(idle !== null, "isIdleNotification parses valid");
	assertEq(idle?.from, "agent1", "idle.from correct");

	assert(isIdleNotification("not json") === null, "isIdleNotification rejects garbage");
	assert(isIdleNotification(JSON.stringify({ type: "other" })) === null, "rejects wrong type");

	// task assignment
	const assign = isTaskAssignmentMessage(
		JSON.stringify({ type: "task_assignment", taskId: "42", subject: "Do stuff" }),
	);
	assert(assign !== null, "isTaskAssignmentMessage parses valid");
	assertEq(assign?.taskId, "42", "assign.taskId correct");

	// shutdown request
	const shutReq = isShutdownRequestMessage(
		JSON.stringify({ type: "shutdown_request", requestId: "r1", from: "lead", reason: "done" }),
	);
	assert(shutReq !== null, "isShutdownRequestMessage parses valid");
	assertEq(shutReq?.requestId, "r1", "shutReq.requestId correct");

	// shutdown approved / rejected
	const approved = isShutdownApproved(
		JSON.stringify({ type: "shutdown_approved", requestId: "r1", from: "agent1" }),
	);
	assert(approved !== null, "isShutdownApproved parses valid");

	const rejected = isShutdownRejected(
		JSON.stringify({ type: "shutdown_rejected", requestId: "r1", from: "agent1", reason: "busy" }),
	);
	assert(rejected !== null, "isShutdownRejected parses valid");

	// set session name
	const setName = isSetSessionNameMessage(JSON.stringify({ type: "set_session_name", name: "my session" }));
	assert(setName !== null, "isSetSessionNameMessage parses valid");
	assertEq(setName?.name, "my session", "setName.name correct");

	// plan approval request
	const planReq = isPlanApprovalRequest(
		JSON.stringify({ type: "plan_approval_request", requestId: "p1", from: "agent1", plan: "do X then Y" }),
	);
	assert(planReq !== null, "isPlanApprovalRequest parses valid");

	// plan approved / rejected
	const planOk = isPlanApprovedMessage(
		JSON.stringify({ type: "plan_approved", requestId: "p1", from: "lead", timestamp: "t" }),
	);
	assert(planOk !== null, "isPlanApprovedMessage parses valid");

	const planNo = isPlanRejectedMessage(
		JSON.stringify({ type: "plan_rejected", requestId: "p1", from: "lead", feedback: "redo" }),
	);
	assert(planNo !== null, "isPlanRejectedMessage parses valid");

	// peer DM
	const dm = isPeerDmSent(
		JSON.stringify({ type: "peer_dm_sent", from: "a1", to: "a2", summary: "hi" }),
	);
	assert(dm !== null, "isPeerDmSent parses valid");

	// abort
	const abort = isAbortRequestMessage(
		JSON.stringify({ type: "abort_request", requestId: "ab1", from: "lead", taskId: "5" }),
	);
	assert(abort !== null, "isAbortRequestMessage parses valid");
}

// ── 7. Pi CLI extension loading (non-interactive) ────────────────────
console.log("\n7. Pi extension loading");
{
	const { spawnSync } = await import("node:child_process");

	// `pi` is expected to be installed in local dev, but it's usually not available in CI.
	// Even locally, it may hang due to user-specific config, so treat this as a best-effort check.
	const res = spawnSync("pi", ["--version"], {
		cwd: process.cwd(),
		timeout: 3_000,
		encoding: "utf8",
	});

	const errCode = (() => {
		const e: unknown = res.error;
		if (!e || typeof e !== "object") return undefined;
		const c = (e as { code?: unknown }).code;
		return typeof c === "string" ? c : undefined;
	})();

	const versionOutput = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();

	if (errCode === "ENOENT") {
		console.log("  (skipped) pi CLI not found on PATH");
	} else if (errCode === "ETIMEDOUT") {
		console.log("  (skipped) pi --version timed out");
	} else if (res.status !== 0) {
		console.log("  (skipped) pi --version returned non-zero exit code");
	} else if (versionOutput.length === 0) {
		console.log("  (skipped) pi --version produced no output");
	} else {
		assert(versionOutput.length > 0, "pi --version works");
	}
}

// ── 8. styles (custom + naming rules) ───────────────────────────────
console.log("\n8. teams-style (custom styles)");
{
	const prev = process.env.PI_TEAMS_ROOT_DIR;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;

	// Write a custom style under <teamsRoot>/_styles/
	const stylesDir = path.join(tmpRoot, "_styles");
	fs.mkdirSync(stylesDir, { recursive: true });
	fs.writeFileSync(
		path.join(stylesDir, "smoke-custom.json"),
		JSON.stringify(
			{
				extends: "pirate",
				strings: { memberTitle: "Deckhand", memberPrefix: "Deckhand " },
				naming: {
					requireExplicitSpawnName: false,
					autoNameStrategy: { kind: "pool", pool: ["pegleg"], fallbackBase: "deckhand" },
				},
			},
			null,
			2,
		) + "\n",
		"utf8",
	);

	const s = getTeamsStrings("smoke-custom");
	assertEq(s.memberTitle, "Deckhand", "custom style overrides strings");
	const naming = getTeamsNamingRules("smoke-custom");
	assert(naming.requireExplicitSpawnName === false, "custom style naming rules parsed");
	assert(naming.autoNameStrategy.kind === "pool", "custom style can use pool naming");
	if (naming.autoNameStrategy.kind === "pool") {
		assertEq(naming.autoNameStrategy.fallbackBase, "deckhand", "custom style fallbackBase parsed");
		assertEq(naming.autoNameStrategy.pool.at(0), "pegleg", "custom style pool parsed");
	}

	// restore env
	if (prev === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = prev;
}

// ── 9. hooks (quality gates) ────────────────────────────────────────
console.log("\n9. teams-hooks (quality gates)");
{
	const prevRoot = process.env.PI_TEAMS_ROOT_DIR;
	const prevEnabled = process.env.PI_TEAMS_HOOKS_ENABLED;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;
	process.env.PI_TEAMS_HOOKS_ENABLED = "1";

	const hooksDir = path.join(tmpRoot, "_hooks");
	fs.mkdirSync(hooksDir, { recursive: true });

	const outFile = path.join(tmpRoot, "hook-ran.txt");
	fs.writeFileSync(
		path.join(hooksDir, "on_task_completed.js"),
		"" +
			"const fs = require('node:fs');\n" +
			"const payload = {\n" +
			"  contextVersion: process.env.PI_TEAMS_HOOK_CONTEXT_VERSION || null,\n" +
			"  contextJson: process.env.PI_TEAMS_HOOK_CONTEXT_JSON || null,\n" +
			"  event: process.env.PI_TEAMS_HOOK_EVENT || null,\n" +
			"  taskId: process.env.PI_TEAMS_TASK_ID || null,\n" +
			"};\n" +
			`fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(payload) + '\\n', 'utf8');\n` +
			"process.exit(0);\n",
		"utf8",
	);

	const teamId = "smoke-team";
	const teamDir = path.join(tmpRoot, teamId);
	fs.mkdirSync(teamDir, { recursive: true });

	const res = await runTeamsHook({
		invocation: {
			event: "task_completed",
			teamId,
			teamDir,
			taskListId: teamId,
			style: "pirate",
			memberName: "agent1",
			timestamp: new Date().toISOString(),
			completedTask: {
				id: "1",
				subject: "Test task",
				description: "",
				owner: "agent1",
				status: "completed",
				blocks: [],
				blockedBy: [],
				metadata: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		},
		cwd: tmpRoot,
	});

	assert(res.ran === true, "runs on_task_completed hook");
	assert(res.exitCode === 0, "hook exit code is 0");
	assertEq(res.contractVersion, HOOK_CONTRACT_VERSION, "result includes contract version");
	assert(fs.existsSync(outFile), "hook wrote output file");
	const hookOutRaw = fs.readFileSync(outFile, "utf8").trim();
	const hookOut = JSON.parse(hookOutRaw) as {
		contextVersion: string | null;
		contextJson: string | null;
		event: string | null;
		taskId: string | null;
	};
	assertEq(hookOut.contextVersion, "1", "hook context version env is set");
	assertEq(hookOut.event, "task_completed", "hook event env is set");
	assertEq(hookOut.taskId, "1", "hook task id env is set");
	const hookContext = JSON.parse(hookOut.contextJson ?? "{}") as {
		version?: number;
		event?: string;
		task?: { id?: string; status?: string } | null;
	};
	assertEq(hookContext.version, 1, "hook context payload version is 1");
	assertEq(hookContext.event, "task_completed", "hook context payload includes event");
	assertEq(hookContext.task?.id, "1", "hook context payload includes task id");
	assertEq(hookContext.task?.status, "completed", "hook context payload includes task status");

	assertEq(getTeamsHookFailureAction({}), "warn", "hook failure action defaults to warn");
	assertEq(
		getTeamsHookFailureAction({ PI_TEAMS_HOOKS_FAILURE_ACTION: "reopen_followup" }),
		"reopen_followup",
		"hook failure action reads explicit env",
	);
	assertEq(
		getTeamsHookFailureAction({ PI_TEAMS_HOOKS_CREATE_TASK_ON_FAILURE: "1" }),
		"followup",
		"legacy hook followup env maps to followup action",
	);
	assert(shouldCreateHookFollowupTask("followup"), "followup action creates follow-up task");
	assert(shouldCreateHookFollowupTask("reopen_followup"), "reopen_followup action creates follow-up task");
	assert(shouldReopenTaskOnHookFailure("reopen"), "reopen action reopens completed task");
	assert(shouldReopenTaskOnHookFailure("reopen_followup"), "reopen_followup action reopens completed task");
	assertEq(getTeamsHookFollowupOwnerPolicy({}), "member", "hook follow-up owner policy defaults to member");
	assertEq(getTeamsHookFollowupOwnerPolicy({ PI_TEAMS_HOOKS_FOLLOWUP_OWNER: "lead" }), "lead", "hook follow-up owner policy reads env");
	assertEq(resolveTeamsHookFollowupOwner({ policy: "member", memberName: "agent1", leadName: "team-lead" }), "agent1", "member policy resolves to member");
	assertEq(resolveTeamsHookFollowupOwner({ policy: "member", leadName: "team-lead" }), "team-lead", "member policy falls back to lead");
	assertEq(resolveTeamsHookFollowupOwner({ policy: "none", memberName: "agent1", leadName: "team-lead" }), undefined, "none policy clears follow-up owner");
	assertEq(getTeamsHookMaxReopensPerTask({}), 3, "hook max reopens default is 3");
	assertEq(getTeamsHookMaxReopensPerTask({ PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK: "0" }), 0, "hook max reopens supports zero");

	// contract version constant
	assert(typeof HOOK_CONTRACT_VERSION === "number", "HOOK_CONTRACT_VERSION is a number");
	assert(HOOK_CONTRACT_VERSION >= 1, "HOOK_CONTRACT_VERSION >= 1");
	assert(Number.isInteger(HOOK_CONTRACT_VERSION), "HOOK_CONTRACT_VERSION is an integer");

	// buildHookContextPayload produces correct shape
	const payload = buildHookContextPayload({
		event: "task_completed",
		teamId: "test-team",
		teamDir: "/tmp/test",
		taskListId: "test-tl",
		style: "normal",
		memberName: "agent1",
		timestamp: "2025-01-01T00:00:00Z",
		completedTask: {
			id: "42",
			subject: "Test subject",
			description: "Test desc",
			owner: "agent1",
			status: "completed",
			blocks: ["43"],
			blockedBy: [],
			metadata: { result: "ok" },
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
		},
	});
	assertEq(payload.version, HOOK_CONTRACT_VERSION, "payload version matches constant");
	assertEq(payload.event, "task_completed", "payload event correct");
	assertEq(payload.team.id, "test-team", "payload team.id correct");
	assertEq(payload.member, "agent1", "payload member correct");
	assertEq(payload.task?.id, "42", "payload task.id correct");
	assertEq(payload.task?.owner, "agent1", "payload task.owner correct");
	assertEq(payload.task?.blocks.at(0), "43", "payload task.blocks preserved");

	// null task for idle events
	const idlePayload = buildHookContextPayload({
		event: "idle",
		teamId: "test-team",
		teamDir: "/tmp/test",
		taskListId: "test-tl",
		style: "normal",
	});
	assertEq(idlePayload.task, null, "idle payload has null task");
	assertEq(idlePayload.member, null, "idle payload has null member when not provided");

	// disabled hooks still return contract version
	const disabledRes = await runTeamsHook({
		invocation: {
			event: "idle",
			teamId: "noop",
			teamDir: "/tmp/noop",
			taskListId: "noop",
			style: "normal",
		},
		cwd: tmpRoot,
		env: { PI_TEAMS_HOOKS_ENABLED: "0" },
	});
	assertEq(disabledRes.ran, false, "disabled hooks do not run");
	assertEq(disabledRes.contractVersion, HOOK_CONTRACT_VERSION, "disabled hooks still report contract version");

	// restore env
	if (prevRoot === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = prevRoot;
	if (prevEnabled === undefined) delete process.env.PI_TEAMS_HOOKS_ENABLED;
	else process.env.PI_TEAMS_HOOKS_ENABLED = prevEnabled;
}

// ── 10. team discovery + attach claims ──────────────────────────────
console.log("\n10. team discovery + attach claims");
{
	const discoverRoot = path.join(tmpRoot, "discover-root");
	const aDir = path.join(discoverRoot, "team-a");
	const bDir = path.join(discoverRoot, "team-b");
	fs.mkdirSync(path.join(discoverRoot, "_styles"), { recursive: true });

	await ensureTeamConfig(aDir, {
		teamId: "team-a",
		taskListId: "tasks-a",
		leadName: "team-lead",
		style: "normal",
	});
	await ensureTeamConfig(bDir, {
		teamId: "team-b",
		taskListId: "tasks-b",
		leadName: "team-lead",
		style: "pirate",
	});
	await upsertMember(bDir, {
		name: "agent1",
		role: "worker",
		status: "online",
	});

	const claimA = await acquireTeamAttachClaim(aDir, "session-a");
	assert(claimA.ok, "acquireTeamAttachClaim succeeds for first claimant");
	const claimB = await acquireTeamAttachClaim(aDir, "session-b");
	assert(!claimB.ok, "acquireTeamAttachClaim blocks second claimant without force");
	const heartbeatA = await heartbeatTeamAttachClaim(aDir, "session-a");
	assertEq(heartbeatA, "updated", "heartbeat updates owner claim");
	const heartbeatB = await heartbeatTeamAttachClaim(aDir, "session-b");
	assertEq(heartbeatB, "not_owner", "heartbeat rejects non-owner");
	const releaseB = await releaseTeamAttachClaim(aDir, "session-b");
	assertEq(releaseB, "not_owner", "release rejects non-owner");
	const releaseA = await releaseTeamAttachClaim(aDir, "session-a");
	assertEq(releaseA, "released", "release succeeds for owner");

	const staleCheck = assessAttachClaimFreshness(
		{
			holderSessionId: "session-stale",
			claimedAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 90_000).toISOString(),
			pid: 123,
		},
	);
	assert(staleCheck.isStale, "assessAttachClaimFreshness marks old heartbeat as stale");

	await acquireTeamAttachClaim(bDir, "session-c");
	const discovered = await listDiscoveredTeams(discoverRoot);
	assert(discovered.some((t) => t.teamId === "team-a"), "discovers first team");
	assert(discovered.some((t) => t.teamId === "team-b"), "discovers second team");
	assert(!discovered.some((t) => t.teamId.startsWith("_")), "ignores internal directories");
	const b = discovered.find((t) => t.teamId === "team-b");
	assert(b !== undefined, "team-b discovered");
	if (b) {
		assertEq(b.taskListId, "tasks-b", "discovered taskListId");
		assertEq(b.style, "pirate", "discovered style");
		assertEq(b.onlineWorkerCount, 1, "discovered online worker count");
		assertEq(b.attachedBySessionId, "session-c", "discovered attach claim owner");
	}
}

// ── 10b. branched sessions + inherited attach claims ────────────────
console.log("\n10b. branched sessions + inherited attach claims");
{
	const sessionsDir = path.join(tmpRoot, "branch-session-test");
	const parent = SessionManager.create(tmpRoot, sessionsDir);
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	parent.appendMessage(assistantMessage);
	const parentLeafId = parent.getLeafId();
	const originalParentSessionId = parent.getSessionId();
	assert(parentLeafId !== null, "branch test parent has a leaf entry");
	if (parentLeafId) {
		const branchedPath = parent.createBranchedSession(parentLeafId);
		assert(branchedPath !== null, "createBranchedSession returns child session path");
		if (branchedPath) {
			const child = SessionManager.open(branchedPath, sessionsDir);
			const parentSessionId = getParentSessionId(child);
			assertEq(parentSessionId, originalParentSessionId, "getParentSessionId resolves branch parent session id");
			assert(
				shouldSilenceInheritedParentAttachClaimWarning({
					currentTeamId: originalParentSessionId,
					parentSessionId,
					result: "missing",
				}),
				"silences missing inherited parent-team claim warnings",
			);
			assert(
				!shouldSilenceInheritedParentAttachClaimWarning({
					currentTeamId: originalParentSessionId,
					parentSessionId,
					result: "not_owner",
				}),
				"keeps non-owner inherited parent-team warnings visible",
			);
			assert(
				!shouldSilenceInheritedParentAttachClaimWarning({
					currentTeamId: child.getSessionId(),
					parentSessionId,
					result: "missing",
				}),
				"does not silence unrelated missing-claim warnings",
			);
		}
	}

	const branchFromUser = SessionManager.create(tmpRoot, sessionsDir);
	branchFromUser.appendModelChange("openai-codex", "gpt-5.4");
	branchFromUser.appendThinkingLevelChange("minimal");
	branchFromUser.appendMessage({
		role: "user",
		content: [{ type: "text", text: "What should we do next?" }],
		timestamp: Date.now(),
	});
	const stableAssistantId = branchFromUser.appendMessage(assistantMessage);
	const currentUserId = branchFromUser.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Investigate something, then delegate it." }],
		timestamp: Date.now(),
	});
	const activeTurnToolUse: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	branchFromUser.appendMessage(activeTurnToolUse);
	branchFromUser.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: Date.now(),
	});
	const unfinishedLeafId = branchFromUser.getLeafId();
	assert(unfinishedLeafId !== null, "unfinished branch test leaf exists");
	if (unfinishedLeafId) {
		const selection = resolveBranchLeafSelection(branchFromUser.getBranch(unfinishedLeafId), unfinishedLeafId);
		assert(selection.adjusted, "unfinished turn adjusts branch leaf away from active leaf");
		assertEq(selection.leafId, stableAssistantId, "unfinished turn branches from latest completed assistant message");
		assertEq(branchSelectionNote(selection), "branch(clean-turn)", "unfinished turn note marks clean-turn branch");
		assert(
			selection.replayUserMessage?.role === "user",
			"unfinished turn keeps the active user request available for replay into the child branch",
		);

		const branchedPath = branchFromUser.createBranchedSession(selection.leafId);
		assert(branchedPath !== null, "clean-turn branch session created");
		if (selection.replayUserMessage) {
			branchFromUser.appendMessage(JSON.parse(JSON.stringify(selection.replayUserMessage)) as Parameters<typeof branchFromUser.appendMessage>[0]);
		}
		if (branchedPath) await ensureSessionFileMaterialized(branchFromUser, branchedPath);
		const childEntries = branchFromUser.getEntries();
		assert(childEntries.some((entry) => entry.id === stableAssistantId), "clean-turn child keeps latest completed assistant");
		assert(
			childEntries.some(
				(entry) =>
					entry.type === "message" &&
					isRecord(entry.message) &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("Investigate something, then delegate it."),
			),
			"clean-turn child replays the active user request onto the cleaned branch",
		);
		assert(
			childEntries.filter((entry) => entry.id === currentUserId).length === 0,
			"clean-turn child does not keep the original unfinished-turn user entry id",
		);
		assert(
			!childEntries.some((entry) => entry.type === "message" && isRecord(entry.message) && entry.message.role === "toolResult"),
			"clean-turn child excludes trailing tool results from active turn",
		);
		assert(
			!childEntries.some(
				(entry) =>
					entry.type === "message" &&
					isRecord(entry.message) &&
					entry.message.role === "assistant" &&
					entry.id !== stableAssistantId,
			),
			"clean-turn child excludes in-progress assistant tool-use turn",
		);
	}

	const compactedTurn = SessionManager.create(tmpRoot, sessionsDir);
	compactedTurn.appendModelChange("openai-codex", "gpt-5.4");
	compactedTurn.appendThinkingLevelChange("minimal");
	compactedTurn.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Earlier request" }],
		timestamp: Date.now(),
	});
	const compactedAssistantId = compactedTurn.appendMessage(assistantMessage);
	const compactionId = compactedTurn.appendCompaction("summarized", compactedAssistantId, 1234);
	compactedTurn.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Current request after compaction" }],
		timestamp: Date.now(),
	});
	compactedTurn.appendMessage(activeTurnToolUse);
	compactedTurn.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: Date.now(),
	});
	const compactedLeafId = compactedTurn.getLeafId();
	assert(compactedLeafId !== null, "compacted branch test leaf exists");
	if (compactedLeafId) {
		const selection = resolveBranchLeafSelection(compactedTurn.getBranch(compactedLeafId), compactedLeafId);
		assert(selection.adjusted, "compacted unfinished turn adjusts branch leaf");
		assertEq(selection.leafId, compactionId, "compacted unfinished turn branches from the entry immediately before the active user");
		assert(selection.replayUserMessage?.role === "user", "compacted unfinished turn replays the active user request");
		const branchedPath = compactedTurn.createBranchedSession(selection.leafId);
		assert(branchedPath !== null, "compacted branch session created");
		if (selection.replayUserMessage) {
			compactedTurn.appendMessage(JSON.parse(JSON.stringify(selection.replayUserMessage)) as Parameters<typeof compactedTurn.appendMessage>[0]);
		}
		const childEntries = compactedTurn.getEntries();
		assert(childEntries.some((entry) => entry.id === compactionId), "compacted child keeps the compaction entry before the active user");
		assert(
			childEntries.some(
				(entry) =>
					entry.type === "message" &&
					isRecord(entry.message) &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("Current request after compaction"),
			),
			"compacted child replays the active user after the preserved compaction boundary",
		);
		assertEq(branchSelectionNote(selection), "branch(clean-turn)", "compacted unfinished turn keeps clean-turn note");
	}

	const userOnlyTurn = SessionManager.create(tmpRoot, sessionsDir);
	userOnlyTurn.appendModelChange("openai-codex", "gpt-5.4");
	userOnlyTurn.appendThinkingLevelChange("minimal");
	userOnlyTurn.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Only user context so far" }],
		timestamp: Date.now(),
	});
	userOnlyTurn.appendMessage(activeTurnToolUse);
	userOnlyTurn.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: Date.now(),
	});
	const userOnlyLeafId = userOnlyTurn.getLeafId();
	assert(userOnlyLeafId !== null, "user-only fallback test leaf exists");
	if (userOnlyLeafId) {
		const selection = resolveBranchLeafSelection(userOnlyTurn.getBranch(userOnlyLeafId), userOnlyLeafId);
		assert(selection.adjusted, "user-only unfinished turn still adjusts branch leaf");
		assert(selection.leafId !== userOnlyLeafId, "user-only fallback rewinds away from the active unfinished leaf");
		assert(selection.replayUserMessage?.role === "user", "user-only fallback keeps the active user message for replay");
		assertEq(branchSelectionNote(selection), "branch(clean-turn)", "user-only fallback keeps the clean-turn note");
		const branchedPath = userOnlyTurn.createBranchedSession(selection.leafId);
		assert(branchedPath !== null, "user-only fallback branch session created");
		if (selection.replayUserMessage) {
			userOnlyTurn.appendMessage(JSON.parse(JSON.stringify(selection.replayUserMessage)) as Parameters<typeof userOnlyTurn.appendMessage>[0]);
		}
		if (branchedPath) {
			await ensureSessionFileMaterialized(userOnlyTurn, branchedPath);
			assert(fs.existsSync(branchedPath), "user-only fallback materializes a real session file");
		}
	}

	const completedTurn = SessionManager.create(tmpRoot, sessionsDir);
	completedTurn.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Done already" }],
		timestamp: Date.now(),
	});
	const completedAssistantId = completedTurn.appendMessage(assistantMessage);
	const completedLeafId = completedTurn.getLeafId();
	assert(completedLeafId !== null, "completed branch test leaf exists");
	if (completedLeafId) {
		const selection = resolveBranchLeafSelection(completedTurn.getBranch(completedLeafId), completedLeafId);
		assert(!selection.adjusted, "completed turn keeps requested leaf");
		assertEq(selection.leafId, completedLeafId, "completed turn branches from current leaf");
		assertEq(completedAssistantId, completedLeafId, "completed leaf stays on assistant reply");
		assertEq(branchSelectionNote(selection), "branch", "completed turn keeps plain branch note");
	}
}

// ── 11. /team done (end-of-run cleanup) ──────────────────────────────
console.log("\n11. /team done (end-of-run)");
{
	const doneDir = path.join(tmpRoot, "done-test");
	const doneTeamId = "done-team";
	const doneTeamDir = path.join(doneDir, doneTeamId);
	const doneTlId = doneTeamId;

	await ensureTeamConfig(doneTeamDir, { teamId: doneTeamId, taskListId: doneTlId, leadName: "team-lead", style: "normal" });
	await upsertMember(doneTeamDir, { name: "alice", role: "worker", status: "online" });
	await upsertMember(doneTeamDir, { name: "bob", role: "worker", status: "online" });

	// Create tasks and mark all completed
	const t1 = await createTask(doneTeamDir, doneTlId, { subject: "Task 1", description: "", owner: "alice" });
	const t2 = await createTask(doneTeamDir, doneTlId, { subject: "Task 2", description: "", owner: "bob" });
	await completeTask(doneTeamDir, doneTlId, t1.id, "alice");
	await completeTask(doneTeamDir, doneTlId, t2.id, "bob");

	const doneTasks = await listTasks(doneTeamDir, doneTlId);
	const allCompleted = doneTasks.every((t) => t.status === "completed");
	assert(allCompleted, "/team done precondition: all tasks completed");
	assertEq(doneTasks.length, 2, "/team done: 2 tasks exist");

	// Mark workers offline (simulating what /team done does)
	await setMemberStatus(doneTeamDir, "alice", "offline", { meta: { stoppedReason: "team-done" } });
	await setMemberStatus(doneTeamDir, "bob", "offline", { meta: { stoppedReason: "team-done" } });

	const cfgAfter = await loadTeamConfig(doneTeamDir);
	const onlineAfter = (cfgAfter?.members ?? []).filter((m) => m.role === "worker" && m.status === "online");
	assertEq(onlineAfter.length, 0, "/team done: all workers offline after done");

	const offlineAlice = cfgAfter?.members.find((m) => m.name === "alice");
	assert(offlineAlice?.meta?.["stoppedReason"] === "team-done", "/team done: alice has stoppedReason=team-done");

	// Test force-done with in-progress tasks (simulates --force path)
	const forceDir = path.join(tmpRoot, "force-done-test");
	const forceTeamId = "force-done-team";
	const forceTeamDir = path.join(forceDir, forceTeamId);
	const forceTlId = forceTeamId;

	await ensureTeamConfig(forceTeamDir, { teamId: forceTeamId, taskListId: forceTlId, leadName: "team-lead", style: "normal" });
	await upsertMember(forceTeamDir, { name: "carol", role: "worker", status: "online" });

	const ft1 = await createTask(forceTeamDir, forceTlId, { subject: "Ongoing work", description: "", owner: "carol" });
	await startAssignedTask(forceTeamDir, forceTlId, ft1.id, "carol");

	const forceTasks = await listTasks(forceTeamDir, forceTlId);
	assertEq(forceTasks[0]?.status, "in_progress", "/team done --force precondition: task in_progress");

	// Simulate force-done: unassign in-progress tasks
	await unassignTasksForAgent(forceTeamDir, forceTlId, "carol", "team done");
	await setMemberStatus(forceTeamDir, "carol", "offline", { meta: { stoppedReason: "team-done" } });

	const forceTasksAfter = await listTasks(forceTeamDir, forceTlId);
	assertEq(forceTasksAfter[0]?.status, "pending", "/team done --force: in-progress task reset to pending");
	assertEq(forceTasksAfter[0]?.owner, undefined, "/team done --force: in-progress task unassigned");

	const forceCfgAfter = await loadTeamConfig(forceTeamDir);
	const forceCarol = forceCfgAfter?.members.find((m) => m.name === "carol");
	assertEq(forceCarol?.status, "offline", "/team done --force: worker offline");

	// Test idempotency: calling done again on already-done team is safe
	await setMemberStatus(doneTeamDir, "alice", "offline", { meta: { stoppedReason: "team-done" } });
	await setMemberStatus(doneTeamDir, "bob", "offline", { meta: { stoppedReason: "team-done" } });
	const idempotentCfg = await loadTeamConfig(doneTeamDir);
	const idempotentOnline = (idempotentCfg?.members ?? []).filter((m) => m.role === "worker" && m.status === "online");
	assertEq(idempotentOnline.length, 0, "/team done idempotent: still 0 online after second done");
	const idempotentTasks = await listTasks(doneTeamDir, doneTlId);
	const idempotentAllDone = idempotentTasks.every((t) => t.status === "completed");
	assert(idempotentAllDone, "/team done idempotent: tasks still completed after second done");
}

// ── 12. isTeamDone (pure function unit tests) ───────────────────────
console.log("\n12. isTeamDone");
{
	// Minimal mock: isTeamDone only reads .status from TeammateRpc values
	type MockRpc = { status: string };
	const mockMap = (entries: Array<[string, MockRpc]>) =>
		new Map(entries) as unknown as ReadonlyMap<string, import("../extensions/teams/teammate-rpc.js").TeammateRpc>;

	const completedTask = (id: string): import("../extensions/teams/task-store.js").TeamTask => ({
		id, subject: "x", description: "", status: "completed",
		blocks: [], blockedBy: [], metadata: {}, createdAt: "", updatedAt: "",
	});
	const pendingTask = (id: string): import("../extensions/teams/task-store.js").TeamTask => ({
		id, subject: "x", description: "", status: "pending",
		blocks: [], blockedBy: [], metadata: {}, createdAt: "", updatedAt: "",
	});
	const inProgressTask = (id: string): import("../extensions/teams/task-store.js").TeamTask => ({
		id, subject: "x", description: "", status: "in_progress",
		blocks: [], blockedBy: [], metadata: {}, createdAt: "", updatedAt: "",
	});

	// No tasks → not done
	assert(!isTeamDone([], mockMap([])), "isTeamDone: empty tasks = false");

	// All completed, no teammates → done
	assert(isTeamDone([completedTask("1"), completedTask("2")], mockMap([])), "isTeamDone: all completed, no teammates = true");

	// All completed, all idle → done
	assert(
		isTeamDone([completedTask("1")], mockMap([["alice", { status: "idle" }]])),
		"isTeamDone: all completed + idle teammate = true",
	);

	// All completed, one streaming → not done
	assert(
		!isTeamDone([completedTask("1")], mockMap([["alice", { status: "streaming" }]])),
		"isTeamDone: all completed + streaming teammate = false",
	);

	// All completed, one starting → not done
	assert(
		!isTeamDone([completedTask("1")], mockMap([["alice", { status: "starting" }]])),
		"isTeamDone: all completed + starting teammate = false",
	);

	// All completed, stopped teammate → done
	assert(
		isTeamDone([completedTask("1")], mockMap([["alice", { status: "stopped" }]])),
		"isTeamDone: all completed + stopped teammate = true",
	);

	// Pending task → not done
	assert(
		!isTeamDone([completedTask("1"), pendingTask("2")], mockMap([])),
		"isTeamDone: one pending = false",
	);

	// In-progress task → not done
	assert(
		!isTeamDone([completedTask("1"), inProgressTask("2")], mockMap([])),
		"isTeamDone: one in-progress = false",
	);

	// Mixed: all completed, mixed teammate states (idle + stopped) → done
	assert(
		isTeamDone(
			[completedTask("1"), completedTask("2")],
			mockMap([["alice", { status: "idle" }], ["bob", { status: "stopped" }]]),
		),
		"isTeamDone: all completed + idle+stopped = true",
	);
}

// ── 13. formatElapsed + lastMessageSummary ───────────────────────────
console.log("\n13. formatElapsed + lastMessageSummary");
{
	assert(formatElapsed(500) === "0s", "formatElapsed <1s rounds to 0s");
	assert(formatElapsed(1000) === "1s", "formatElapsed 1s");
	assert(formatElapsed(45000) === "45s", "formatElapsed 45s");
	assert(formatElapsed(90000) === "1m30s", "formatElapsed 1m30s");
	assert(formatElapsed(120000) === "2m", "formatElapsed 2m exact");
	assert(formatElapsed(3600000) === "1h", "formatElapsed 1h exact");
	assert(formatElapsed(3660000) === "1h1m", "formatElapsed 1h1m");

	// lastMessageSummary with undefined rpc
	assert(lastMessageSummary(undefined) === "", "lastMessageSummary(undefined) is empty");

	// lastMessageSummary with mock rpc-like object (only lastAssistantText matters)
	const mockRpc = { lastAssistantText: "Hello world, this is a test" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const summary = lastMessageSummary(mockRpc, 20);
	assert(summary.length <= 20, "lastMessageSummary respects maxLen");
	assert(summary.endsWith("…"), "lastMessageSummary truncates with ellipsis");

	const shortRpc = { lastAssistantText: "Short" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	assert(lastMessageSummary(shortRpc, 20) === "Short", "lastMessageSummary keeps short text intact");
}

// ── 14. leader-inbox LLM message injection ───────────────────────────
console.log("\n14. leader-inbox LLM message injection");
{
	const inboxTeamDir = path.join(tmpRoot, "inbox-test");
	const inboxTaskListId = "inbox-tl";
	const leadName = "team-lead";
	const style = "default";

	// Set up team config
	await ensureTeamConfig(inboxTeamDir, { teamId: "inbox-team", taskListId: inboxTaskListId, leadName, style });

	// Create and complete a task with a result
	const t1 = await createTask(inboxTeamDir, inboxTaskListId, { subject: "Fix tests", description: "", owner: "alice" });
	await completeTask(inboxTeamDir, inboxTaskListId, t1.id, "alice", "All 12 tests passing");

	// Write an idle notification with completedTaskId
	const ts = new Date().toISOString();
	await writeToMailbox(inboxTeamDir, TEAM_MAILBOX_NS, leadName, {
		from: "alice",
		text: JSON.stringify({
			type: "idle_notification",
			from: "alice",
			timestamp: ts,
			completedTaskId: t1.id,
			completedStatus: "completed",
		}),
		timestamp: ts,
	});

	// Track messages sent to leader LLM
	const llmMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];

	// Minimal ExtensionContext stub
	const stubCtx = {
		cwd: inboxTeamDir,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "inbox-team" },
		isIdle: () => false,
	} as unknown as ExtensionContext;

	await pollLeaderInbox({
		ctx: stubCtx,
		teamId: "inbox-team",
		teamDir: inboxTeamDir,
		taskListId: inboxTaskListId,
		leadName,
		style,
		pendingPlanApprovals: new Map(),
		sendLeaderLlmMessage: (content, options) => {
			llmMessages.push({ content, options });
		},
	});

	assert(llmMessages.length === 1, "one LLM message sent on task completion");
	const msg0 = llmMessages[0];
	if (msg0) {
		assert(msg0.content.includes("[Team]"), "LLM message has [Team] prefix");
		assert(msg0.content.includes("alice"), "LLM message includes worker name");
		assert(msg0.content.includes(t1.id), "LLM message includes task id");
		assert(msg0.content.includes("Fix tests"), "LLM message includes task subject");
		assert(msg0.content.includes("All 12 tests passing"), "LLM message includes result");
		assert(msg0.content.includes("All 1 task(s) are now completed"), "LLM message includes allDone summary");
		assertEq(msg0.options?.deliverAs, "followUp", "LLM message uses followUp delivery");
	}

	// Test failure path with abort metadata
	const t2 = await createTask(inboxTeamDir, inboxTaskListId, { subject: "Deploy staging", description: "", owner: "bob" });
	await updateTask(inboxTeamDir, inboxTaskListId, t2.id, (cur) => ({
		...cur,
		status: "pending",
		metadata: {
			...(cur.metadata ?? {}),
			abortReason: "timeout after 60s",
			partialResult: "Deployed but health check failed",
		},
	}));

	const ts2 = new Date().toISOString();
	await writeToMailbox(inboxTeamDir, TEAM_MAILBOX_NS, leadName, {
		from: "bob",
		text: JSON.stringify({
			type: "idle_notification",
			from: "bob",
			timestamp: ts2,
			completedTaskId: t2.id,
			completedStatus: "failed",
		}),
		timestamp: ts2,
	});

	llmMessages.length = 0;
	await pollLeaderInbox({
		ctx: stubCtx,
		teamId: "inbox-team",
		teamDir: inboxTeamDir,
		taskListId: inboxTaskListId,
		leadName,
		style,
		pendingPlanApprovals: new Map(),
		sendLeaderLlmMessage: (content, options) => {
			llmMessages.push({ content, options });
		},
	});

	assert(llmMessages.length === 1, "one LLM message sent on task failure");
	const failMsg = llmMessages[0];
	if (failMsg) {
		assert(failMsg.content.includes("failed"), "failure LLM message includes failed");
		assert(failMsg.content.includes("timeout after 60s"), "failure LLM message includes abortReason");
		assert(failMsg.content.includes("health check failed"), "failure LLM message includes partialResult");
	}

	// Test hook-aware allDone qualifier
	const t3 = await createTask(inboxTeamDir, inboxTaskListId, { subject: "Final task", description: "", owner: "carol" });
	await completeTask(inboxTeamDir, inboxTaskListId, t3.id, "carol", "Done");
	// Also complete t2 so all tasks are done
	await updateTask(inboxTeamDir, inboxTaskListId, t2.id, (cur) => ({
		...cur,
		status: "completed",
		owner: "bob",
	}));

	const ts3 = new Date().toISOString();
	await writeToMailbox(inboxTeamDir, TEAM_MAILBOX_NS, leadName, {
		from: "carol",
		text: JSON.stringify({
			type: "idle_notification",
			from: "carol",
			timestamp: ts3,
			completedTaskId: t3.id,
			completedStatus: "completed",
		}),
		timestamp: ts3,
	});

	llmMessages.length = 0;
	await pollLeaderInbox({
		ctx: stubCtx,
		teamId: "inbox-team",
		teamDir: inboxTeamDir,
		taskListId: inboxTaskListId,
		leadName,
		style,
		pendingPlanApprovals: new Map(),
		enqueueHook: () => {},
		hooksEnabled: true,
		sendLeaderLlmMessage: (content, options) => {
			llmMessages.push({ content, options });
		},
	});

	assert(llmMessages.length === 1, "one LLM message sent with hooks active");
	const hookMsg = llmMessages[0];
	if (hookMsg) {
		assert(hookMsg.content.includes("quality gates are still running"), "allDone qualified when hooks active");
		assert(!hookMsg.content.includes("Review results and determine next steps"), "no premature wrap-up prompt when hooks active");
	}

	// Hooks disabled should not qualify all-done messages just because a callback is wired.
	const t4 = await createTask(inboxTeamDir, inboxTaskListId, { subject: "Post-review cleanup", description: "", owner: "dave" });
	await completeTask(inboxTeamDir, inboxTaskListId, t4.id, "dave", "Cleanup complete");
	const ts4 = new Date().toISOString();
	await writeToMailbox(inboxTeamDir, TEAM_MAILBOX_NS, leadName, {
		from: "dave",
		text: JSON.stringify({
			type: "idle_notification",
			from: "dave",
			timestamp: ts4,
			completedTaskId: t4.id,
			completedStatus: "completed",
		}),
		timestamp: ts4,
	});

	llmMessages.length = 0;
	await pollLeaderInbox({
		ctx: stubCtx,
		teamId: "inbox-team",
		teamDir: inboxTeamDir,
		taskListId: inboxTaskListId,
		leadName,
		style,
		pendingPlanApprovals: new Map(),
		enqueueHook: () => {},
		hooksEnabled: false,
		sendLeaderLlmMessage: (content, options) => {
			llmMessages.push({ content, options });
		},
	});

	assert(llmMessages.length === 1, "one LLM message sent when hooks callback is wired but disabled");
	const disabledHookMsg = llmMessages[0];
	if (disabledHookMsg) {
		assert(!disabledHookMsg.content.includes("quality gates are still running"), "disabled hooks do not qualify the per-task allDone summary");
		assert(disabledHookMsg.content.includes("Review results and determine next steps"), "disabled hooks keep the normal per-task allDone summary");
	}

	// Batch-complete auto-wake should use the same hooks-enabled check.
	const t5 = await createTask(inboxTeamDir, inboxTaskListId, { subject: "Batch wake task", description: "", owner: "erin" });
	await completeTask(inboxTeamDir, inboxTaskListId, t5.id, "erin", "Batch wake done");
	const ts5 = new Date().toISOString();
	await writeToMailbox(inboxTeamDir, TEAM_MAILBOX_NS, leadName, {
		from: "erin",
		text: JSON.stringify({
			type: "idle_notification",
			from: "erin",
			timestamp: ts5,
			completedTaskId: t5.id,
			completedStatus: "completed",
		}),
		timestamp: ts5,
	});

	const batchTracker = new DelegationTracker();
	batchTracker.addBatch([t5.id]);
	llmMessages.length = 0;
	await pollLeaderInbox({
		ctx: stubCtx,
		teamId: "inbox-team",
		teamDir: inboxTeamDir,
		taskListId: inboxTaskListId,
		leadName,
		style,
		pendingPlanApprovals: new Map(),
		enqueueHook: () => {},
		hooksEnabled: false,
		delegationTracker: batchTracker,
		sendLeaderLlmMessage: (content, options) => {
			llmMessages.push({ content, options });
		},
	});

	assert(llmMessages.length === 2, "per-task completion plus batch-complete messages sent when a tracked delegation finishes");
	const batchMsg = llmMessages.find((entry) => entry.content.includes("All delegated tasks completed"));
	assert(batchMsg !== undefined, "batch-complete notification sent");
	if (batchMsg) {
		assert(!batchMsg.content.includes("Quality gates are still running"), "disabled hooks do not qualify the batch-complete summary");
		assert(batchMsg.content.includes("Review the results and continue."), "disabled hooks keep the normal batch-complete summary");
	}
}

// ── 15. non-blocking wait tracker ───────────────────────────────────
console.log("\n15. non-blocking wait tracker");
{
	const waitTracker = new TeamWaitTracker();
	const teamId = "wait-team";
	const taskListId = "wait-tl";
	const name = "alice";
	const now = 1_000_000;
	const liveRpc = {
		status: "streaming",
		lastEventAt: now - 100,
		lastError: null,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const teammates = new Map([[name, liveRpc]]);

	// Exercise the registered teams tool directly with the smallest possible Pi
	// fixture. This keeps the action contract covered without starting a Pi RPC
	// child process.
	type CapturedTeamsTool = {
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal,
			onUpdate: () => void,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	};
	const capturedTeamsTool: { value: CapturedTeamsTool | null } = { value: null };
	const actionWaitTracker = new TeamWaitTracker();
	const actionTeamId = "wait-action-team";
	const actionTaskListId = "wait-action-tl";
	const terminalRpc = { ...liveRpc, name: "dave", status: "idle" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const actionTeammates = new Map<string, import("../extensions/teams/teammate-rpc.js").TeammateRpc>([
		["alice", liveRpc],
		["bob", { ...liveRpc, name: "bob" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc],
		["carol", { ...liveRpc, name: "carol" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc],
		["dave", terminalRpc],
	]);
	const savedActionTeamsRoot = process.env.PI_TEAMS_ROOT_DIR;
	const savedActionStallThreshold = process.env.PI_TEAMS_STALL_THRESHOLD_MS;
	let waitRegistrationInvalidations = 0;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;
	try {
		registerTeamsTool({
			pi: {
				registerTool: (tool: unknown) => {
					capturedTeamsTool.value = tool as CapturedTeamsTool;
				},
			} as unknown as ExtensionAPI,
			teammates: actionTeammates,
			spawnTeammate: (async () => {
				throw new Error("spawn is outside this wait-action fixture");
			}) as unknown as import("../extensions/teams/spawn-types.js").SpawnTeammateFn,
			getTeamId: () => actionTeamId,
			getTaskListId: () => actionTaskListId,
			getTracker: () => new ActivityTracker(),
			getTeamConfig: () => null,
			refreshTasks: async () => {},
			renderWidget: () => {},
			hideWidget: () => {},
			stopAllTeammates: async () => {},
			pendingPlanApprovals: new Map(),
			waitTracker: actionWaitTracker,
			beginWaitRegistration: () => { waitRegistrationInvalidations++; },
		});
		if (!capturedTeamsTool.value) throw new Error("teams tool was not registered");
		const teamsTool = capturedTeamsTool.value;
		const invokeWait = async (params: { name: string; stallThresholdMs?: number }) =>
			await teamsTool.execute(
				"wait-smoke",
				{ action: "wait", ...params },
				new AbortController().signal,
				() => {},
				{} as ExtensionContext,
			);

		delete process.env.PI_TEAMS_STALL_THRESHOLD_MS;
		const defaultStartedAt = Date.now();
		const defaultWait = await invokeWait({ name: "alice" });
		const defaultDetails = isRecord(defaultWait.details) ? defaultWait.details : {};
		assert(Date.now() - defaultStartedAt < 1_000, "wait action returns immediately after registering its monitor");
		assertEq(defaultDetails.nonBlocking, true, "wait action marks its result as non-blocking");
		assertEq(defaultDetails.stallThresholdMs, 300_000, "wait action defaults to a five-minute inactivity threshold");
		assertEq(waitRegistrationInvalidations, 1, "wait action invalidates a retryable wake from the prior registration before registering");

		process.env.PI_TEAMS_STALL_THRESHOLD_MS = "1234";
		const envWait = await invokeWait({ name: "bob" });
		const envDetails = isRecord(envWait.details) ? envWait.details : {};
		assertEq(envDetails.stallThresholdMs, 1234, "wait action uses PI_TEAMS_STALL_THRESHOLD_MS when no override is supplied");

		const overrideWait = await invokeWait({ name: "carol", stallThresholdMs: 321 });
		const overrideDetails = isRecord(overrideWait.details) ? overrideWait.details : {};
		assertEq(overrideDetails.stallThresholdMs, 321, "wait action lets stallThresholdMs override the environment");

		const maxThresholdWait = await invokeWait({ name: "carol", stallThresholdMs: 1_800_000 });
		const maxThresholdDetails = isRecord(maxThresholdWait.details) ? maxThresholdWait.details : {};
		assertEq(maxThresholdDetails.stallThresholdMs, 1_800_000, "wait action accepts the 30-minute stall threshold boundary");

		process.env.PI_TEAMS_STALL_THRESHOLD_MS = "1800000";
		const maxEnvThresholdWait = await invokeWait({ name: "bob" });
		const maxEnvThresholdDetails = isRecord(maxEnvThresholdWait.details) ? maxEnvThresholdWait.details : {};
		assertEq(maxEnvThresholdDetails.stallThresholdMs, 1_800_000, "wait action accepts the 30-minute environment threshold boundary");

		for (const invalidEnvThreshold of ["1800000.5", "2e6"]) {
			process.env.PI_TEAMS_STALL_THRESHOLD_MS = invalidEnvThreshold;
			const invalidEnvWait = await invokeWait({ name: "bob" });
			const invalidEnvDetails = isRecord(invalidEnvWait.details) ? invalidEnvWait.details : {};
			assertEq(invalidEnvDetails.status, "rejected", `wait action rejects non-integer environment threshold ${invalidEnvThreshold}`);
			assertEq(invalidEnvDetails.reason, "invalid_environment_stall_threshold", `wait action reports invalid environment threshold ${invalidEnvThreshold}`);
			assertEq(invalidEnvDetails.environmentValue, invalidEnvThreshold, `wait action preserves invalid environment threshold ${invalidEnvThreshold} in details`);
		}

		const tooLargeParamWait = await invokeWait({ name: "alice", stallThresholdMs: 1_800_001 });
		const tooLargeParamDetails = isRecord(tooLargeParamWait.details) ? tooLargeParamWait.details : {};
		assertEq(tooLargeParamDetails.status, "rejected", "wait action rejects a per-call threshold above thirty minutes");
		assertEq(tooLargeParamDetails.reason, "stall_threshold_exceeds_maximum", "wait action reports the parameter threshold rejection reason");
		assertEq(tooLargeParamDetails.stallThresholdSource, "params.stallThresholdMs", "wait action identifies an oversized parameter threshold");
		assertEq(tooLargeParamDetails.maximumStallThresholdMs, 1_800_000, "wait action exposes the maximum parameter threshold");

		process.env.PI_TEAMS_STALL_THRESHOLD_MS = "1800001";
		const tooLargeEnvWait = await invokeWait({ name: "bob" });
		const tooLargeEnvDetails = isRecord(tooLargeEnvWait.details) ? tooLargeEnvWait.details : {};
		assertEq(tooLargeEnvDetails.status, "rejected", "wait action rejects an environment threshold above thirty minutes");
		assertEq(tooLargeEnvDetails.reason, "stall_threshold_exceeds_maximum", "wait action reports the environment threshold rejection reason");
		assertEq(tooLargeEnvDetails.stallThresholdSource, "PI_TEAMS_STALL_THRESHOLD_MS", "wait action identifies an oversized environment threshold");
		delete process.env.PI_TEAMS_STALL_THRESHOLD_MS;

		const terminalWait = await invokeWait({ name: "dave" });
		const terminalDetails = isRecord(terminalWait.details) ? terminalWait.details : {};
		assertEq(terminalDetails.status, "watching", "wait action registers a watch for an already-idle RPC teammate");
		assertEq(terminalDetails.armedForNextRun, true, "already-idle wait is armed for the teammate's next run");
		terminalRpc.status = "streaming";
		terminalRpc.lastStatusChangeAt = Date.now();
		terminalRpc.lastEventAt = Date.now();
		assert(
			actionWaitTracker.pollRpc(actionTeamId, actionTaskListId, actionTeammates).every((wake) => wake.name !== "dave"),
			"armed idle wait observes the next run without waking immediately",
		);

		actionTeammates.delete("carol");
		const unsupportedWait = await invokeWait({ name: "carol" });
		const unsupportedDetails = isRecord(unsupportedWait.details) ? unsupportedWait.details : {};
		assertEq(unsupportedDetails.status, "unsupported", "wait action rejects manual or unknown non-RPC teammates");
	} finally {
		if (savedActionTeamsRoot === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
		else process.env.PI_TEAMS_ROOT_DIR = savedActionTeamsRoot;
		if (savedActionStallThreshold === undefined) delete process.env.PI_TEAMS_STALL_THRESHOLD_MS;
		else process.env.PI_TEAMS_STALL_THRESHOLD_MS = savedActionStallThreshold;
	}

	assertEq(
		waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 }).replaced,
		false,
		"wait registration is new the first time",
	);
	assertEq(waitTracker.pollRpc(teamId, taskListId, teammates, now), [], "wait does not block or wake while RPC is active");
	assertEq(
		waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 }).replaced,
		true,
		"repeat wait registration replaces the existing watch",
	);
	assertEq(
		waitTracker.pollRpc(teamId, taskListId, teammates, now + 400),
		[{ name, event: "stalled", stallThresholdMs: 500 }],
		"wait wakes once when rolling inactivity reaches its configured threshold",
	);
	assertEq(waitTracker.pollRpc(teamId, taskListId, teammates, now + 10_000), [], "stalled wait is consumed after one wake");

	const armedTracker = new TeamWaitTracker();
	const armedRpc = {
		...liveRpc,
		status: "idle",
		lastEventAt: now - 10_000,
		lastStatusChangeAt: now - 10_000,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const armedTeammates = new Map([[name, armedRpc]]);
	armedTracker.register({
		teamId,
		taskListId,
		name,
		stallThresholdMs: 5_000,
		registeredAt: now,
		armedForNextRun: true,
		rpcStatusChangeAtRegistration: armedRpc.lastStatusChangeAt,
	});
	assertEq(armedTracker.pollRpc(teamId, taskListId, armedTeammates, now + 4_999), [], "armed idle wait does not resolve from the pre-registration idle state");
	assertEq(
		armedTracker.pollRpc(teamId, taskListId, armedTeammates, now + 5_000),
		[{ name, event: "stalled", stallThresholdMs: 5_000 }],
		"armed idle wait wakes as stalled when its next run never starts",
	);
	assertEq(armedTracker.pollRpc(teamId, taskListId, armedTeammates, now + 10_000), [], "armed idle stall wakes exactly once");

	const armedRunTracker = new TeamWaitTracker();
	armedRunTracker.register({
		teamId,
		taskListId,
		name,
		stallThresholdMs: 5_000,
		registeredAt: now,
		armedForNextRun: true,
		rpcStatusChangeAtRegistration: armedRpc.lastStatusChangeAt,
	});
	armedRpc.status = "streaming";
	armedRpc.lastStatusChangeAt = now + 100;
	armedRpc.lastEventAt = now + 100;
	assertEq(armedRunTracker.pollRpc(teamId, taskListId, armedTeammates, now + 100), [], "armed wait transitions to watching when the next run starts");
	armedRpc.status = "idle";
	armedRpc.lastStatusChangeAt = now + 200;
	assertEq(armedRunTracker.pollRpc(teamId, taskListId, armedTeammates, now + 200), [], "next-run idle begins stable-idle grace");
	assertEq(armedRunTracker.pollRpc(teamId, taskListId, armedTeammates, now + 2_200), [{ name, event: "idle" }], "armed wait wakes once when the next run becomes idle");

	const shortRunTracker = new TeamWaitTracker();
	const shortRunBaseline = now + 20_000;
	const shortRunRpc = { ...armedRpc, status: "idle", lastStatusChangeAt: shortRunBaseline } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	shortRunTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, registeredAt: shortRunBaseline, armedForNextRun: true, rpcStatusChangeAtRegistration: shortRunBaseline });
	shortRunRpc.lastStatusChangeAt = shortRunBaseline + 100;
	assertEq(shortRunTracker.pollRpc(teamId, taskListId, new Map([[name, shortRunRpc]]), shortRunBaseline + 200), [], "a short run missed between polls is detected from its newer idle epoch");
	assertEq(shortRunTracker.pollRpc(teamId, taskListId, new Map([[name, shortRunRpc]]), shortRunBaseline + 2_200), [{ name, event: "idle" }], "a short run missed between polls still wakes exactly once");

	const armedInboxTracker = new TeamWaitTracker();
	armedInboxTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, registeredAt: now, armedForNextRun: true, rpcStatusChangeAtRegistration: now - 1 });
	const oldArmedMarker = armedInboxTracker.recordIdleNotification(teamId, taskListId, name, new Date(now - 1).toISOString());
	assertEq(armedInboxTracker.consumeIdleNotification({ teamId, taskListId, name, marker: oldArmedMarker }), { wake: null, completedTaskWatch: false, suppressCompletionNotification: false }, "delayed pre-registration idle does not consume an armed wait");
	const nextRunMarker = armedInboxTracker.recordIdleNotification(teamId, taskListId, name, new Date(now + 1).toISOString());
	assertEq(armedInboxTracker.consumeIdleNotification({ teamId, taskListId, name, marker: nextRunMarker }), { wake: { name, event: "idle" }, completedTaskWatch: false, suppressCompletionNotification: false }, "post-registration next-run idle resolves an armed wait");

	// An idle notification claimed before the wait belongs to an older run. It
	// must not resolve the new wait, which instead falls back to a stable RPC
	// idle after the grace period.
	const fallbackTracker = new TeamWaitTracker();
	const priorIdleMarker = fallbackTracker.recordIdleNotification(teamId, taskListId, name);
	fallbackTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000 });
	assertEq(
		fallbackTracker.consumeIdleNotification({ teamId, taskListId, name, marker: priorIdleMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: false },
		"idle marker from before registration does not resolve a new worker run",
	);
	assertEq(
		fallbackTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000 }).replaced,
		true,
		"old idle marker leaves the new wait registered",
	);
	const fallbackRpc = { ...liveRpc, status: "idle" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const fallbackTeammates = new Map([[name, fallbackRpc]]);
	assertEq(fallbackTracker.pollRpc(teamId, taskListId, fallbackTeammates, now), [], "stable-idle fallback starts a grace period");
	assertEq(
		fallbackTracker.pollRpc(teamId, taskListId, fallbackTeammates, now + 2_000),
		[{ name, event: "idle" }],
		"missing or pre-registration idle mailbox resolves through stable RPC idle",
	);
	assertEq(fallbackTracker.pollRpc(teamId, taskListId, fallbackTeammates, now + 4_000), [], "stable-idle fallback wakes exactly once and clears the wait");

	const transientIdleTracker = new TeamWaitTracker();
	const transientRpc = { ...liveRpc, status: "idle" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const transientTeammates = new Map([[name, transientRpc]]);
	transientIdleTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000 });
	assertEq(transientIdleTracker.pollRpc(teamId, taskListId, transientTeammates, now), [], "transient idle begins but does not immediately wake");
	transientRpc.status = "streaming";
	transientRpc.lastEventAt = now + 1;
	assertEq(transientIdleTracker.pollRpc(teamId, taskListId, transientTeammates, now + 1), [], "streaming recovery resets the idle grace period without waking");
	transientRpc.status = "idle";
	assertEq(transientIdleTracker.pollRpc(teamId, taskListId, transientTeammates, now + 2_500), [], "second idle transition starts a fresh grace period");
	assertEq(
		transientIdleTracker.pollRpc(teamId, taskListId, transientTeammates, now + 4_500),
		[{ name, event: "idle" }],
		"only the later stable idle resolves after a transient idle-to-streaming gap",
	);

	const skippedTransitionTracker = new TeamWaitTracker();
	const skippedTransitionRpc = {
		...liveRpc,
		status: "idle",
		lastStatusChangeAt: now,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const skippedTransitionTeammates = new Map([[name, skippedTransitionRpc]]);
	skippedTransitionTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000 });
	assertEq(skippedTransitionTracker.pollRpc(teamId, taskListId, skippedTransitionTeammates, now), [], "first idle epoch starts a grace period");
	// A streaming run can begin and end between refresh ticks. The current status
	// is idle again, so lastStatusChangeAt is the only observable transition.
	skippedTransitionRpc.lastStatusChangeAt = now + 1_000;
	assertEq(skippedTransitionTracker.pollRpc(teamId, taskListId, skippedTransitionTeammates, now + 2_500), [], "a changed idle epoch restarts grace after an unobserved streaming gap");
	assertEq(
		skippedTransitionTracker.pollRpc(teamId, taskListId, skippedTransitionTeammates, now + 4_500),
		[{ name, event: "idle" }],
		"the replacement idle epoch wakes only after its own grace period",
	);

	const tombstoneTracker = new TeamWaitTracker();
	const tombstoneRunStartedAt = now + 10_000;
	const tombstoneRpc = {
		...liveRpc,
		status: "idle",
		lastStatusChangeAt: tombstoneRunStartedAt + 100,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	tombstoneTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, rpcRunStartedAt: tombstoneRunStartedAt });
	assertEq(tombstoneTracker.pollRpc(teamId, taskListId, new Map([[name, tombstoneRpc]]), tombstoneRunStartedAt + 500), [], "fallback tombstone test starts idle grace");
	assertEq(
		tombstoneTracker.pollRpc(teamId, taskListId, new Map([[name, tombstoneRpc]]), tombstoneRunStartedAt + 2_500),
		[{ name, event: "idle" }],
		"fallback tombstone test resolves stable idle once",
	);
	const runBStartedAt = tombstoneRunStartedAt + 3_000;
	tombstoneTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, rpcRunStartedAt: runBStartedAt });
	const delayedCompletionMarker = tombstoneTracker.recordIdleNotification(
		teamId,
		taskListId,
		name,
		new Date(tombstoneRunStartedAt + 200).toISOString(),
	);
	assertEq(
		tombstoneTracker.consumeIdleNotification({ teamId, taskListId, name, completedTaskId: "delayed", marker: delayedCompletionMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: true },
		"a delayed completion from fallback run A does not create a second leader turn or consume run B",
	);
	const runBIdleMarker = tombstoneTracker.recordIdleNotification(
		teamId,
		taskListId,
		name,
		new Date(runBStartedAt + 1).toISOString(),
	);
	assertEq(
		tombstoneTracker.consumeIdleNotification({ teamId, taskListId, name, marker: runBIdleMarker }),
		{ wake: { name, event: "idle" }, completedTaskWatch: false, suppressCompletionNotification: false },
		"run B remains registered after a delayed completion from fallback run A",
	);

	// Fallback correlations are a bounded run history, rather than a single
	// per-worker slot: B's fallback must not discard A's delayed completion.
	const multiTombstoneTracker = new TeamWaitTracker();
	const multiRunAStartedAt = now + 20_000;
	const multiRunARpc = {
		...liveRpc,
		status: "idle",
		lastStatusChangeAt: multiRunAStartedAt + 100,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	multiTombstoneTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, rpcRunStartedAt: multiRunAStartedAt });
	assertEq(multiTombstoneTracker.pollRpc(teamId, taskListId, new Map([[name, multiRunARpc]]), multiRunAStartedAt + 500), [], "multi-run tombstone A starts idle grace");
	assertEq(multiTombstoneTracker.pollRpc(teamId, taskListId, new Map([[name, multiRunARpc]]), multiRunAStartedAt + 2_500), [{ name, event: "idle" }], "multi-run tombstone A resolves fallback");
	const multiRunBStartedAt = multiRunAStartedAt + 3_000;
	const multiRunBRpc = {
		...liveRpc,
		status: "idle",
		lastStatusChangeAt: multiRunBStartedAt + 100,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	multiTombstoneTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, rpcRunStartedAt: multiRunBStartedAt });
	assertEq(multiTombstoneTracker.pollRpc(teamId, taskListId, new Map([[name, multiRunBRpc]]), multiRunBStartedAt + 500), [], "multi-run tombstone B starts idle grace");
	assertEq(multiTombstoneTracker.pollRpc(teamId, taskListId, new Map([[name, multiRunBRpc]]), multiRunBStartedAt + 2_500), [{ name, event: "idle" }], "multi-run tombstone B resolves fallback");
	const multiRunADelayedMarker = multiTombstoneTracker.recordIdleNotification(teamId, taskListId, name, new Date(multiRunAStartedAt + 200).toISOString());
	assertEq(
		multiTombstoneTracker.consumeIdleNotification({ teamId, taskListId, name, completedTaskId: "delayed-a", marker: multiRunADelayedMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: true },
		"run A delayed completion remains suppressed after run B also used stable-idle fallback",
	);
	const multiRunBDelayedMarker = multiTombstoneTracker.recordIdleNotification(teamId, taskListId, name, new Date(multiRunBStartedAt + 200).toISOString());
	assertEq(
		multiTombstoneTracker.consumeIdleNotification({ teamId, taskListId, name, completedTaskId: "delayed-b", marker: multiRunBDelayedMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: true },
		"run B delayed completion remains independently suppressed",
	);

	// An already-terminal registration only cancels its active watch. It must not
	// erase a previous fallback tombstone that still owns a delayed completion.
	const cancellationTracker = new TeamWaitTracker();
	const cancellationRunAStartedAt = now + 30_000;
	const cancellationRpc = {
		...liveRpc,
		status: "idle",
		lastStatusChangeAt: cancellationRunAStartedAt + 100,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	cancellationTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, rpcRunStartedAt: cancellationRunAStartedAt });
	assertEq(cancellationTracker.pollRpc(teamId, taskListId, new Map([[name, cancellationRpc]]), cancellationRunAStartedAt + 500), [], "cancellation tombstone starts idle grace");
	assertEq(cancellationTracker.pollRpc(teamId, taskListId, new Map([[name, cancellationRpc]]), cancellationRunAStartedAt + 2_500), [{ name, event: "idle" }], "cancellation tombstone resolves fallback");
	cancellationTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000, rpcRunStartedAt: cancellationRunAStartedAt + 3_000 });
	cancellationTracker.cancelWait(teamId, taskListId, name);
	const cancellationDelayedMarker = cancellationTracker.recordIdleNotification(teamId, taskListId, name, new Date(cancellationRunAStartedAt + 200).toISOString());
	assertEq(
		cancellationTracker.consumeIdleNotification({ teamId, taskListId, name, completedTaskId: "cancelled-watch-delayed", marker: cancellationDelayedMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: true },
		"cancelling an already-terminal wait preserves the prior fallback tombstone",
	);

	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
	assertEq(
		waitTracker.pollRpc(teamId, taskListId, new Map(), now),
		[{ name, event: "closed" }],
		"wait wakes when its RPC teammate closes",
	);

	const errorRpc = {
		status: "error",
		lastEventAt: now,
		lastError: "worker process crashed",
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
	assertEq(
		waitTracker.pollRpc(teamId, taskListId, new Map([[name, errorRpc]]), now),
		[{ name, event: "failed", reason: "worker process crashed" }],
		"wait reports an RPC error as failure instead of a normal close",
	);

	const idleRpc = {
		status: "idle",
		lastEventAt: now,
		lastError: null,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
	assertEq(waitTracker.pollRpc(teamId, taskListId, new Map([[name, idleRpc]]), now), [], "RPC idle fallback waits through its grace period");
	assertEq(
		waitTracker.pollRpc(teamId, taskListId, new Map([[name, idleRpc]]), now + 2_000),
		[{ name, event: "idle" }],
		"stable RPC idle wakes even if its mailbox notification is unavailable",
	);

	const preRegistrationMarker = waitTracker.recordIdleNotification(teamId, taskListId, name);
	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
	assertEq(
		waitTracker.consumeIdleNotification({ teamId, taskListId, name, marker: preRegistrationMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: false },
		"an inbox idle marker from before registration does not consume a newer wait",
	);
	const postRegistrationMarker = waitTracker.recordIdleNotification(teamId, taskListId, name);
	assertEq(
		waitTracker.consumeIdleNotification({ teamId, taskListId, name, marker: postRegistrationMarker }),
		{ wake: { name, event: "idle" }, completedTaskWatch: false, suppressCompletionNotification: false },
		"an inbox idle marker after registration resolves the wait",
	);

	const currentRunStartedAt = 20_000;
	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500, rpcRunStartedAt: currentRunStartedAt });
	const delayedOldRunMarker = waitTracker.recordIdleNotification(
		teamId,
		taskListId,
		name,
		new Date(currentRunStartedAt - 1).toISOString(),
	);
	assertEq(
		waitTracker.consumeIdleNotification({ teamId, taskListId, name, marker: delayedOldRunMarker }),
		{ wake: null, completedTaskWatch: false, suppressCompletionNotification: false },
		"a delayed idle notification from an older worker run does not consume a new streaming wait",
	);
	const currentRunIdleMarker = waitTracker.recordIdleNotification(
		teamId,
		taskListId,
		name,
		new Date(currentRunStartedAt + 1).toISOString(),
	);
	assertEq(
		waitTracker.consumeIdleNotification({ teamId, taskListId, name, marker: currentRunIdleMarker }),
		{ wake: { name, event: "idle" }, completedTaskWatch: false, suppressCompletionNotification: false },
		"an idle notification from the current worker run resolves the wait",
	);
	assertEq(
		formatTeamWaitWake("normal", { name, event: "closed" }),
		"[Team] Wait ended: Teammate alice closed.",
		"poll-derived close wake has a leader-deliverable message",
	);
	assertEq(
		formatTeamWaitWake("normal", { name, event: "failed", reason: "worker process crashed" }),
		"[Team] Wait ended: Teammate alice failed: worker process crashed",
		"poll-derived failure wake has a leader-deliverable message",
	);
	const leaderSource = fs.readFileSync(path.join(process.cwd(), "extensions/teams/leader.ts"), "utf8");
	assert(leaderSource.includes("for (const wake of waitTracker.pollRpc"), "leader wait loop polls stalled, closed, and failed waits");
	assert(leaderSource.includes("wakeLeaderForWait(wake)"), "leader wait loop routes every poll-derived wake to delivery");
	assert(leaderSource.includes("pi.sendUserMessage(wake.content"), "poll-derived wakes are injected into the leader conversation");
	assert(leaderSource.includes("waitPollLoop = startWaitPollLoop"), "leader starts an independent wait liveness loop");
	const refreshLoopStart = leaderSource.indexOf("refreshTimer = setInterval");
	const waitLoopStart = leaderSource.indexOf("waitPollLoop = startWaitPollLoop");
	assert(refreshLoopStart >= 0 && waitLoopStart > refreshLoopStart, "leader creates the wait liveness loop separately from refresh scheduling");
	assert(!leaderSource.slice(refreshLoopStart, waitLoopStart).includes("pollWaits()"), "heartbeat/refresh loop no longer gates wait polling");
	const sessionShutdownStart = leaderSource.indexOf('pi.on("session_shutdown"');
	assert(sessionShutdownStart >= 0 && leaderSource.slice(sessionShutdownStart).includes("stopLoops();"), "session shutdown stops the independent wait liveness loop");
	assert(!leaderSource.includes("await refreshTasks();\n\t\t\t\tpollWaits();"), "refresh loop no longer owns wait polling");
	assert(leaderSource.includes("waitPollLoop = startWaitPollLoop"), "leader starts an independent wait polling loop");
	assert(leaderSource.includes("waitPollLoop?.stop();"), "stopLoops clears the independent wait polling loop");
	assert(leaderSource.includes("pendingWaitWakes.clear();"), "leader clears pending wake delivery on team/session scope changes");
	assert(leaderSource.includes("wake.scopeEpoch !== waitWakeScopeEpoch"), "leader discards a late pending wake from an earlier scope before enqueueing it");
	assert(leaderSource.includes("const pollMemberEpochs = new Map"), "inbox poll captures each member's wake epoch before handling messages");
	assert(leaderSource.includes("wake.memberEpoch !== getMemberWaitWakeEpoch"), "late member wake enqueue is rejected after that member is killed");
	assert(leaderSource.includes("clearMemberWaitState(teamId, effectiveTlId, name)"), "member kill clears that member's pending wait wake deliveries");
	assert(leaderSource.includes("beginWaitRegistration: beginMemberWaitRegistration"), "new wait registrations invalidate retryable wakes from older registrations");
	assert(leaderSource.includes("pendingWaitWakes.clearMember(teamId, effectiveTaskListId, name)"), "wait registration invalidation clears only that member's pending wakes");

	// Terminal state is consumed before Pi accepts a leader message, so delivery
	// must be retained, deduplicated, and retried without duplicating a turn.
	const pendingWakeQueue = new PendingLeaderWakeQueue();
	const pendingWake = {
		key: "wait:wait-team:wait-tl:alice:idle",
		teamId,
		taskListId,
		name,
		scopeEpoch: 1,
		memberEpoch: 0,
		content: "[Team] Wait ended: Teammate alice is idle.",
	};
	assertEq(pendingWakeQueue.enqueue(pendingWake), true, "terminal wait wake enters the retry queue");
	assertEq(pendingWakeQueue.enqueue(pendingWake), false, "duplicate terminal wait enqueue is suppressed while pending");
	let piSendAttempts = 0;
	const deliveredWaitWakes: string[] = [];
	pendingWakeQueue.flush(() => {
		piSendAttempts++;
		throw new Error("Pi temporarily unavailable");
	}, 10_000);
	assertEq(pendingWakeQueue.size(), 1, "synchronous Pi send throw keeps terminal wake pending");
	pendingWakeQueue.flush(() => {
		piSendAttempts++;
		deliveredWaitWakes.push(pendingWake.content);
	}, 10_999);
	assertEq(piSendAttempts, 1, "bounded backoff does not retry before the next tick window");
	pendingWakeQueue.flush(() => {
		piSendAttempts++;
		deliveredWaitWakes.push(pendingWake.content);
	}, 11_000);
	assertEq(deliveredWaitWakes, [pendingWake.content], "next wait tick retries and delivers the terminal wake once");
	assertEq(pendingWakeQueue.size(), 0, "successful Pi send removes the pending terminal wake");
	pendingWakeQueue.flush(() => deliveredWaitWakes.push("duplicate"), 20_000);
	assertEq(deliveredWaitWakes, [pendingWake.content], "delivered terminal wake is not sent twice");

	const permanentlyFailingWake = { ...pendingWake, key: "wait:wait-team:wait-tl:alice:failed", content: "[Team] Wait ended: Teammate alice failed." };
	const otherScopeWake = { ...pendingWake, key: "wait:other-team:wait-tl:alice:idle", teamId: "other-team" };
	pendingWakeQueue.enqueue(permanentlyFailingWake);
	pendingWakeQueue.enqueue(otherScopeWake);
	pendingWakeQueue.flush(() => { throw new Error("Pi still unavailable"); }, 30_000);
	pendingWakeQueue.flush(() => { throw new Error("Pi still unavailable"); }, 31_000);
	assertEq(pendingWakeQueue.size(), 2, "repeated Pi send throws retain terminal wakes for later retry");
	pendingWakeQueue.clearScope(teamId, taskListId);
	assertEq(pendingWakeQueue.size(), 1, "team cleanup clears only its pending terminal wake deliveries");
	pendingWakeQueue.clearScope("other-team");
	assertEq(pendingWakeQueue.size(), 0, "scope cleanup can remove the remaining pending terminal wake delivery");

	const lateScopeQueue = new PendingLeaderWakeQueue();
	lateScopeQueue.enqueue({ ...pendingWake, key: "wait:old-scope", scopeEpoch: 7 });
	const lateScopeDeliveries: string[] = [];
	lateScopeQueue.flush(
		(wake) => lateScopeDeliveries.push(wake.content),
		40_000,
		undefined,
		(wake) => wake.scopeEpoch === 8,
	);
	assertEq(lateScopeDeliveries, [], "a late wake from an old team scope is discarded before delivery");
	assertEq(lateScopeQueue.size(), 0, "discarding an old-scope wake removes it from the retry queue");

	const lateMemberQueue = new PendingLeaderWakeQueue();
	lateMemberQueue.enqueue({ ...pendingWake, key: "wait:killed-alice", memberEpoch: 3 });
	lateMemberQueue.enqueue({ ...pendingWake, key: "wait:live-bob", name: "bob", content: "bob wake" });
	const lateMemberDeliveries: string[] = [];
	lateMemberQueue.flush(
		(wake) => lateMemberDeliveries.push(wake.content),
		45_000,
		undefined,
		(wake) => wake.name !== name || wake.memberEpoch === 4,
	);
	assertEq(lateMemberDeliveries, ["bob wake"], "late enqueue from killed member is discarded while another member wake remains deliverable");
	assertEq(lateMemberQueue.size(), 0, "member-epoch filtering consumes both discarded and delivered entries");

	const runIdentityTracker = new TeamWaitTracker();
	runIdentityTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000 });
	const firstRunWake = runIdentityTracker.pollRpc(teamId, taskListId, new Map(), now)[0];
	runIdentityTracker.register({ teamId, taskListId, name, stallThresholdMs: 5_000 });
	const secondRunWake = runIdentityTracker.pollRpc(teamId, taskListId, new Map(), now + 1)[0];
	assert(firstRunWake?.terminalId !== undefined && secondRunWake?.terminalId !== undefined && firstRunWake.terminalId !== secondRunWake.terminalId, "identical terminal conditions from distinct wait runs receive distinct ids");
	const distinctRunQueue = new PendingLeaderWakeQueue();
	assertEq(distinctRunQueue.enqueue({ ...pendingWake, key: `wait:${firstRunWake?.terminalId ?? "missing"}` }), true, "first run terminal wake enters the retry queue");
	assertEq(distinctRunQueue.enqueue({ ...pendingWake, key: `wait:${secondRunWake?.terminalId ?? "missing"}` }), true, "same terminal condition from a later run is not deduplicated with the earlier run");
	const rewaitQueue = new PendingLeaderWakeQueue();
	rewaitQueue.enqueue({ ...pendingWake, key: "wait:old-registration", memberEpoch: 4 });
	rewaitQueue.clearMember(teamId, taskListId, name);
	let oldRegistrationDeliveries = 0;
	rewaitQueue.flush(() => { oldRegistrationDeliveries++; }, 20_000, undefined, (wake) => wake.memberEpoch === 5);
	assertEq(oldRegistrationDeliveries, 0, "re-registering a member wait prevents its queued old terminal wake from being delivered");

	const killCleanupQueue = new PendingLeaderWakeQueue();
	killCleanupQueue.enqueue({ ...pendingWake, key: "wait:kill-alice" });
	killCleanupQueue.enqueue({ ...pendingWake, key: "wait:kill-bob", name: "bob" });
	killCleanupQueue.clearMember(teamId, taskListId, name);
	assertEq(killCleanupQueue.size(), 1, "member kill cleanup removes only that member's pending wakes");
	killCleanupQueue.clearMember(teamId, taskListId, "bob");
	assertEq(killCleanupQueue.size(), 0, "member kill cleanup removes the remaining member wake");

	// A refresh cycle can be held forever by attach-claim I/O. The separate wait
	// timer still runs, is unref'd, and does not overlap its own slow poll.
	let scheduledWaitTick: (() => void) | undefined;
	let waitTimerUnrefCalls = 0;
	let waitTimerCancelCalls = 0;
	let independentWaitPolls = 0;
	let releaseSlowPoll: (() => void) | undefined;
	const slowWaitPoll = new Promise<void>((resolve) => {
		releaseSlowPoll = resolve;
	});
	const heartbeatNeverResolves = new Promise<void>(() => {});
	void heartbeatNeverResolves;
	const heartbeatRejects = Promise.reject(new Error("attach heartbeat failed"));
	void heartbeatRejects.catch(() => {});
	const waitLoop = startWaitPollLoop({
		poll: async () => {
			independentWaitPolls++;
			if (independentWaitPolls === 1) await slowWaitPoll;
		},
		schedule: (callback) => {
			scheduledWaitTick = callback;
			return { unref: () => { waitTimerUnrefCalls++; } };
		},
		cancel: () => { waitTimerCancelCalls++; },
	});
	assertEq(waitTimerUnrefCalls, 1, "independent wait timer is unref'd");
	scheduledWaitTick?.();
	await Promise.resolve();
	await Promise.resolve();
	assertEq(independentWaitPolls, 1, "wait poll proceeds while simulated heartbeat work never resolves or rejects");
	scheduledWaitTick?.();
	await Promise.resolve();
	assertEq(independentWaitPolls, 1, "independent wait poll prevents overlapping ticks");
	releaseSlowPoll?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	scheduledWaitTick?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assertEq(independentWaitPolls, 2, "independent wait poll resumes after its in-flight tick completes");
	waitLoop.stop();
	scheduledWaitTick?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assertEq(waitTimerCancelCalls, 1, "stopping loops cancels the independent wait timer");
	assertEq(independentWaitPolls, 2, "stopped independent wait timer cannot poll again");

	// /team cleanup deletes the mailbox/task artifacts that waits rely on, so its
	// callback must cancel waits before it removes the team directory.
	const savedTeamsRoot = process.env.PI_TEAMS_ROOT_DIR;
	const cleanupTeamsRoot = tmpRoot;
	const cleanupTeamId = "cleanup-watches-team";
	process.env.PI_TEAMS_ROOT_DIR = cleanupTeamsRoot;
	try {
		await fs.promises.mkdir(path.join(cleanupTeamsRoot, cleanupTeamId), { recursive: true });
		waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
		let cleanupWaitsCleared = 0;
		await handleTeamCleanupCommand({
			ctx: {
				cwd: tmpRoot,
				ui: { notify: () => {} },
			} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
			rest: ["--force"],
			teamId: cleanupTeamId,
			teammates: new Map(),
			clearWaits: () => {
				cleanupWaitsCleared++;
				waitTracker.clear();
			},
			refreshTasks: async () => {},
			getTasks: () => [],
			renderWidget: () => {},
			style: "normal",
		});
		assertEq(cleanupWaitsCleared, 1, "forced cleanup clears active waits before deleting artifacts");
		assertEq(waitTracker.pollRpc(teamId, taskListId, teammates, now), [], "cleanup-cleared wait cannot wake later");
	} finally {
		if (savedTeamsRoot === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
		else process.env.PI_TEAMS_ROOT_DIR = savedTeamsRoot;
	}

	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
	assertEq(
		waitTracker.handleIdleNotification({ teamId, taskListId, name }),
		{ name, event: "idle" },
		"wait wakes on an idle notification",
	);
	waitTracker.register({ teamId, taskListId, name, stallThresholdMs: 500 });
	assertEq(
		waitTracker.handleIdleNotification({ teamId, taskListId, name, failureReason: "worker shutdown" }),
		{ name, event: "failed", reason: "worker shutdown" },
		"wait wakes on a worker failure notification",
	);
	assertEq(
		formatTeamWaitWake("normal", { name, event: "stalled", stallThresholdMs: 300_000 }),
		"[Team] Wait ended: Teammate alice appears stalled (no agent events for 300s).",
		"wait wake formatting describes the stalled condition",
	);

	// Verify mailbox-driven wakes are delivered to the leader asynchronously.
	const waitInboxDir = path.join(tmpRoot, "wait-inbox-test");
	const waitInboxTeamId = "wait-inbox-team";
	const waitInboxTaskListId = "wait-inbox-tl";
	await ensureTeamConfig(waitInboxDir, {
		teamId: waitInboxTeamId,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
	});
	const wakeMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
	let leaderIsIdle = false;
	const wakeCtx = {
		cwd: waitInboxDir,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => waitInboxTeamId },
		isIdle: () => leaderIsIdle,
	} as unknown as ExtensionContext;
	const inboxWaitTracker = new TeamWaitTracker();
	const delayedRunTracker = new TeamWaitTracker();
	const delayedRunStartedAt = Date.now();
	delayedRunTracker.register({
		teamId: waitInboxTeamId,
		taskListId: waitInboxTaskListId,
		name,
		stallThresholdMs: 5_000,
		rpcRunStartedAt: delayedRunStartedAt,
	});
	const delayedOldRunTimestamp = new Date(delayedRunStartedAt - 1).toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: delayedOldRunTimestamp }),
		timestamp: delayedOldRunTimestamp,
	});
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: delayedRunTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 0, "a delayed old-run idle notification claimed after registration does not wake the new run");
	const currentRunTimestamp = new Date(delayedRunStartedAt + 1).toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: currentRunTimestamp }),
		timestamp: currentRunTimestamp,
	});
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: delayedRunTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 1, "a current-run idle notification claimed after registration wakes once");
	wakeMessages.length = 0;

	// An inbox poll can consume an idle marker before a later wait action is
	// registered. That older marker must be ignored, while the stable RPC-idle
	// fallback still guarantees a finite, one-time resolution.
	const preWatchIdleTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: preWatchIdleTimestamp }),
		timestamp: preWatchIdleTimestamp,
	});
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: inboxWaitTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 0, "an idle notification consumed before registration cannot wake a later wait");
	inboxWaitTracker.register({ teamId: waitInboxTeamId, taskListId: waitInboxTaskListId, name, stallThresholdMs: 5_000 });
	const preWatchIdleRpc = { ...liveRpc, status: "idle" } as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	const preWatchIdleTeammates = new Map([[name, preWatchIdleRpc]]);
	assertEq(inboxWaitTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, preWatchIdleTeammates, now), [], "pre-registration mailbox idle begins stable RPC fallback");
	assertEq(
		inboxWaitTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, preWatchIdleTeammates, now + 2_000),
		[{ name, event: "idle" }],
		"pre-registration mailbox idle resolves once through the stable RPC fallback",
	);
	assertEq(inboxWaitTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, preWatchIdleTeammates, now + 4_000), [], "fallback resolution clears its watch after one wake");

	inboxWaitTracker.register({ teamId: waitInboxTeamId, taskListId: waitInboxTaskListId, name, stallThresholdMs: 500 });
	const idleTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: idleTimestamp }),
		timestamp: idleTimestamp,
	});
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: inboxWaitTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 1, "idle wait sends one asynchronous leader wake");
	assert(wakeMessages[0]?.content.includes("Wait ended: Teammate alice is idle") === true, "idle wait wake identifies the teammate and event");
	assertEq(wakeMessages[0]?.options?.deliverAs, "followUp", "busy leader receives a wait wake as follow-up");

	leaderIsIdle = true;
	inboxWaitTracker.register({ teamId: waitInboxTeamId, taskListId: waitInboxTaskListId, name, stallThresholdMs: 500 });
	const idleLeaderTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: idleLeaderTimestamp }),
		timestamp: idleLeaderTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: inboxWaitTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 1, "idle leader receives one wait wake as a new turn");
	assertEq(wakeMessages[0]?.options, undefined, "idle leader wait wake has no delivery override");

	const watchedCompletion = await createTask(waitInboxDir, waitInboxTaskListId, { subject: "Watched completion", description: "", owner: name });
	await completeTask(waitInboxDir, waitInboxTaskListId, watchedCompletion.id, name, "done");
	inboxWaitTracker.register({ teamId: waitInboxTeamId, taskListId: waitInboxTaskListId, name, stallThresholdMs: 500 });
	const watchedCompletionTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({
			type: "idle_notification",
			from: name,
			timestamp: watchedCompletionTimestamp,
			completedTaskId: watchedCompletion.id,
			completedStatus: "completed",
		}),
		timestamp: watchedCompletionTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: inboxWaitTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 1, "watched task completion reuses one existing completion message");
	assert(wakeMessages[0]?.content.includes(`completed task #${watchedCompletion.id}`) === true, "watched completion keeps the established completion content");
	assertEq(wakeMessages[0]?.options, undefined, "watched completion wakes an idle leader as a new turn");
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: inboxWaitTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 1, "a consumed completion notification cannot wake the leader twice");

	leaderIsIdle = false;
	const watchedBusyCompletion = await createTask(waitInboxDir, waitInboxTaskListId, { subject: "Busy watched completion", description: "", owner: name });
	await completeTask(waitInboxDir, waitInboxTaskListId, watchedBusyCompletion.id, name, "done while leader is busy");
	inboxWaitTracker.register({ teamId: waitInboxTeamId, taskListId: waitInboxTaskListId, name, stallThresholdMs: 500 });
	const watchedBusyCompletionTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({
			type: "idle_notification",
			from: name,
			timestamp: watchedBusyCompletionTimestamp,
			completedTaskId: watchedBusyCompletion.id,
			completedStatus: "completed",
		}),
		timestamp: watchedBusyCompletionTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: inboxWaitTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 1, "watched task completion sends one message while the leader is busy");
	assertEq(wakeMessages[0]?.options?.deliverAs, "followUp", "watched completion is delivered as a follow-up while the leader is busy");

	const fallbackInboxTracker = new TeamWaitTracker();
	const fallbackRunStartedAt = Date.now();
	const fallbackInboxRpc = {
		status: "idle",
		lastEventAt: fallbackRunStartedAt,
		lastStatusChangeAt: fallbackRunStartedAt,
		lastError: null,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	fallbackInboxTracker.register({
		teamId: waitInboxTeamId,
		taskListId: waitInboxTaskListId,
		name,
		stallThresholdMs: 500,
		rpcRunStartedAt: fallbackRunStartedAt,
	});
	assertEq(fallbackInboxTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, new Map([[name, fallbackInboxRpc]]), fallbackRunStartedAt), [], "fallback inbox test begins stable-idle grace");
	assertEq(
		fallbackInboxTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, new Map([[name, fallbackInboxRpc]]), fallbackRunStartedAt + 2_000),
		[{ name, event: "idle" }],
		"fallback inbox test resolves the wait before delayed mailbox delivery",
	);
	const delayedFallbackCompletion = await createTask(waitInboxDir, waitInboxTaskListId, { subject: "Delayed fallback completion", description: "", owner: name });
	await completeTask(waitInboxDir, waitInboxTaskListId, delayedFallbackCompletion.id, name, "done");
	const delayedFallbackTimestamp = new Date(fallbackRunStartedAt + 100).toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({
			type: "idle_notification",
			from: name,
			timestamp: delayedFallbackTimestamp,
			completedTaskId: delayedFallbackCompletion.id,
			completedStatus: "completed",
		}),
		timestamp: delayedFallbackTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: fallbackInboxTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 0, "a delayed completion for a stable-idle fallback run does not create a duplicate leader turn");

	// A suppression must still advance the delegation batch; otherwise a later
	// batch would be permanently blocked behind a completion that was hidden only
	// to avoid duplicating the fallback wake.
	leaderIsIdle = false;
	const suppressedBatchTracker = new DelegationTracker();
	const batchWaitTracker = new TeamWaitTracker();
	const batchFirst = await createTask(waitInboxDir, waitInboxTaskListId, { subject: "Suppressed batch first", description: "", owner: name });
	const batchSecond = await createTask(waitInboxDir, waitInboxTaskListId, { subject: "Suppressed batch second", description: "", owner: name });
	await completeTask(waitInboxDir, waitInboxTaskListId, batchFirst.id, name, "first");
	await completeTask(waitInboxDir, waitInboxTaskListId, batchSecond.id, name, "second");
	suppressedBatchTracker.addBatch([batchFirst.id, batchSecond.id]);
	const batchFirstTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: batchFirstTimestamp, completedTaskId: batchFirst.id, completedStatus: "completed" }),
		timestamp: batchFirstTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: batchWaitTracker,
		delegationTracker: suppressedBatchTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	const batchFallbackRunStartedAt = Date.now();
	const batchFallbackRpc = {
		status: "idle",
		lastEventAt: batchFallbackRunStartedAt,
		lastStatusChangeAt: batchFallbackRunStartedAt,
		lastError: null,
	} as unknown as import("../extensions/teams/teammate-rpc.js").TeammateRpc;
	batchWaitTracker.register({ teamId: waitInboxTeamId, taskListId: waitInboxTaskListId, name, stallThresholdMs: 500, rpcRunStartedAt: batchFallbackRunStartedAt });
	batchWaitTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, new Map([[name, batchFallbackRpc]]), batchFallbackRunStartedAt);
	batchWaitTracker.pollRpc(waitInboxTeamId, waitInboxTaskListId, new Map([[name, batchFallbackRpc]]), batchFallbackRunStartedAt + 2_000);
	const batchSecondTimestamp = new Date(batchFallbackRunStartedAt + 100).toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: batchSecondTimestamp, completedTaskId: batchSecond.id, completedStatus: "completed" }),
		timestamp: batchSecondTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: batchWaitTracker,
		delegationTracker: suppressedBatchTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assertEq(wakeMessages.length, 0, "a suppressed final batch completion does not emit a duplicate completion or batch turn");
	const subsequentBatch = await createTask(waitInboxDir, waitInboxTaskListId, { subject: "Subsequent batch", description: "", owner: name });
	await completeTask(waitInboxDir, waitInboxTaskListId, subsequentBatch.id, name, "later");
	suppressedBatchTracker.addBatch([subsequentBatch.id]);
	const subsequentBatchTimestamp = new Date().toISOString();
	await writeToMailbox(waitInboxDir, TEAM_MAILBOX_NS, "team-lead", {
		from: name,
		text: JSON.stringify({ type: "idle_notification", from: name, timestamp: subsequentBatchTimestamp, completedTaskId: subsequentBatch.id, completedStatus: "completed" }),
		timestamp: subsequentBatchTimestamp,
	});
	wakeMessages.length = 0;
	await pollLeaderInbox({
		ctx: wakeCtx,
		teamId: waitInboxTeamId,
		teamDir: waitInboxDir,
		taskListId: waitInboxTaskListId,
		leadName: "team-lead",
		style: "normal",
		pendingPlanApprovals: new Map(),
		waitTracker: batchWaitTracker,
		delegationTracker: suppressedBatchTracker,
		sendLeaderLlmMessage: (content, options) => wakeMessages.push({ content, options }),
	});
	assert(
		wakeMessages.some((message) => message.content.includes(`All delegated tasks completed (#${subsequentBatch.id})`)),
		"a batch after suppressed completion still completes and notifies the leader",
	);

}

// ── 16. docs/help drift guard ────────────────────────────────────────
console.log("\n16. docs/help drift guard");
{
	const help = getTeamHelpText();
	assert(help.includes("/team done"), "help mentions /team done");
	assert(help.includes("/team style list"), "help mentions /team style list");
	assert(help.includes("/team style init"), "help mentions /team style init");
	assert(help.includes("/team attach <teamId> [--claim]"), "help mentions /team attach claim mode");
	assert(help.includes("/team detach"), "help mentions /team detach");
	assert(help.includes("[--urgent]"), "help mentions --urgent flag");
	assert(help.includes("/team gc"), "help mentions /team gc");
	assert(help.includes("/team status"), "help mentions /team status");

	const readmePath = path.join(process.cwd(), "README.md");
	if (!fs.existsSync(readmePath)) {
		console.log("  (skipped) README.md not found");
	} else {
		const readme = fs.readFileSync(readmePath, "utf8");
		assert(readme.includes("/team done"), "README mentions /team done");
		assert(readme.includes("\"action\": \"team_done\""), "README mentions teams tool team_done action");
		assert(readme.includes("/team style list"), "README mentions /team style list");
		assert(readme.includes("/team attach <teamId> [--claim]"), "README mentions /team attach claim mode");
		assert(readme.includes("/team detach"), "README mentions /team detach");
		assert(readme.includes("\"action\": \"task_assign\""), "README mentions teams tool task_assign action");
		assert(readme.includes("\"action\": \"task_dep_add\""), "README mentions teams tool task_dep_add action");
		assert(readme.includes("\"action\": \"message_broadcast\""), "README mentions teams tool message_broadcast action");
		assert(readme.includes("\"action\": \"member_kill\""), "README mentions teams tool member_kill action");
		assert(readme.includes("\"action\": \"plan_approve\""), "README mentions teams tool plan_approve action");
		assert(readme.includes("\"action\": \"hooks_policy_get\""), "README mentions teams tool hooks_policy_get action");
		assert(readme.includes("\"action\": \"hooks_policy_set\""), "README mentions teams tool hooks_policy_set action");
		assert(readme.includes("\"action\": \"model_policy_get\""), "README mentions teams tool model_policy_get action");
		assert(readme.includes("\"action\": \"model_policy_check\""), "README mentions teams tool model_policy_check action");
		assert(readme.includes("PI_TEAMS_HOOKS_FAILURE_ACTION"), "README mentions hook failure action policy");
		assert(readme.includes("PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK"), "README mentions hook reopen cap policy");
		assert(readme.includes("PI_TEAMS_HOOK_CONTEXT_JSON"), "README mentions hook context json contract");
		assert(!readme.includes("claude-sonnet-4"), "README avoids deprecated leader model examples");
		assert(readme.includes("task-centric view"), "README mentions panel task-centric view");
		assert(readme.includes("`t` or `shift+t`"), "README mentions panel task toggle key");
		assert(readme.includes("task view: `c` complete"), "README mentions panel task mutations");
		assert(readme.includes("`r` reassign"), "README mentions panel task reassignment");
		assert(readme.includes("tool args inline"), "README mentions transcript tool content display");
		assert(readme.includes("_styles"), "README mentions _styles directory");
		assert(readme.includes("[--urgent]"), "README mentions --urgent flag");
		assert(readme.includes("\"urgent\": true"), "README mentions urgent tool param example");
		assert(readme.includes("/team gc"), "README mentions /team gc command");
		assert(readme.includes("/team cleanup"), "README mentions /team cleanup command");
		assert(readme.includes("docs/hook-contract.md"), "README references hook contract doc");
		assert(readme.includes("member_status"), "README mentions teams tool member_status action");
		assert(readme.includes("\"action\": \"wait\""), "README mentions teams tool wait action");
		assert(readme.includes("Non-blocking teammate wait"), "README documents non-blocking teammate waits");
		assert(readme.includes("rolling five-minute inactivity window"), "README documents wait inactivity semantics");
		assert(readme.includes("stallThresholdMs"), "README documents the per-wait stall threshold override");
		assert(readme.includes("positive decimal-integer string"), "README documents the strict wait environment threshold format");
		assert(readme.includes("1800000.5") && readme.includes("2e6"), "README documents rejected fractional and exponent environment thresholds");
		assert(readme.includes("stable RPC idle"), "README documents the bounded stable-idle fallback");
		assert(readme.includes("instead of waiting forever"), "README documents prevention of indefinite wait registrations");
		assert(readme.includes("own lightweight loop"), "README documents independent wait monitoring liveness");
		assert(readme.includes("queued and retried"), "README documents retry of temporarily undeliverable wait wakes");
		assert(readme.includes("earlier team/task scope"), "README documents discarding old-scope wait wakes");
		assert(readme.includes("/team status"), "README mentions /team status command");
		assert(readme.includes("PI_TEAMS_STALL_THRESHOLD_MS"), "README mentions stall threshold env var");
		assert(readme.includes("Stall detection"), "README mentions stall detection feature");
		assert(readme.includes("Time in state"), "README mentions time-in-state feature");
	}

	const skillPath = path.join(process.cwd(), "skills/agent-teams/SKILL.md");
	if (!fs.existsSync(skillPath)) {
		console.log("  (skipped) SKILL.md not found");
	} else {
		const skill = fs.readFileSync(skillPath, "utf8");
		assert(skill.includes("team_done"), "SKILL.md mentions team_done action");
		assert(skill.includes("/team done"), "SKILL.md mentions /team done command");
		assert(skill.includes("urgent"), "SKILL.md mentions urgent flag");
		assert(skill.includes("model_policy_get"), "SKILL.md mentions model_policy_get action");
		assert(skill.includes("hooks_policy_get"), "SKILL.md mentions hooks_policy_get action");
	}
}

// ── 12. transcript tracker (tool content summarization) ─────────────
{
	console.log(`\n12. transcript tracker (tool content summarization)`);

	const tracker = new TranscriptTracker();

	// Helper to get last entry with proper narrowing
	function lastEntry(name: string): TranscriptEntry {
		const entries = tracker.get(name).getEntries();
		const last = entries[entries.length - 1];
		if (!last) throw new Error("no transcript entries");
		return last;
	}

	// Simulate tool_execution_start with read tool
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc1",
		toolName: "Read",
		args: { path: "/src/index.ts" },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "read tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary === "/src/index.ts", "read summary is file path");
		}
	}

	// Simulate tool_execution_end with content array (ToolResultMessage shape)
	tracker.handleEvent("alice", {
		type: "tool_execution_end",
		toolCallId: "tc1",
		toolName: "Read",
		result: { content: [{ type: "text", text: "file contents here\nline two" }] },
		isError: false,
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_end", "read tool_end recorded");
		if (e.kind === "tool_end") {
			assert(e.summary === "file contents here line two", "read result summarized from content array");
			assert(!e.isError, "read result not error");
		}
	}

	// Simulate bash tool with command
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc2",
		toolName: "Bash",
		args: { command: "npm run   check" },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "bash tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary === "npm run check", "bash summary normalizes whitespace");
		}
	}

	// Simulate bash error result
	tracker.handleEvent("alice", {
		type: "tool_execution_end",
		toolCallId: "tc2",
		toolName: "Bash",
		result: { content: [{ type: "text", text: "Command failed with exit code 1" }] },
		isError: true,
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_end", "bash error tool_end recorded");
		if (e.kind === "tool_end") {
			assert(e.isError, "bash error flagged");
			assert(e.summary === "Command failed with exit code 1", "bash error summary from content");
		}
	}

	// Simulate edit tool
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc3",
		toolName: "Edit",
		args: { path: "/src/utils.ts", oldText: "foo", newText: "bar" },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "edit tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary === "/src/utils.ts", "edit summary is file path");
		}
	}

	// Simulate grep tool
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc4",
		toolName: "Grep",
		args: { pattern: "TODO", path: "/src" },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "grep tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary === "TODO in /src", "grep summary includes pattern and path");
		}
	}

	// Simulate team_message tool — should show recipient + message, not just recipient
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc4b",
		toolName: "team_message",
		args: { recipient: "bob", message: "please rebase onto main", urgent: false },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "team_message tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary === "→ bob: please rebase onto main", "team_message summary includes recipient and message");
		}
	}

	// Simulate unknown tool — fallback to first string arg
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc5",
		toolName: "CustomTool",
		args: { target: "my-resource" },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "unknown tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary === "my-resource", "unknown tool fallback to first string arg");
		}
	}

	// Simulate empty result
	tracker.handleEvent("alice", {
		type: "tool_execution_end",
		toolCallId: "tc5",
		toolName: "CustomTool",
		result: { content: [{ type: "text", text: "" }] },
		isError: false,
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_end", "empty result tool_end recorded");
		if (e.kind === "tool_end") {
			assert(e.summary === "(empty)", "empty result shows (empty)");
		}
	}

	// Simulate long summary truncation
	const longPath = "/very/long/" + "a".repeat(200) + ".ts";
	tracker.handleEvent("alice", {
		type: "tool_execution_start",
		toolCallId: "tc6",
		toolName: "Read",
		args: { path: longPath },
	});
	{
		const e = lastEntry("alice");
		assert(e.kind === "tool_start", "long path tool_start recorded");
		if (e.kind === "tool_start") {
			assert(e.summary !== null && e.summary.length <= 120, "long summary truncated to 120 chars");
			assert(e.summary !== null && e.summary.endsWith("…"), "truncated summary ends with ellipsis");
		}
	}
}

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
console.log(`${"═".repeat(50)}\n`);

// cleanup
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
