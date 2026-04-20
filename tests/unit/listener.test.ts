import { describe, expect, test } from "bun:test";
import {
	ConnectionNotReadyError,
	escapeIdentifier,
	escapeLiteral,
	PayloadTooLargeError,
	PgListener,
} from "@src/index.ts";

describe("escapeIdentifier", () => {
	test("wraps plain names in double quotes", () => {
		expect(escapeIdentifier("page_updates")).toBe('"page_updates"');
	});

	test("doubles embedded double quotes", () => {
		expect(escapeIdentifier('weird"name')).toBe('"weird""name"');
	});

	test("preserves characters that would be unsafe as bare identifiers", () => {
		expect(escapeIdentifier("has space")).toBe('"has space"');
		expect(escapeIdentifier("UPPER")).toBe('"UPPER"');
		expect(escapeIdentifier("with-dash")).toBe('"with-dash"');
	});

	test("quote-injection attempt is neutralised", () => {
		// A naive `"<name>"` wrapper would let an attacker close the identifier
		// and append SQL. Doubling the `"` keeps the whole string inside the
		// quoted identifier.
		expect(escapeIdentifier('"; DROP TABLE users; --')).toBe(
			'"""; DROP TABLE users; --"',
		);
	});

	test("rejects empty string", () => {
		expect(() => escapeIdentifier("")).toThrow(/cannot be empty/);
	});

	test("rejects null bytes (Postgres disallows them in strings)", () => {
		expect(() => escapeIdentifier("ab\0c")).toThrow(/null byte/);
	});

	test("accepts identifiers at the 63-byte limit", () => {
		const maxLen = "x".repeat(63);
		expect(() => escapeIdentifier(maxLen)).not.toThrow();
	});

	test("rejects identifiers past 63 bytes (would silently truncate server-side)", () => {
		const tooLong = "x".repeat(64);
		expect(() => escapeIdentifier(tooLong)).toThrow(/64 bytes; Postgres limit/);
	});

	test("length check counts bytes, not code points — emoji count as 4 each", () => {
		// 16 emoji × 4 bytes = 64 bytes — one over the limit.
		const sixteenEmoji = "🚀".repeat(16);
		expect(() => escapeIdentifier(sixteenEmoji)).toThrow(/64 bytes/);
	});
});

describe("escapeLiteral", () => {
	test("uses E-string and wraps payload", () => {
		expect(escapeLiteral("hello")).toBe("E'hello'");
	});

	test("doubles embedded single quotes", () => {
		expect(escapeLiteral("it's fine")).toBe("E'it''s fine'");
	});

	test("doubles embedded backslashes (needed for E-strings)", () => {
		expect(escapeLiteral("path\\to\\thing")).toBe("E'path\\\\to\\\\thing'");
	});

	test("quote-injection attempt is neutralised", () => {
		expect(escapeLiteral("'; DROP TABLE users; --")).toBe(
			"E'''; DROP TABLE users; --'",
		);
	});

	test("payload ending in a backslash parses under both string-mode settings", () => {
		// Without `\\` doubling, `'\\'` would mean something different under
		// `standard_conforming_strings = off` (escape char for next char) than
		// under `standard_conforming_strings = on` (literal backslash). With
		// E-string + `\\` we are unambiguous.
		expect(escapeLiteral("a\\")).toBe("E'a\\\\'");
	});

	test("rejects null bytes", () => {
		expect(() => escapeLiteral("a\0b")).toThrow(/null byte/);
	});

	test("unicode passes through unchanged", () => {
		expect(escapeLiteral("héllo 🚀")).toBe("E'héllo 🚀'");
	});
});

describe("PgListener constructor", () => {
	test("accepts (urlString, options)", () => {
		const l = new PgListener("postgres://u:p@h:1234/d", {
			applicationName: "x",
		});
		expect(l.getState()).toBe("idle");
	});

	test("accepts options-only form with individual fields", () => {
		const l = new PgListener({
			hostname: "h",
			port: 1234,
			user: "u",
			password: "p",
			database: "d",
		});
		expect(l.getState()).toBe("idle");
	});

	test("accepts no-args (resolves from env defaults)", () => {
		const l = new PgListener();
		expect(l.getState()).toBe("idle");
	});

	test("throws if connect() is called a second time", async () => {
		// We don't connect here (no postgres reachable at invalid host).
		// Trigger the state guard directly via a double-connect on a port that
		// refuses — the first connect rejects, state returns to idle, so a
		// second connect is allowed. Use a never-resolving invalid host to
		// keep state=connecting.
		const l = new PgListener({
			hostname: "127.0.0.1",
			port: 1, // reserved, refused
			user: "u",
			password: "p",
			database: "d",
			connectTimeoutMs: 5000,
		});
		const p1 = l.connect();
		await expect(l.connect()).rejects.toThrow(/state connecting/);
		// Clean up the first attempt.
		await p1.catch(() => {});
		await l.close();
	});
});

describe("PgListener guards on non-ready state", () => {
	test("notify() on idle listener throws ConnectionNotReadyError", async () => {
		const l = new PgListener("postgres://u:p@h/d");
		await expect(l.notify("ch", "p")).rejects.toBeInstanceOf(
			ConnectionNotReadyError,
		);
	});

	test("listen() on idle listener throws ConnectionNotReadyError", async () => {
		const l = new PgListener("postgres://u:p@h/d");
		await expect(l.listen("ch", () => {})).rejects.toBeInstanceOf(
			ConnectionNotReadyError,
		);
	});

	test("close() on never-connected listener is a no-op", async () => {
		const l = new PgListener("postgres://u:p@h/d");
		await l.close();
		expect(l.getState()).toBe("closed");
	});
});

describe("payload size validation", () => {
	test("PayloadTooLargeError reports the offending byte count", () => {
		const err = new PayloadTooLargeError(9001);
		expect(err.size).toBe(9001);
		expect(err.limit).toBe(8000);
		expect(err.message).toContain("9001");
		expect(err.message).toContain("8000");
	});
});
