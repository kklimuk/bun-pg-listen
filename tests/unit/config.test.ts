import { describe, expect, test } from "bun:test";
import { redactUrl, resolveConfig } from "@src/config.ts";

const EMPTY_ENV = {};

describe("resolveConfig URL precedence", () => {
	test("explicit URL beats every env var", () => {
		const cfg = resolveConfig("postgres://u:p@h:5555/d", undefined, {
			POSTGRES_URL: "postgres://env:env@env:5432/env",
			DATABASE_URL: "postgres://env:env@env:5432/env",
		});
		expect(cfg).toMatchObject({
			host: "h",
			port: 5555,
			user: "u",
			password: "p",
			database: "d",
		});
	});

	test("POSTGRES_URL beats DATABASE_URL", () => {
		const cfg = resolveConfig(undefined, undefined, {
			POSTGRES_URL: "postgres://a@pg/pga",
			DATABASE_URL: "postgres://b@db/dbb",
		});
		expect(cfg).toMatchObject({ host: "pg", user: "a", database: "pga" });
	});

	test("DATABASE_URL beats PGURL", () => {
		const cfg = resolveConfig(undefined, undefined, {
			DATABASE_URL: "postgres://a@db/dbd",
			PGURL: "postgres://b@pg/pgp",
		});
		expect(cfg).toMatchObject({ host: "db", user: "a" });
	});

	test("PGURL beats PG_URL", () => {
		const cfg = resolveConfig(undefined, undefined, {
			PGURL: "postgres://a@pgurl/x",
			PG_URL: "postgres://b@pg_url/x",
		});
		expect(cfg.host).toBe("pgurl");
	});

	test("falls back to TLS_POSTGRES_DATABASE_URL when no plain URL present", () => {
		const cfg = resolveConfig(undefined, undefined, {
			TLS_POSTGRES_DATABASE_URL: "postgres://a@tls/x",
		});
		expect(cfg.host).toBe("tls");
		expect(cfg.sslmode).toBe("require");
	});

	test("plain env URL takes precedence over TLS_* env var", () => {
		const cfg = resolveConfig(undefined, undefined, {
			DATABASE_URL: "postgres://a@plain/x",
			TLS_DATABASE_URL: "postgres://b@tls/x",
		});
		expect(cfg.host).toBe("plain");
		expect(cfg.sslmode).toBe("disable");
	});
});

describe("individual PG* env var fallbacks", () => {
	test("uses PGHOST/PGPORT/PGUSERNAME/PGPASSWORD/PGDATABASE when no URL", () => {
		const cfg = resolveConfig(undefined, undefined, {
			PGHOST: "h",
			PGPORT: "5555",
			PGUSERNAME: "u",
			PGPASSWORD: "p",
			PGDATABASE: "d",
		});
		expect(cfg).toMatchObject({
			host: "h",
			port: 5555,
			user: "u",
			database: "d",
			sslmode: "disable",
		});
		expect(cfg.password).toBe("p"); // non-enumerable, asserted separately
	});

	test("PGUSERNAME > PGUSER > USER > USERNAME > 'postgres'", () => {
		expect(resolveConfig(undefined, undefined, { PGUSER: "pguser" }).user).toBe(
			"pguser",
		);
		expect(resolveConfig(undefined, undefined, { USER: "user" }).user).toBe(
			"user",
		);
		expect(
			resolveConfig(undefined, undefined, { USERNAME: "usern" }).user,
		).toBe("usern");
		expect(resolveConfig(undefined, undefined, {}).user).toBe("postgres");
	});

	test("database defaults to user when missing", () => {
		const cfg = resolveConfig(undefined, undefined, { PGUSER: "alice" });
		expect(cfg.database).toBe("alice");
	});

	test("URL fills partial; env fills rest", () => {
		const cfg = resolveConfig("postgres://someuser@onlyhost/d", undefined, {
			PGPORT: "6543",
			PGPASSWORD: "frompw",
		});
		expect(cfg).toMatchObject({
			host: "onlyhost",
			port: 6543,
			user: "someuser",
			password: "frompw",
			database: "d",
		});
	});

	test("empty env value is ignored (treated as unset)", () => {
		const cfg = resolveConfig(undefined, undefined, { PGHOST: "" });
		expect(cfg.host).toBe("localhost");
	});
});

describe("inline options override URL and env", () => {
	test("options.hostname / port / user / password / database win over URL", () => {
		const cfg = resolveConfig("postgres://urluser:urlpw@urlhost:5432/urldb", {
			hostname: "opthost",
			port: 6543,
			user: "optuser",
			password: "optpw",
			database: "optdb",
		});
		expect(cfg).toMatchObject({
			host: "opthost",
			port: 6543,
			user: "optuser",
			password: "optpw",
			database: "optdb",
		});
	});

	test("host alias also accepted (Bun.sql uses `hostname`, libpq uses `host`)", () => {
		const cfg = resolveConfig(undefined, { host: "aliased" });
		expect(cfg.host).toBe("aliased");
	});

	test("username alias also accepted", () => {
		const cfg = resolveConfig(undefined, { username: "viaUsername" });
		expect(cfg.user).toBe("viaUsername");
	});

	test("no URL needed if all required fields come from options", () => {
		const cfg = resolveConfig(
			undefined,
			{ hostname: "h", user: "u", password: "p", database: "d" },
			{},
		);
		expect(cfg).toMatchObject({
			host: "h",
			user: "u",
			password: "p",
			database: "d",
			port: 5432,
		});
	});

	test("options can be combined with URL-based env defaults", () => {
		const cfg = resolveConfig(
			undefined,
			{ user: "optuser" },
			{ DATABASE_URL: "postgres://envuser:envpw@envhost:5432/envdb" },
		);
		expect(cfg).toMatchObject({
			host: "envhost",
			user: "optuser", // options wins
			password: "envpw", // falls through to URL
			database: "envdb",
		});
	});
});

describe("defaults", () => {
	test("no URL, no env → localhost:5432 postgres/postgres", () => {
		const cfg = resolveConfig(undefined, undefined, EMPTY_ENV);
		expect(cfg).toMatchObject({
			host: "localhost",
			port: 5432,
			user: "postgres",
			database: "postgres",
			sslmode: "disable",
		});
		expect(cfg.password).toBe("");
	});

	test("password is non-enumerable — JSON.stringify doesn't leak it", () => {
		const cfg = resolveConfig(undefined, undefined, {
			PGPASSWORD: "hunter2",
		});
		expect(cfg.password).toBe("hunter2"); // directly readable
		expect(JSON.stringify(cfg)).not.toContain("hunter2");
		expect(Object.keys(cfg)).not.toContain("password");
	});
});

describe("sslmode resolution", () => {
	test("options.tls true forces require", () => {
		const cfg = resolveConfig("postgres://a@h/d?sslmode=disable", {
			tls: true,
		});
		expect(cfg.sslmode).toBe("require");
	});

	test("options.tls false forces disable", () => {
		const cfg = resolveConfig("postgres://a@h/d?sslmode=require", {
			tls: false,
		});
		expect(cfg.sslmode).toBe("disable");
	});

	test("sslmode=require in URL implies require", () => {
		expect(resolveConfig("postgres://a@h/d?sslmode=require").sslmode).toBe(
			"require",
		);
	});

	test("sslmode=verify-full is preserved", () => {
		expect(resolveConfig("postgres://a@h/d?sslmode=verify-full").sslmode).toBe(
			"verify-full",
		);
	});

	test("sslmode=verify-ca is preserved", () => {
		expect(resolveConfig("postgres://a@h/d?sslmode=verify-ca").sslmode).toBe(
			"verify-ca",
		);
	});

	test("sslmode=prefer in URL is treated as require", () => {
		expect(resolveConfig("postgres://a@h/d?sslmode=prefer").sslmode).toBe(
			"require",
		);
	});

	test("unknown sslmode throws", () => {
		expect(() => resolveConfig("postgres://a@h/d?sslmode=shadow")).toThrow(
			/Unsupported sslmode/,
		);
	});

	test("TLS env var default is require", () => {
		const cfg = resolveConfig(undefined, undefined, {
			TLS_DATABASE_URL: "postgres://a@tls/d",
		});
		expect(cfg.sslmode).toBe("require");
	});
});

describe("URL parsing edge cases", () => {
	test("postgresql:// protocol accepted", () => {
		expect(resolveConfig("postgresql://a@h/d").host).toBe("h");
	});

	test("url-encoded password and user decoded", () => {
		const cfg = resolveConfig("postgres://u%40ser:p%40ss@h/d");
		expect(cfg.user).toBe("u@ser");
		expect(cfg.password).toBe("p@ss");
	});

	test("application_name from URL surfaces into config", () => {
		const cfg = resolveConfig("postgres://a@h/d?application_name=worker-1");
		expect(cfg.applicationName).toBe("worker-1");
	});

	test("options.applicationName wins over URL", () => {
		const cfg = resolveConfig("postgres://a@h/d?application_name=url", {
			applicationName: "opt",
		});
		expect(cfg.applicationName).toBe("opt");
	});

	test("rejects unsupported protocol", () => {
		expect(() => resolveConfig("mysql://a@h/d")).toThrow(
			/Unsupported connection URL protocol/,
		);
	});

	test("rejects malformed URL", () => {
		expect(() => resolveConfig("::::")).toThrow(/Invalid connection URL/);
	});

	test("rejects invalid port", () => {
		// WHATWG URL itself refuses ports > 65535, so it surfaces as an "Invalid URL" error.
		expect(() => resolveConfig("postgres://a@h:99999/d")).toThrow(/Invalid/);
	});

	test("malformed-URL error does NOT leak the password", () => {
		// Unterminated IPv6 bracket fails WHATWG URL parsing, but the raw
		// string still contains the password. The error lands in Sentry /
		// stdout — make sure we don't echo the credential there.
		try {
			resolveConfig("postgres://user:hunter2@[::1");
			throw new Error("expected to throw");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("Invalid connection URL");
			expect(msg).not.toContain("hunter2");
		}
	});
});

describe("redactUrl", () => {
	test("replaces the password with ***", () => {
		expect(redactUrl("postgres://user:hunter2@host/db")).toBe(
			"postgres://user:***@host/db",
		);
	});

	test("works with postgresql:// too", () => {
		expect(redactUrl("postgresql://u:p@h/d")).toBe("postgresql://u:***@h/d");
	});

	test("leaves URLs without a password untouched", () => {
		expect(redactUrl("postgres://user@host/db")).toBe(
			"postgres://user@host/db",
		);
	});

	test("leaves non-postgres URLs untouched", () => {
		expect(redactUrl("mysql://u:p@h/d")).toBe("mysql://u:p@h/d");
	});
});
