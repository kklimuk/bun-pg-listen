import { afterEach, describe, expect, test } from "bun:test";
import { PayloadTooLargeError, PgListener } from "@src/index.ts";

const DEFAULT_URL =
	"postgres://bun_pg_listen:test_password@localhost:54329/bun_pg_listen_test";
const URL = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;

const liveListeners = new Set<PgListener>();
afterEach(async () => {
	for (const l of liveListeners) await l.close().catch(() => {});
	liveListeners.clear();
});

function make(
	options: ConstructorParameters<typeof PgListener>[1] = {},
): PgListener {
	const l = new PgListener(URL, options);
	liveListeners.add(l);
	return l;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
	tickMs = 10,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await Bun.sleep(tickMs);
	}
}

describe("PgListener against real Postgres 18", () => {
	test("listen + notify round-trips", async () => {
		const receiver = make();
		await receiver.connect();
		const received: string[] = [];
		await receiver.listen("demo", (payload) => received.push(payload));

		const publisher = make();
		await publisher.connect();
		await publisher.notify("demo", "hello");
		await publisher.notify("demo", "world");

		await waitFor(() => received.length === 2);
		expect(received).toEqual(["hello", "world"]);
	});

	test("channel isolation: callbacks only fire for their own channel", async () => {
		const receiver = make();
		await receiver.connect();
		const aEvents: string[] = [];
		const bEvents: string[] = [];
		await receiver.listen("channel_a", (p) => aEvents.push(p));
		await receiver.listen("channel_b", (p) => bEvents.push(p));

		const publisher = make();
		await publisher.connect();
		await publisher.notify("channel_a", "a-msg");
		await publisher.notify("channel_b", "b-msg");

		await waitFor(() => aEvents.length === 1 && bEvents.length === 1);
		expect(aEvents).toEqual(["a-msg"]);
		expect(bEvents).toEqual(["b-msg"]);
	});

	test("unlisten stops callback from firing", async () => {
		const receiver = make();
		await receiver.connect();
		const events: string[] = [];
		const unlisten = await receiver.listen("once", (p) => events.push(p));

		const publisher = make();
		await publisher.connect();
		await publisher.notify("once", "first");
		await waitFor(() => events.length === 1);

		await unlisten();
		await publisher.notify("once", "second");
		// Give the server a beat to fail to dispatch the un-subscribed message.
		await Bun.sleep(100);
		expect(events).toEqual(["first"]);
	});

	test("multiple listen() callbacks on the same channel both fire", async () => {
		const receiver = make();
		await receiver.connect();
		const a: string[] = [];
		const b: string[] = [];
		await receiver.listen("shared", (p) => a.push(p));
		await receiver.listen("shared", (p) => b.push(p));

		const publisher = make();
		await publisher.connect();
		await publisher.notify("shared", "ping");

		await waitFor(() => a.length === 1 && b.length === 1);
		expect(a).toEqual(["ping"]);
		expect(b).toEqual(["ping"]);
	});

	test("empty payload is delivered as empty string", async () => {
		const receiver = make();
		await receiver.connect();
		let received: string | undefined;
		await receiver.listen("bare", (p) => (received = p));

		const publisher = make();
		await publisher.connect();
		await publisher.notify("bare");

		await waitFor(() => received !== undefined);
		expect(received).toBe("");
	});

	test("7999-byte payload is accepted, 8000+ rejects locally", async () => {
		const receiver = make();
		await receiver.connect();
		let received: string | undefined;
		await receiver.listen("sized", (p) => (received = p));

		const publisher = make();
		await publisher.connect();
		const okPayload = "x".repeat(7999);
		await publisher.notify("sized", okPayload);
		await waitFor(() => received !== undefined);
		expect(received?.length).toBe(7999);

		await expect(
			publisher.notify("sized", "y".repeat(8000)),
		).rejects.toBeInstanceOf(PayloadTooLargeError);
	});

	test("escapes special characters in channel names and payloads", async () => {
		const receiver = make();
		await receiver.connect();
		let received: { channel: string; payload: string } | undefined;
		await receiver.listen('weird"name', (payload, channel) => {
			received = { channel, payload };
		});

		const publisher = make();
		await publisher.connect();
		// Payload contains the SCRAM-unfriendly characters: ' " \ ,
		await publisher.notify('weird"name', 'it\'s "fine"');

		await waitFor(() => received !== undefined);
		expect(received).toEqual({
			channel: 'weird"name',
			payload: 'it\'s "fine"',
		});
	});

	test("onConnect fires on fresh connect", async () => {
		let fired = false;
		const listener = make({ onConnect: () => (fired = true) });
		await listener.connect();
		// onConnect is queued via microtask
		await Bun.sleep(10);
		expect(fired).toBe(true);
	});

	test("many concurrent max-size NOTIFYs all deliver in order", async () => {
		// Exercises Connection.send() backpressure path. Each NOTIFY SQL is
		// ~16KB after payload escaping; firing them in parallel stacks bytes
		// into the kernel send buffer faster than the server can drain them.
		const receiver = make();
		await receiver.connect();
		const received: number[] = [];
		await receiver.listen("flood", (payload) => {
			const seq = Number.parseInt(payload.slice(0, 6), 10);
			received.push(seq);
		});

		const publisher = make();
		await publisher.connect();
		const COUNT = 200;
		const filler = "x".repeat(7999 - 6);
		await Promise.all(
			Array.from({ length: COUNT }, (_, i) =>
				publisher.notify("flood", String(i).padStart(6, "0") + filler),
			),
		);

		await waitFor(() => received.length === COUNT, 15_000);
		expect(received).toEqual(Array.from({ length: COUNT }, (_, i) => i));
	});

	test("close() is idempotent and rejects pending", async () => {
		const l = make();
		await l.connect();
		await l.close();
		await l.close();
		expect(l.getState()).toBe("closed");
	});
});
