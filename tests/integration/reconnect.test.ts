import { afterEach, describe, expect, test } from "bun:test";
import {
	Connection,
	ConnectionClosedError,
	PgListener,
	resolveConfig,
} from "@src/index.ts";

const DEFAULT_URL =
	"postgres://bun_pg_listen:test_password@localhost:54329/bun_pg_listen_test";
const URL = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;

const live = new Set<PgListener | Connection>();
afterEach(async () => {
	for (const c of live) await c.close().catch(() => {});
	live.clear();
});

function trackListener(
	opts: ConstructorParameters<typeof PgListener>[1] = {},
): PgListener {
	const l = new PgListener(URL, opts);
	live.add(l);
	return l;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	tickMs = 10,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await Bun.sleep(tickMs);
	}
}

type Killer = {
	kill: (appName: string) => Promise<void>;
	close: () => Promise<void>;
};

/**
 * A reusable connection that can terminate other backends. Avoids paying
 * the SCRAM handshake cost inside timing-sensitive tests.
 */
async function makeKiller(): Promise<Killer> {
	let pendingResolve: (() => void) | undefined;
	const conn = new Connection(resolveConfig(URL), {
		onCommandComplete: () => pendingResolve?.(),
	});
	live.add(conn);
	await conn.connect();
	return {
		async kill(appName: string) {
			await new Promise<void>((resolve) => {
				pendingResolve = resolve;
				conn.query(
					`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${appName}' AND pid <> pg_backend_pid()`,
				);
			});
		},
		async close() {
			await conn.close();
			live.delete(conn);
		},
	};
}

describe("PgListener reconnect", () => {
	test("re-LISTENs channels and fires onReconnect after a backend termination", async () => {
		const appName = `reconnect-${crypto.randomUUID().slice(0, 8)}`;
		const received: string[] = [];
		let reconnectedAt: number | undefined;

		const listener = trackListener({
			applicationName: appName,
			reconnectDelayMs: () => 50,
			onReconnect: () => {
				reconnectedAt = Date.now();
			},
		});
		await listener.connect();
		await listener.listen("recon", (p) => received.push(p));

		// Publish once to confirm baseline delivery works
		const publisher = trackListener();
		await publisher.connect();
		await publisher.notify("recon", "before");
		await waitFor(() => received.length === 1);
		expect(received).toEqual(["before"]);

		// Terminate the listener's backend from a third connection
		const killer = await makeKiller();
		await killer.kill(appName);

		// Listener must reconnect and re-LISTEN
		await waitFor(() => reconnectedAt !== undefined);
		expect(listener.getState()).toBe("ready");

		// After reconnect, a fresh NOTIFY still reaches the callback
		await publisher.notify("recon", "after");
		await waitFor(() => received.length === 2, 3000);
		expect(received).toEqual(["before", "after"]);

		await killer.close();
	});

	test("close() rejects in-flight notify() with ConnectionClosedError", async () => {
		const listener = trackListener();
		await listener.connect();
		// Fire notify but don't await — close() should synchronously reject the
		// pending op before any ReadyForQuery arrives.
		const pending = listener.notify("ch", "x");
		await listener.close();
		await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
	});

	test("onConnect fires on the first connect; onReconnect fires on subsequent reconnects", async () => {
		const appName = `fires-${crypto.randomUUID().slice(0, 8)}`;
		let connectCount = 0;
		let reconnectCount = 0;
		const listener = trackListener({
			applicationName: appName,
			reconnectDelayMs: () => 50,
			onConnect: () => {
				connectCount += 1;
			},
			onReconnect: () => {
				reconnectCount += 1;
			},
		});

		await listener.connect();
		await waitFor(() => connectCount === 1);
		expect(reconnectCount).toBe(0);

		const killer = await makeKiller();
		await killer.kill(appName);
		await waitFor(() => reconnectCount === 1);
		expect(connectCount).toBe(1); // onConnect is only for the initial handshake

		await killer.close();
	});
});
