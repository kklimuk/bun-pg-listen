import { afterEach, describe, expect, test } from "bun:test";
import {
	Connection,
	type ConnectionHandlers,
	resolveConfig,
} from "@src/index.ts";

const DEFAULT_URL =
	"postgres://bun_pg_listen:test_password@localhost:54329/bun_pg_listen_test";
const URL = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;

function makeConnection(handlers: ConnectionHandlers = {}): Connection {
	return new Connection(resolveConfig(URL), handlers);
}

const liveConnections = new Set<Connection>();
afterEach(async () => {
	for (const c of liveConnections) await c.close().catch(() => {});
	liveConnections.clear();
});
function track<T extends Connection>(c: T): T {
	liveConnections.add(c);
	return c;
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

describe("Connection against real Postgres 18 (plaintext + SCRAM)", () => {
	test("connect() resolves and reaches ready state", async () => {
		const conn = track(makeConnection());
		await conn.connect();
		expect(conn.getState()).toBe("ready");
	});

	test("fires onCommandComplete for a trivial query", async () => {
		let tag: string | undefined;
		const conn = track(makeConnection({ onCommandComplete: (t) => (tag = t) }));
		await conn.connect();
		conn.query("SELECT 1");
		await waitFor(() => tag !== undefined);
		expect(tag).toBe("SELECT 1");
	});

	test("delivers NOTIFY payload to a LISTENing connection", async () => {
		let received: { channel: string; payload: string } | undefined;
		const listenerTags: string[] = [];
		const listener = track(
			makeConnection({
				onNotification: (channel, payload) => {
					received = { channel, payload };
				},
				onCommandComplete: (tag) => listenerTags.push(tag),
			}),
		);
		await listener.connect();
		listener.query("LISTEN test_channel");
		await waitFor(() => listenerTags.includes("LISTEN"));

		const notifierTags: string[] = [];
		const notifier = track(
			makeConnection({ onCommandComplete: (t) => notifierTags.push(t) }),
		);
		await notifier.connect();
		notifier.query("NOTIFY test_channel, 'hello world'");
		await waitFor(() => notifierTags.includes("NOTIFY"));

		await waitFor(() => received !== undefined);
		expect(received).toEqual({
			channel: "test_channel",
			payload: "hello world",
		});
	});

	test("rejects connect() with an error on wrong password", async () => {
		const badConfig = resolveConfig(URL, { password: "wrong_password" });
		const conn = track(new Connection(badConfig));
		await expect(conn.connect()).rejects.toThrow();
	});

	test("close() is idempotent", async () => {
		const conn = track(makeConnection());
		await conn.connect();
		await conn.close();
		await conn.close();
		expect(conn.getState()).toBe("closed");
	});
});
