import { afterEach, describe, expect, test } from "bun:test";
import { PgListener } from "@src/index.ts";

const DEFAULT_URL =
	"postgres://bun_pg_listen:test_password@localhost:54329/bun_pg_listen_test";
const BASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;

function urlWithSslmode(mode: string): string {
	const url = new URL(BASE_URL);
	url.searchParams.set("sslmode", mode);
	return url.toString();
}

const live = new Set<PgListener>();
afterEach(async () => {
	for (const l of live) await l.close().catch(() => {});
	live.clear();
});
function track(l: PgListener): PgListener {
	live.add(l);
	return l;
}

describe("TLS against a Postgres with a self-signed cert", () => {
	test("sslmode=require connects (opportunistic TLS, no cert verification)", async () => {
		const listener = track(new PgListener(urlWithSslmode("require")));
		await listener.connect();
		expect(listener.getState()).toBe("ready");
	});

	test("sslmode=verify-full rejects the self-signed cert", async () => {
		const listener = track(new PgListener(urlWithSslmode("verify-full")));
		await expect(listener.connect()).rejects.toThrow(
			/self[-\s]?signed|certificate|CERT_|unable to (verify|get)/i,
		);
		expect(listener.getState()).not.toBe("ready");
	});

	test("sslmode=verify-ca also rejects — chain verification still fails", async () => {
		// verify-ca skips hostname checks but keeps chain verification. The
		// self-signed cert has no trusted chain, so this still fails.
		// (verify-ca would *accept* a privately-signed cert whose SAN didn't
		// match the hostname; that path needs a trusted private CA and is
		// out of scope for the default docker-compose fixture.)
		const listener = track(new PgListener(urlWithSslmode("verify-ca")));
		await expect(listener.connect()).rejects.toThrow(
			/self[-\s]?signed|certificate|CERT_|unable to (verify|get)/i,
		);
		expect(listener.getState()).not.toBe("ready");
	});

	test("user can promote sslmode=require to verified TLS via tls.rejectUnauthorized", async () => {
		// Guards the footgun fix: passing rejectUnauthorized: true on top of
		// sslmode=require must actually enforce cert verification.
		const listener = track(
			new PgListener(urlWithSslmode("require"), {
				tls: { rejectUnauthorized: true },
			}),
		);
		await expect(listener.connect()).rejects.toThrow(
			/self[-\s]?signed|certificate|CERT_|unable to (verify|get)/i,
		);
	});
});
