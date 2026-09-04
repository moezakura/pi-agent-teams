import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { popUnreadMessages, writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import {
	TEAM_MAILBOX_NS,
	isIdleNotification,
	isPeerDmSent,
	isPlanApprovalRequest,
	isShutdownApproved,
	isShutdownRejected,
} from "./protocol.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import { getTask, listTasks } from "./task-store.js";

import type { TeamsHookInvocation } from "./hooks.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { PendingLeaderWakeCandidate } from "./pending-wake-queue.js";

/** Callback to inject a message into the leader LLM conversation. */
export type SendLeaderLlmMessage = (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;

/** A terminal condition observed for a non-blocking `teams({ action: "wait" })` request. */
export type TeamWaitWake = {
	name: string;
	event: "idle" | "failed" | "closed" | "stalled";
	/** Distinguishes a terminal event for each wait registration/run. */
	terminalId?: string;
	stallThresholdMs?: number;
	reason?: string;
};

const STABLE_RPC_IDLE_GRACE_MS = 2_000;

export function formatTeamWaitWake(style: TeamsStyle, wake: TeamWaitWake): string {
	const member = formatMemberDisplayName(style, wake.name);
	if (wake.event === "idle") return `[Team] Wait ended: ${member} is idle.`;
	if (wake.event === "failed") return `[Team] Wait ended: ${member} failed${wake.reason ? `: ${wake.reason}` : "."}`;
	if (wake.event === "closed") return `[Team] Wait ended: ${member} closed${wake.reason ? `: ${wake.reason}` : "."}`;
	const seconds = Math.round((wake.stallThresholdMs ?? 0) / 1000);
	return `[Team] Wait ended: ${member} appears stalled (no agent events for ${seconds}s).`;
}

type TeamWaitRegistration = {
	registrationId: number;
	teamId: string;
	taskListId: string;
	name: string;
	stallThresholdMs: number;
	/** Epoch ms at which the leader armed this watch. */
	registeredAt: number;
	/** An idle worker is waiting for its next run, rather than its current idle state. */
	armedForNextRun: boolean;
	/** Idle/status epoch observed while arming; a newer idle epoch proves a short run occurred. */
	rpcStatusChangeAtRegistration?: number;
	/** Last inbox idle marker already observed when this wait was registered. */
	idleMarkerAtRegistration: number;
	/** Epoch ms when the RPC worker entered its currently observed run. */
	rpcRunStartedAt?: number;
	/** First refresh tick that observed this RPC worker idle without a mailbox wake. */
	rpcIdleObservedAt?: number;
	/** RPC idle transition paired with rpcIdleObservedAt; changes restart the grace window. */
	rpcIdleObservedStatusChangeAt?: number;
};

type IdleMarker = {
	sequence: number;
	/** Parsed worker-provided idle payload timestamp, when valid. */
	timestampMs?: number;
};

type TeamWaitIdleResolution = {
	wake: TeamWaitWake | null;
	/** Terminal id of the consumed watched completion, if any. */
	terminalId?: string;
	/** A wait was consumed by task completion; use the established completion message to wake. */
	completedTaskWatch: boolean;
	/** A stable-idle fallback already woke this terminal event; suppress its delayed completion turn. */
	suppressCompletionNotification: boolean;
};

type StableIdleTombstone = {
	rpcRunStartedAt?: number;
	resolvedAt: number;
};

// A worker can finish several runs before delayed mailbox messages arrive. Keep
// a small per-member history so each delayed completion can be correlated to
// its own fallback wake without retaining unbounded lifecycle state.
const MAX_STABLE_IDLE_TOMBSTONES_PER_MEMBER = 8;

/**
 * Tracks non-blocking wait requests made by the leader.
 *
 * This deliberately does not wait on an RPC promise: leader turns must be able
 * to finish while the existing refresh/inbox loops continue monitoring workers.
 * A registration is consumed exactly once, which also suppresses repeated stall
 * notifications during a long-running worker turn.
 */
export class TeamWaitTracker {
	private waits = new Map<string, TeamWaitRegistration>();
	/**
	 * Monotonic per-worker inbox ledger. A wait captures the marker present at
	 * registration, so an idle notification consumed before that point cannot
	 * accidentally resolve a later worker run.
	 */
	private idleMarkers = new Map<string, IdleMarker>();
	private nextIdleMarker = 0;
	private nextWaitRegistrationId = 0;
	private stableIdleTombstones = new Map<string, StableIdleTombstone[]>();

	private key(teamId: string, taskListId: string, name: string): string {
		return `${teamId}:${taskListId}:${name}`;
	}

	register(wait: Omit<TeamWaitRegistration, "registrationId" | "idleMarkerAtRegistration" | "rpcIdleObservedAt" | "registeredAt" | "armedForNextRun"> & {
		registeredAt?: number;
		armedForNextRun?: boolean;
	}): { replaced: boolean } {
		const key = this.key(wait.teamId, wait.taskListId, wait.name);
		const replaced = this.waits.has(key);
		this.waits.set(key, {
			...wait,
			registeredAt: wait.registeredAt ?? Date.now(),
			armedForNextRun: wait.armedForNextRun ?? false,
			registrationId: ++this.nextWaitRegistrationId,
			idleMarkerAtRegistration: this.idleMarkers.get(key)?.sequence ?? 0,
		});
		return { replaced };
	}

	clear(): void {
		this.waits.clear();
		this.idleMarkers.clear();
		this.stableIdleTombstones.clear();
	}

	/** Cancel only an active wait; retain fallback correlation for delayed inbox messages. */
	cancelWait(teamId: string, taskListId: string, name: string): void {
		this.waits.delete(this.key(teamId, taskListId, name));
	}

	/** Remove all monitoring state when the member itself is permanently gone. */
	clearMember(teamId: string, taskListId: string, name: string): void {
		const key = this.key(teamId, taskListId, name);
		this.waits.delete(key);
		this.idleMarkers.delete(key);
		this.stableIdleTombstones.delete(key);
	}

	private addStableIdleTombstone(key: string, tombstone: StableIdleTombstone): void {
		const tombstones = this.stableIdleTombstones.get(key) ?? [];
		tombstones.push(tombstone);
		if (tombstones.length > MAX_STABLE_IDLE_TOMBSTONES_PER_MEMBER) {
			tombstones.splice(0, tombstones.length - MAX_STABLE_IDLE_TOMBSTONES_PER_MEMBER);
		}
		this.stableIdleTombstones.set(key, tombstones);
	}

	private terminalWake(
		wait: TeamWaitRegistration,
		event: TeamWaitWake["event"],
		details: Pick<TeamWaitWake, "reason" | "stallThresholdMs"> = {},
	): TeamWaitWake {
		const wake = { name: wait.name, event, ...details } as TeamWaitWake;
		// Keep the public wake payload backward-compatible while carrying a
		// run-specific id for the leader's pending-delivery dedupe key.
		Object.defineProperty(wake, "terminalId", { value: `${wait.registrationId}:${event}`, enumerable: false });
		return wake;
	}

	/** Record an idle notification as soon as the inbox poll has claimed it. */
	recordIdleNotification(teamId: string, taskListId: string, name: string, timestamp?: string): IdleMarker {
		const key = this.key(teamId, taskListId, name);
		const parsedTimestamp = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
		const marker: IdleMarker = {
			sequence: ++this.nextIdleMarker,
			...(Number.isFinite(parsedTimestamp) ? { timestampMs: parsedTimestamp } : {}),
		};
		this.idleMarkers.set(key, marker);
		return marker;
	}

	/**
	 * Inspect live RPC workers from the leader refresh loop. Inbox idle messages
	 * are preferred, but a stable RPC idle is a bounded fallback for a missing or
	 * pre-registration mailbox notification. The grace period avoids transient
	 * agent_end gaps while an auto-claim starts the next task.
	 */
	pollRpc(teamId: string, taskListId: string, teammates: Map<string, TeammateRpc>, now = Date.now()): TeamWaitWake[] {
		const wakes: TeamWaitWake[] = [];
		for (const [key, wait] of this.waits) {
			if (wait.teamId !== teamId || wait.taskListId !== taskListId) continue;
			const rpc = teammates.get(wait.name);
			if (!rpc) {
				// A registered wait always starts with a live RPC worker. If it later
				// disappears, treat that as a close rather than silently leaking it.
				this.waits.delete(key);
				wakes.push(this.terminalWake(wait, "closed"));
				continue;
			}

			if (rpc.status === "stopped") {
				this.waits.delete(key);
				wakes.push(this.terminalWake(wait, "closed", { reason: rpc.lastError ?? undefined }));
				continue;
			}
			if (rpc.status === "error") {
				this.waits.delete(key);
				wakes.push(this.terminalWake(wait, "failed", { reason: rpc.lastError ?? undefined }));
				continue;
			}
			if (wait.armedForNextRun) {
				if (rpc.status !== "idle") {
					// The next run has started. From this point onward the normal
					// active-run logic owns its idle/failure/stall terminal state.
					wait.armedForNextRun = false;
					wait.rpcRunStartedAt = rpc.lastStatusChangeAt;
					wait.rpcIdleObservedAt = undefined;
					wait.rpcIdleObservedStatusChangeAt = undefined;
				} else if (
					wait.rpcStatusChangeAtRegistration !== undefined &&
					rpc.lastStatusChangeAt > wait.rpcStatusChangeAtRegistration
				) {
					// A complete run occurred between polls. The newer idle epoch is
					// observable even though its streaming state was not.
					wait.armedForNextRun = false;
					wait.rpcRunStartedAt = wait.registeredAt;
					wait.rpcIdleObservedAt = now;
					wait.rpcIdleObservedStatusChangeAt = rpc.lastStatusChangeAt;
					continue;
				} else {
					if (now - wait.registeredAt >= wait.stallThresholdMs) {
						this.waits.delete(key);
						wakes.push(this.terminalWake(wait, "stalled", { stallThresholdMs: wait.stallThresholdMs }));
					}
					continue;
				}
			}
			if (rpc.status === "idle") {
				if (
					wait.rpcIdleObservedAt === undefined ||
					wait.rpcIdleObservedStatusChangeAt !== rpc.lastStatusChangeAt
				) {
					wait.rpcIdleObservedAt = now;
					wait.rpcIdleObservedStatusChangeAt = rpc.lastStatusChangeAt;
					continue;
				}
				if (now - wait.rpcIdleObservedAt >= STABLE_RPC_IDLE_GRACE_MS) {
					this.addStableIdleTombstone(key, {
						rpcRunStartedAt: wait.rpcRunStartedAt,
						resolvedAt: now,
					});
					this.waits.delete(key);
					wakes.push(this.terminalWake(wait, "idle"));
				}
				continue;
			}
			// Any non-idle state means a transient idle gap has recovered.
			wait.rpcIdleObservedAt = undefined;
			wait.rpcIdleObservedStatusChangeAt = undefined;

			// Match the existing display semantics, while also covering a worker
			// that never completes startup. Any received agent event advances
			// lastEventAt, so active workers keep rolling forward indefinitely.
			if (
				(rpc.status === "starting" || rpc.status === "streaming") &&
				now - rpc.lastEventAt >= wait.stallThresholdMs
			) {
				this.waits.delete(key);
				wakes.push(this.terminalWake(wait, "stalled", { stallThresholdMs: wait.stallThresholdMs }));
			}
		}
		return wakes;
	}

	/**
	 * Consume waits from mailbox idle notifications. Completed task results are
	 * already sent to the leader by pollLeaderInbox, so successful/explicitly
	 * failed task results intentionally clear without yielding another wake. A
	 * plain idle or transport-reported worker failure still wakes.
	 */
	consumeIdleNotification(args: {
		teamId: string;
		taskListId: string;
		name: string;
		completedTaskId?: string;
		failureReason?: string;
		marker: IdleMarker;
	}): TeamWaitIdleResolution {
		const key = this.key(args.teamId, args.taskListId, args.name);
		const tombstones = this.stableIdleTombstones.get(key);
		const matchingTombstoneIndex = tombstones?.findIndex((tombstone) =>
			tombstone.rpcRunStartedAt !== undefined &&
			args.marker.timestampMs !== undefined &&
			args.marker.timestampMs >= tombstone.rpcRunStartedAt &&
			args.marker.timestampMs <= tombstone.resolvedAt,
		) ?? -1;
		// Test the tombstone before the currently registered wait. A worker may
		// have begun run B after fallback resolved run A; run A's delayed mailbox
		// completion must be suppressed without consuming B's active wait.
		if (matchingTombstoneIndex >= 0 && tombstones) {
			tombstones.splice(matchingTombstoneIndex, 1);
			if (tombstones.length === 0) this.stableIdleTombstones.delete(key);
			return { wake: null, completedTaskWatch: false, suppressCompletionNotification: Boolean(args.completedTaskId) };
		}

		const wait = this.waits.get(key);
		if (!wait) {
			return { wake: null, completedTaskWatch: false, suppressCompletionNotification: false };
		}
		// This notification was already observed when the current wait began.
		// It belongs to an earlier run and must not consume the new registration.
		if (args.marker.sequence <= wait.idleMarkerAtRegistration) return { wake: null, completedTaskWatch: false, suppressCompletionNotification: false };
		if (wait.armedForNextRun) {
			// An armed idle watch must not be consumed by the idle notification
			// that preceded registration. A timestamp after registration proves
			// that the requested next run finished, including between poll ticks.
			if (args.marker.timestampMs === undefined || args.marker.timestampMs <= wait.registeredAt) {
				return { wake: null, completedTaskWatch: false, suppressCompletionNotification: false };
			}
			wait.armedForNextRun = false;
			wait.rpcRunStartedAt = wait.registeredAt;
		}
		// A delayed inbox message may belong to the previous worker run. The RPC
		// status transition is our in-memory run identity: do not let an idle
		// payload created before the current streaming run resolve this wait.
		if (
			wait.rpcRunStartedAt !== undefined &&
			args.marker.timestampMs !== undefined &&
			args.marker.timestampMs < wait.rpcRunStartedAt
		) {
			return { wake: null, completedTaskWatch: false, suppressCompletionNotification: false };
		}
		this.waits.delete(key);

		if (args.failureReason) return { wake: this.terminalWake(wait, "failed", { reason: args.failureReason }), completedTaskWatch: false, suppressCompletionNotification: false };
		if (args.completedTaskId) return { wake: null, terminalId: `${wait.registrationId}:completion:${args.completedTaskId}`, completedTaskWatch: true, suppressCompletionNotification: false };
		return { wake: this.terminalWake(wait, "idle"), completedTaskWatch: false, suppressCompletionNotification: false };
	}

	/** Compatibility helper for direct consumers that only need a wake payload. */
	handleIdleNotification(args: {
		teamId: string;
		taskListId: string;
		name: string;
		completedTaskId?: string;
		failureReason?: string;
	}): TeamWaitWake | null {
		const marker = this.recordIdleNotification(args.teamId, args.taskListId, args.name);
		return this.consumeIdleNotification({ ...args, marker }).wake;
	}
}

/**
 * Event-driven tracker for delegation batches.
 *
 * Tracks task IDs from delegate() calls. Tasks are only marked done
 * when an idle_notification with completedTaskId is received — NOT
 * by polling task file status. This avoids race conditions where
 * listTasks() returns stale or premature data.
 */
export class DelegationTracker {
	private batches: Array<{
		taskIds: Set<string>;
		completedIds: Set<string>;
		notified: boolean;
	}> = [];

	/** Register a new batch of delegated task IDs. */
	addBatch(taskIds: string[]): void {
		if (taskIds.length === 0) return;
		this.batches.push({
			taskIds: new Set(taskIds),
			completedIds: new Set(),
			notified: false,
		});
	}

	/**
	 * Mark a task as completed (called when idle_notification with
	 * completedTaskId is received). Returns any batches that became
	 * fully complete as a result.
	 */
	markCompleted(taskId: string): Array<{ taskIds: string[] }> {
		const newlyComplete: Array<{ taskIds: string[] }> = [];

		for (const batch of this.batches) {
			if (batch.notified) continue;
			if (!batch.taskIds.has(taskId)) continue;

			batch.completedIds.add(taskId);

			const allDone = [...batch.taskIds].every((id) => batch.completedIds.has(id));
			if (allDone) {
				batch.notified = true;
				newlyComplete.push({ taskIds: [...batch.taskIds] });
			}
		}

		// Prune notified batches
		this.batches = this.batches.filter((b) => !b.notified);
		return newlyComplete;
	}

	/** Clear all tracked batches (e.g. on session switch). */
	clear(): void {
		this.batches = [];
	}
}

/** Truncate a result string to stay within token budget. */
function truncateResult(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "…";
}

export async function pollLeaderInbox(opts: {
	ctx: ExtensionContext;
	teamId: string;
	teamDir: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
	enqueueHook?: (invocation: TeamsHookInvocation) => void;
	hooksEnabled?: boolean;
	sendLeaderLlmMessage?: SendLeaderLlmMessage;
	/** Batch delegation tracker for all-tasks-complete auto-notify. */
	delegationTracker?: DelegationTracker;
	/** Non-blocking RPC worker wait tracker. */
	waitTracker?: TeamWaitTracker;
	/** Queue a terminal wait wake for retryable delivery by the leader. */
	enqueueWaitWake?: (wake: PendingLeaderWakeCandidate) => void;
}): Promise<void> {
	const { ctx, teamId, teamDir, taskListId, leadName, style, pendingPlanApprovals, enqueueHook, hooksEnabled, sendLeaderLlmMessage, delegationTracker, waitTracker, enqueueWaitWake } = opts;
	const strings = getTeamsStrings(style);
	const hooksActive = hooksEnabled ?? Boolean(enqueueHook);

	let msgs: Awaited<ReturnType<typeof popUnreadMessages>>;
	try {
		msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, leadName);
	} catch (err: unknown) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
		return;
	}
	if (!msgs.length) return;

	// Claim a monotonic marker for every idle message before any async message
	// handling begins. popUnreadMessages has already marked these records read;
	// recording here lets a concurrently registered wait distinguish this older
	// run from an idle notification written after registration.
	const idleMarkers = new Map<(typeof msgs)[number], IdleMarker>();
	if (waitTracker) {
		for (const message of msgs) {
			const idle = isIdleNotification(message.text);
			if (!idle) continue;
			idleMarkers.set(message, waitTracker.recordIdleNotification(teamId, taskListId, sanitizeName(idle.from), idle.timestamp));
		}
	}

	// Collect batch completions across all messages in this poll cycle,
	// then fire notifications once at the end (avoids duplicate triggers).
	const batchCompletions: Array<{ taskIds: string[] }> = [];

	for (const m of msgs) {
		const approved = isShutdownApproved(m.text);
		if (approved) {
			const name = sanitizeName(approved.from);
			const cfg = await ensureTeamConfig(teamDir, {
				teamId,
				taskListId,
				leadName,
				style,
			});
			if (!cfg.members.some((mm) => mm.name === name)) {
				await upsertMember(teamDir, { name, role: "worker", status: "offline" });
			}
			await setMemberStatus(teamDir, name, "offline", {
				lastSeenAt: approved.timestamp,
				meta: {
					shutdownApprovedRequestId: approved.requestId,
					shutdownApprovedAt: approved.timestamp ?? new Date().toISOString(),
				},
			});
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownCompletedVerb}`, "info");
			continue;
		}

		const rejected = isShutdownRejected(m.text);
		if (rejected) {
			const name = sanitizeName(rejected.from);
			await setMemberStatus(teamDir, name, "online", {
				lastSeenAt: rejected.timestamp,
				meta: {
					shutdownRejectedAt: rejected.timestamp ?? new Date().toISOString(),
					shutdownRejectedReason: rejected.reason,
				},
			});
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownRefusedVerb}: ${rejected.reason}`, "warning");
			continue;
		}

		const planReq = isPlanApprovalRequest(m.text);
		if (planReq) {
			const name = sanitizeName(planReq.from);
			const preview = planReq.plan.length > 500 ? planReq.plan.slice(0, 500) + "..." : planReq.plan;
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} requests plan approval:\n${preview}`, "info");
			pendingPlanApprovals.set(name, {
				requestId: planReq.requestId,
				name,
				taskId: planReq.taskId,
			});
			continue;
		}

		const peerDm = isPeerDmSent(m.text);
		if (peerDm) {
			ctx.ui.notify(`${peerDm.from} → ${peerDm.to}: ${peerDm.summary}`, "info");
			continue;
		}

		const idle = isIdleNotification(m.text);
		if (idle) {
			const name = sanitizeName(idle.from);
			const marker = idleMarkers.get(m);
			const waitResolution = waitTracker && marker !== undefined
				? waitTracker.consumeIdleNotification({
					teamId,
					taskListId,
					name,
					completedTaskId: idle.completedTaskId,
					failureReason: idle.failureReason,
					marker,
				})
				: { wake: null, completedTaskWatch: false, suppressCompletionNotification: false };
			const waitWake = waitResolution.wake;
			if (waitWake && enqueueWaitWake) {
				enqueueWaitWake({
					key: `wait:${teamId}:${taskListId}:${name}:${waitWake.terminalId}`,
					teamId,
					taskListId,
					name,
					content: formatTeamWaitWake(style, waitWake),
				});
			} else if (waitWake && sendLeaderLlmMessage) {
				const waitMessage = formatTeamWaitWake(style, waitWake);
				try {
					if (ctx.isIdle()) sendLeaderLlmMessage(waitMessage);
					else sendLeaderLlmMessage(waitMessage, { deliverAs: "followUp" });
				} catch {
					ctx.ui.notify(`✅ ${waitMessage}`, "info");
				}
			}

			// Hook: always emit "idle" (best-effort, non-blocking)
			if (hooksActive) {
				try {
					enqueueHook?.({
						event: "idle",
						teamId,
						teamDir,
						taskListId,
						style,
						memberName: name,
						timestamp: idle.timestamp,
						completedTask: null,
					});
				} catch {
					// ignore hook enqueue errors
				}
			}

			// Hook: task completion / failure
			if (idle.completedTaskId) {
				const completedTask = await getTask(teamDir, taskListId, idle.completedTaskId);
				if (hooksActive) {
					try {
						enqueueHook?.({
							event: idle.completedStatus === "failed" ? "task_failed" : "task_completed",
							teamId,
							teamDir,
							taskListId,
							style,
							memberName: name,
							timestamp: idle.timestamp,
							completedTask,
						});
					} catch {
						// ignore hook enqueue errors
					}
				}

				// Event-driven batch tracking: mark this task done and
				// collect any batches that became fully complete.
				if (delegationTracker && idle.completedStatus !== "failed") {
					const completed = delegationTracker.markCompleted(idle.completedTaskId);
					if (!waitResolution.suppressCompletionNotification) batchCompletions.push(...completed);
				}
			}

			if (idle.failureReason) {
				const cfg = await ensureTeamConfig(teamDir, {
					teamId,
					taskListId,
					leadName,
					style,
				});
				if (!cfg.members.some((mm) => mm.name === name)) {
					await upsertMember(teamDir, { name, role: "worker", status: "offline" });
				}
				await setMemberStatus(teamDir, name, "offline", {
					lastSeenAt: idle.timestamp,
					meta: { offlineReason: idle.failureReason },
				});
				ctx.ui.notify(`${name} went offline (${idle.failureReason})`, "warning");
			} else {
				const desiredSessionName = `pi agent teams - ${strings.memberTitle.toLowerCase()} ${name}`;

				const cfg = await ensureTeamConfig(teamDir, {
					teamId,
					taskListId,
					leadName,
					style,
				});

				const member = cfg.members.find((mm) => mm.name === name);
				const existingSessionNameRaw = member?.meta?.["sessionName"];
				const existingSessionName = typeof existingSessionNameRaw === "string" ? existingSessionNameRaw : undefined;
				const shouldSendName = existingSessionName !== desiredSessionName;

				if (!member) {
					// Manual tmux worker: learn from idle notifications.
					await upsertMember(teamDir, {
						name,
						role: "worker",
						status: "online",
						lastSeenAt: idle.timestamp,
						meta: { sessionName: desiredSessionName },
					});
				} else {
					await setMemberStatus(teamDir, name, "online", {
						lastSeenAt: idle.timestamp,
						meta: { sessionName: desiredSessionName },
					});
				}

				if (shouldSendName) {
					try {
						const ts = new Date().toISOString();
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: leadName,
							text: JSON.stringify({
								type: "set_session_name",
								name: desiredSessionName,
								from: leadName,
								timestamp: ts,
							}),
							timestamp: ts,
						});
					} catch {
						// ignore
					}
				}

				if (idle.completedTaskId && idle.completedStatus === "failed") {
					ctx.ui.notify(`${name} aborted task #${idle.completedTaskId}`, "warning");

					// Inject failure notification into leader LLM conversation
					if ((sendLeaderLlmMessage || enqueueWaitWake) && !waitResolution.suppressCompletionNotification) {
						const task = await getTask(teamDir, taskListId, idle.completedTaskId);
						const subject = task?.subject ? `: ${task.subject}` : "";
						// Failed tasks store abort details, not the success-only `result` field.
						const abortReasonRaw = task?.metadata?.["abortReason"];
						const partialResultRaw = task?.metadata?.["partialResult"];
						const abortReason = typeof abortReasonRaw === "string" ? truncateResult(abortReasonRaw, 300) : undefined;
						const partialResult = typeof partialResultRaw === "string" ? truncateResult(partialResultRaw, 300) : undefined;
						const lines = [
							`[Team] ${formatMemberDisplayName(style, name)} failed task #${idle.completedTaskId}${subject}`,
						];
						if (abortReason) lines.push(`Reason: ${abortReason}`);
						if (partialResult) lines.push(`Partial result: ${partialResult}`);
						const content = lines.join("\n");
						if (waitResolution.completedTaskWatch && enqueueWaitWake) {
							enqueueWaitWake({
								key: `wait-completion:${teamId}:${taskListId}:${name}:${waitResolution.terminalId ?? `failed:${idle.completedTaskId}`}`,
								teamId,
								taskListId,
								name,
								content,
							});
						} else if (sendLeaderLlmMessage) {
							if (waitResolution.completedTaskWatch && ctx.isIdle()) sendLeaderLlmMessage(content);
							else sendLeaderLlmMessage(content, { deliverAs: "followUp" });
						}
					}
				} else if (idle.completedTaskId) {
					ctx.ui.notify(`${name} completed task #${idle.completedTaskId}`, "info");

					// Inject completion notification into leader LLM conversation
					if ((sendLeaderLlmMessage || enqueueWaitWake) && !waitResolution.suppressCompletionNotification) {
						const task = await getTask(teamDir, taskListId, idle.completedTaskId);
						const subject = task?.subject ? `: ${task.subject}` : "";
						const resultRaw = task?.metadata?.["result"];
						const result = typeof resultRaw === "string" ? truncateResult(resultRaw, 500) : undefined;
						const lines = [
							`[Team] ${formatMemberDisplayName(style, name)} completed task #${idle.completedTaskId}${subject}`,
						];
						if (result) lines.push(`Result: ${result}`);

						// Check if all tasks are now completed
						const allTasks = await listTasks(teamDir, taskListId);
						const totalTasks = allTasks.length;
						const completedTasks = allTasks.filter((t) => t.status === "completed");
						const allDone = totalTasks > 0 && completedTasks.length === totalTasks;

						if (allDone) {
							lines.push("");
							if (hooksActive) {
								// Hooks run asynchronously and may reopen tasks or create follow-ups.
								lines.push(`All ${totalTasks} task(s) show completed — quality gates are still running and may change task states.`);
							} else {
								lines.push(`All ${totalTasks} task(s) are now completed. Review results and determine next steps.`);
							}
						} else {
							const pending = allTasks.filter((t) => t.status === "pending").length;
							const inProgress = allTasks.filter((t) => t.status === "in_progress").length;
							lines.push(`Progress: ${completedTasks.length}/${totalTasks} done (${pending} pending, ${inProgress} in progress)`);
						}

						const content = lines.join("\n");
						if (waitResolution.completedTaskWatch && enqueueWaitWake) {
							enqueueWaitWake({
								key: `wait-completion:${teamId}:${taskListId}:${name}:${waitResolution.terminalId ?? `completed:${idle.completedTaskId}`}`,
								teamId,
								taskListId,
								name,
								content,
							});
						} else if (sendLeaderLlmMessage) {
							if (waitResolution.completedTaskWatch && ctx.isIdle()) sendLeaderLlmMessage(content);
							else sendLeaderLlmMessage(content, { deliverAs: "followUp" });
						}
					}
				} else {
					ctx.ui.notify(`${name} is idle`, "info");
				}
			}
			continue;
		}

		// Unrecognized message = teammate DM → route to leader LLM context
		if (sendLeaderLlmMessage) {
			sendLeaderLlmMessage(`[Team DM] ${m.from}: ${m.text}`, { deliverAs: "followUp" });
		} else {
			ctx.ui.notify(`Message from ${m.from}: ${m.text}`, "info");
		}
	}

	// Fire batch-complete notifications (deduplicated across this poll cycle).
	// Uses sendLeaderLlmMessage directly (without deliverAs) when idle so it
	// triggers a new LLM turn, waking the leader to review and continue.
	if (sendLeaderLlmMessage) {
		for (const batch of batchCompletions) {
			const taskRefs = batch.taskIds.map((id) => `#${id}`).join(", ");
			const suffix = hooksActive
				? "Quality gates are still running and may change task states."
				: "Review the results and continue.";
			const msg = `[Team] All delegated tasks completed (${taskRefs}). ${suffix}`;
			try {
				if (ctx.isIdle()) {
					sendLeaderLlmMessage(msg);
				} else {
					sendLeaderLlmMessage(msg, { deliverAs: "followUp" });
				}
			} catch {
				ctx.ui.notify(`✅ ${msg}`, "info");
			}
		}
	}
}
