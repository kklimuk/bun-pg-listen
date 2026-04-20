export type ReconnectDelayFn = (attempt: number) => number;

/** Exponential backoff starting at 1s, capped at 30s. */
export function defaultReconnectDelay(attempt: number): number {
	return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * Schedule `run` to execute after `delayFn(attempt)` ms. Returns a cancel
 * function; calling it is idempotent.
 */
export function scheduleReconnect(
	delayFn: ReconnectDelayFn,
	attempt: number,
	run: () => void,
): () => void {
	const delay = Math.max(0, delayFn(attempt));
	const timer = setTimeout(run, delay);
	return () => clearTimeout(timer);
}
