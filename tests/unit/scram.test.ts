import { describe, expect, test } from "bun:test";
import {
	continueSession,
	finalizeSession,
	SCRAM_SHA_256,
	type ScramSession,
	startSession,
} from "@src/scram.ts";

/**
 * RFC 7677 §3 worked example. Password is "pencil".
 * We override `clientFirstMessageBare` to match the RFC's `n=user`
 * (Postgres always sends `n=*`, but the math works the same).
 */
describe("SCRAM-SHA-256 RFC 7677 worked example", () => {
	const session: ScramSession = {
		mechanism: SCRAM_SHA_256,
		clientNonce: "rOprNGfwEbeRWgbNEkqO",
		clientFirstMessageBare: "n=user,r=rOprNGfwEbeRWgbNEkqO",
		clientFirstMessage: "n,,n=user,r=rOprNGfwEbeRWgbNEkqO",
	};
	const serverFirst =
		"r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
	const expectedFinal =
		"c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
	const expectedServerSignature =
		"6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

	test("continueSession produces documented client-final-message and expected signature", () => {
		const result = continueSession(session, "pencil", serverFirst);
		expect(result.clientFinalMessage).toBe(expectedFinal);
		expect(result.expectedServerSignature).toBe(expectedServerSignature);
	});

	test("finalizeSession accepts matching server signature", () => {
		expect(() =>
			finalizeSession(expectedServerSignature, `v=${expectedServerSignature}`),
		).not.toThrow();
	});
});

describe("SCRAM-SHA-256 error handling", () => {
	const baseSession = startSession("abc123");
	const serverFirst = "r=abc123XYZ,s=c2FsdA==,i=4096";

	test("throws when server nonce does not extend client nonce", () => {
		expect(() =>
			continueSession(baseSession, "pw", "r=wrongnonce,s=c2FsdA==,i=4096"),
		).toThrow(/does not extend/);
	});

	test("throws on missing fields", () => {
		expect(() =>
			continueSession(baseSession, "pw", "r=abc123XYZ,s=c2FsdA=="),
		).toThrow(/missing r\/s\/i/);
	});

	test("throws on non-numeric iteration count", () => {
		expect(() =>
			continueSession(baseSession, "pw", "r=abc123XYZ,s=c2FsdA==,i=notanumber"),
		).toThrow(/invalid iteration count/);
	});

	test("rejects absurdly high iteration counts before running PBKDF2", () => {
		// A hostile / MITM-tampered server sending `i=2147483647` would freeze
		// the event loop inside pbkdf2Sync. The cap keeps that synchronous
		// work bounded.
		const start = Date.now();
		expect(() =>
			continueSession(baseSession, "pw", "r=abc123XYZ,s=c2FsdA==,i=2147483647"),
		).toThrow(/exceeds maximum/);
		// If we ever regressed and actually ran pbkdf2Sync with 2B iterations,
		// this test would hang for many seconds. Assert we bailed fast.
		expect(Date.now() - start).toBeLessThan(1000);
	});

	test("finalizeSession throws on mismatched verifier", () => {
		const { expectedServerSignature } = continueSession(
			baseSession,
			"pw",
			serverFirst,
		);
		// Use a same-length wrong signature so we exercise the
		// timingSafeEqual path, not the length pre-check.
		const wrong = Buffer.alloc(32, 0xff).toString("base64");
		expect(() =>
			finalizeSession(expectedServerSignature, `v=${wrong}`),
		).toThrow(/server signature mismatch/);
	});

	test("finalizeSession surfaces server error", () => {
		expect(() => finalizeSession("ignored", "e=invalid-proof")).toThrow(
			/invalid-proof/,
		);
	});

	test("finalizeSession throws when verifier missing and no error", () => {
		expect(() => finalizeSession("ignored", "x=nothing")).toThrow(
			/missing verifier/,
		);
	});
});

describe("startSession defaults", () => {
	test("generates a non-empty base64 nonce", () => {
		const s = startSession();
		expect(s.clientNonce.length).toBeGreaterThan(16);
		expect(s.clientFirstMessage).toBe(`n,,${s.clientFirstMessageBare}`);
		expect(s.clientFirstMessageBare).toBe(`n=*,r=${s.clientNonce}`);
	});

	test("produces unique nonces on repeated calls", () => {
		const a = startSession();
		const b = startSession();
		expect(a.clientNonce).not.toBe(b.clientNonce);
	});
});
