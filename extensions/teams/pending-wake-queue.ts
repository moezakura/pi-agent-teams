export type PendingLeaderWake = {
	/** Stable terminal-event identity, used to suppress duplicate enqueue attempts. */
	key: string;
	teamId: string;
	taskListId: string;
	name: string;
	/** Monotonic leader scope captured when the inbox/refresh poll began. */
	scopeEpoch: number;
	/** Per-member epoch captured when the inbox/refresh poll began. */
	memberEpoch: number;
	content: string;
};

/** A terminal wake before the leader binds it to the currently active scope. */
export type PendingLeaderWakeCandidate = Omit<PendingLeaderWake, "scopeEpoch" | "memberEpoch">;

type PendingEntry = PendingLeaderWake & {
	attempts: number;
	nextAttemptAt: number;
};

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Retains terminal wait notifications until Pi accepts them. Worker state is
 * intentionally consumed before delivery, so this queue is the durable
 * in-memory handoff between terminal detection and leader-turn injection.
 */
export class PendingLeaderWakeQueue {
	private pending = new Map<string, PendingEntry>();

	enqueue(wake: PendingLeaderWake): boolean {
		if (this.pending.has(wake.key)) return false;
		this.pending.set(wake.key, { ...wake, attempts: 0, nextAttemptAt: 0 });
		return true;
	}

	flush(
		deliver: (wake: PendingLeaderWake) => void,
		now = Date.now(),
		onError?: (error: unknown) => void,
		isCurrent?: (wake: PendingLeaderWake) => boolean,
	): void {
		for (const [key, entry] of this.pending) {
			if (isCurrent && !isCurrent(entry)) {
				this.pending.delete(key);
				continue;
			}
			if (entry.nextAttemptAt > now) continue;
			try {
				deliver(entry);
				this.pending.delete(key);
			} catch (error) {
				entry.attempts++;
				entry.nextAttemptAt = now + Math.min(INITIAL_RETRY_MS * 2 ** (entry.attempts - 1), MAX_RETRY_MS);
				onError?.(error);
			}
		}
	}

	clear(): void {
		this.pending.clear();
	}

	clearScope(teamId: string, taskListId?: string): void {
		for (const [key, wake] of this.pending) {
			if (wake.teamId === teamId && (taskListId === undefined || wake.taskListId === taskListId)) this.pending.delete(key);
		}
	}

	clearMember(teamId: string, taskListId: string, name: string): void {
		for (const [key, wake] of this.pending) {
			if (wake.teamId === teamId && wake.taskListId === taskListId && wake.name === name) this.pending.delete(key);
		}
	}

	size(): number {
		return this.pending.size;
	}
}
