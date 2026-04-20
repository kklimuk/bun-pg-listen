import { describe, expect, test } from "bun:test";
import { buildTlsOptions } from "@src/connection.ts";

describe("buildTlsOptions", () => {
	test("sslmode=require enables TLS without cert verification", () => {
		const opts = buildTlsOptions("require", "db.example.com", undefined);
		expect(opts).toEqual({
			rejectUnauthorized: false,
			serverName: "db.example.com",
		});
	});

	test("sslmode=verify-full enables chain + hostname verification", () => {
		const opts = buildTlsOptions("verify-full", "db.example.com", undefined);
		expect(opts).toEqual({
			rejectUnauthorized: true,
			serverName: "db.example.com",
		});
	});

	test("sslmode=verify-ca verifies the chain (hostname tolerated in handshake filter)", () => {
		// Hostname-mismatch tolerance for verify-ca is enforced in
		// isToleratedAuthError, NOT by a blanket checkServerIdentity override.
		// See buildTlsOptions for why: centralising avoids a fail-open
		// regression if Bun ever honors rejectUnauthorized at the TLS layer.
		const opts = buildTlsOptions("verify-ca", "db.example.com", undefined) as {
			rejectUnauthorized: boolean;
			serverName?: string;
			checkServerIdentity?: unknown;
		};
		expect(opts.rejectUnauthorized).toBe(true);
		expect(opts.serverName).toBe("db.example.com");
		expect(opts.checkServerIdentity).toBeUndefined();
	});

	test("user-supplied ca merges with verify-full defaults", () => {
		const opts = buildTlsOptions("verify-full", "db.example.com", {
			ca: "-----BEGIN CERTIFICATE-----\n...",
		}) as { ca?: string; rejectUnauthorized: boolean; serverName: string };
		expect(opts.ca).toContain("BEGIN CERTIFICATE");
		expect(opts.rejectUnauthorized).toBe(true);
		expect(opts.serverName).toBe("db.example.com");
	});

	test("user fields override sslmode-derived defaults", () => {
		const opts = buildTlsOptions("verify-full", "db.example.com", {
			rejectUnauthorized: false,
		}) as { rejectUnauthorized: boolean };
		expect(opts.rejectUnauthorized).toBe(false);
	});

	test("user can promote sslmode=require to verify by setting rejectUnauthorized: true", () => {
		// This is the opt-in verification path the handshake gate enforces:
		// the effective `rejectUnauthorized` flag on the built options drives
		// the decision, not the sslmode alone.
		const opts = buildTlsOptions("require", "db.example.com", {
			ca: "-----BEGIN CERTIFICATE-----\n...",
			rejectUnauthorized: true,
		}) as { rejectUnauthorized: boolean; serverName: string; ca: string };
		expect(opts.rejectUnauthorized).toBe(true);
		expect(opts.serverName).toBe("db.example.com");
		expect(opts.ca).toContain("BEGIN CERTIFICATE");
	});

	test("boolean user tls leaves defaults intact", () => {
		const opts = buildTlsOptions("require", "db.example.com", true);
		expect(opts).toEqual({
			rejectUnauthorized: false,
			serverName: "db.example.com",
		});
	});
});
