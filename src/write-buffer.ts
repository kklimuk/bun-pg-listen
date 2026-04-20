/**
 * FIFO queue that preserves write order across partial socket writes.
 *
 * NOT a backpressure mechanism. Callers still need their own flow control
 * to bound memory — in this codebase the per-op `pendingOps` promise chain
 * provides that naturally (each LISTEN / NOTIFY / UNLISTEN awaits
 * `ReadyForQuery` before the next is issued). The `maxBytes` guard exists
 * only to convert a runaway caller into a loud throw rather than silent
 * OOM.
 *
 * The `write` callback returns the number of bytes accepted by the socket:
 *   `> 0` partial accept — tail is re-queued
 *   `= 0` short write — full chunk is re-queued (socket buffer is full;
 *          `drain` will fire later)
 *   `< 0` socket is closed — queue is cleared and `push` throws
 *          `WriteBufferClosedError`. This race happens when the peer sends
 *          FIN between our `send()` guard check and the `write` call.
 */
export type Writer = (bytes: Uint8Array) => number;

export class WriteBufferClosedError extends Error {
	constructor() {
		super("Socket refused write (connection is closed)");
		this.name = "WriteBufferClosedError";
	}
}

export class WriteBufferOverflowError extends Error {
	readonly queuedBytes: number;
	readonly maxBytes: number;
	constructor(queuedBytes: number, maxBytes: number) {
		super(
			`WriteBuffer overflow: ${queuedBytes} bytes queued exceeds ${maxBytes}-byte limit. ` +
				"Slow down or await in-flight operations before issuing more writes.",
		);
		this.name = "WriteBufferOverflowError";
		this.queuedBytes = queuedBytes;
		this.maxBytes = maxBytes;
	}
}

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

export class WriteBuffer {
	private queue: Uint8Array[] = [];
	private queuedBytes = 0;

	constructor(readonly maxBytes = DEFAULT_MAX_BYTES) {}

	get length(): number {
		return this.queue.length;
	}

	get bytesQueued(): number {
		return this.queuedBytes;
	}

	push(bytes: Uint8Array, write: Writer): void {
		if (this.queue.length > 0) {
			this.enqueue(bytes);
			return;
		}
		const written = write(bytes);
		if (written < 0) {
			this.clear();
			throw new WriteBufferClosedError();
		}
		if (written < bytes.byteLength) {
			this.enqueue(bytes.subarray(written));
		}
	}

	flush(write: Writer): void {
		while (this.queue.length > 0) {
			const head = this.queue[0];
			if (!head) {
				this.queue.shift();
				continue;
			}
			const written = write(head);
			if (written < 0) {
				this.clear();
				return;
			}
			if (written < head.byteLength) {
				const remainder = head.subarray(written);
				this.queuedBytes -= head.byteLength - remainder.byteLength;
				this.queue[0] = remainder;
				return;
			}
			this.queuedBytes -= head.byteLength;
			this.queue.shift();
		}
	}

	clear(): void {
		this.queue = [];
		this.queuedBytes = 0;
	}

	private enqueue(bytes: Uint8Array): void {
		const nextTotal = this.queuedBytes + bytes.byteLength;
		if (nextTotal > this.maxBytes) {
			throw new WriteBufferOverflowError(nextTotal, this.maxBytes);
		}
		this.queue.push(bytes);
		this.queuedBytes = nextTotal;
	}
}
