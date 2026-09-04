/** Handle returned by the scheduler used for the independent wait monitor. */
export type WaitPollTimer = { unref?: () => void };

export type WaitPollLoopOptions = {
	poll: () => void | Promise<void>;
	onError?: (error: unknown) => void;
	intervalMs?: number;
	/** Injectable for deterministic liveness tests. */
	schedule?: (callback: () => void, intervalMs: number) => WaitPollTimer;
	cancel?: (timer: WaitPollTimer) => void;
};

export type WaitPollLoop = {
	stop: () => void;
};

/**
 * Run wait monitoring independently of refresh/heartbeat work. A stalled or
 * rejected filesystem refresh must never prevent terminal RPC state from
 * waking an already-registered wait.
 */
export function startWaitPollLoop(opts: WaitPollLoopOptions): WaitPollLoop {
	const schedule = opts.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
	const cancel = opts.cancel ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
	let inFlight = false;
	let stopped = false;

	const tick = (): void => {
		if (stopped || inFlight) return;
		inFlight = true;
		Promise.resolve()
			.then(opts.poll)
			.catch((error: unknown) => opts.onError?.(error))
			.finally(() => {
				inFlight = false;
			});
	};

	const timer = schedule(tick, opts.intervalMs ?? 1_000);
	timer.unref?.();

	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			cancel(timer);
		},
	};
}
