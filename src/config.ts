/**
 * Resolve connection parameters from (in priority order):
 *   1. an explicit URL passed to PgListener
 *   2. options object overrides (applicationName, tls)
 *   3. env vars in the same order Bun.sql uses
 *      (POSTGRES_URL → DATABASE_URL → PGURL → PG_URL →
 *       TLS_POSTGRES_DATABASE_URL → TLS_DATABASE_URL)
 *   4. individual PG* env vars with libpq-style fallbacks
 */

export type SslMode = "disable" | "require" | "verify-ca" | "verify-full";

export type PgConfig = {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	applicationName?: string;
	sslmode: SslMode;
};

/**
 * Inline connection options that win over URL and env vars.
 * Mirrors the shape `Bun.sql` accepts (minus pool/query-specific fields we don't need).
 */
export type ResolveOptions = {
	host?: string;
	hostname?: string;
	port?: number;
	user?: string;
	username?: string;
	password?: string;
	database?: string;
	applicationName?: string;
	/**
	 * `true` → sslmode=require. `false` → sslmode=disable.
	 * Omitted → derive from URL / env (TLS_* vars imply require).
	 */
	tls?: boolean;
};

type Env = Record<string, string | undefined>;

const URL_ENV_VARS = [
	"POSTGRES_URL",
	"DATABASE_URL",
	"PGURL",
	"PG_URL",
] as const;

const TLS_URL_ENV_VARS = [
	"TLS_POSTGRES_DATABASE_URL",
	"TLS_DATABASE_URL",
] as const;

const ACCEPTED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export function resolveConfig(
	url?: string,
	options?: ResolveOptions,
	env: Env = process.env,
): PgConfig {
	const plainEnvUrl = pick(env, URL_ENV_VARS);
	const tlsEnvUrl = pick(env, TLS_URL_ENV_VARS);
	const resolvedUrl = url ?? plainEnvUrl ?? tlsEnvUrl;
	const fromTlsEnv = !url && !plainEnvUrl && tlsEnvUrl !== undefined;

	const parsed = resolvedUrl ? parseUrl(resolvedUrl) : {};

	const optHost = options?.host ?? options?.hostname;
	const optUser = options?.user ?? options?.username;

	const user =
		optUser ??
		parsed.user ??
		nonEmpty(env.PGUSERNAME) ??
		nonEmpty(env.PGUSER) ??
		nonEmpty(env.USER) ??
		nonEmpty(env.USERNAME) ??
		"postgres";

	const password = options?.password ?? parsed.password ?? env.PGPASSWORD ?? "";
	const config = {
		host: optHost ?? parsed.host ?? nonEmpty(env.PGHOST) ?? "localhost",
		port: options?.port ?? parsed.port ?? parsePort(env.PGPORT) ?? 5432,
		user,
		password: "",
		database:
			options?.database ?? parsed.database ?? nonEmpty(env.PGDATABASE) ?? user,
		applicationName: options?.applicationName ?? parsed.applicationName,
		sslmode: resolveSslmode(options?.tls, parsed.sslmode, fromTlsEnv),
	} satisfies PgConfig;

	// Store password non-enumerably: `JSON.stringify(config)` and
	// `util.inspect(config)` won't leak it, and a consumer serializing
	// config into logs gets the rest of the struct without the credential.
	// Library code reads `config.password` directly which still works —
	// the value is accessible, just not enumerable.
	Object.defineProperty(config, "password", {
		value: password,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return config;
}

function nonEmpty(v: string | undefined): string | undefined {
	return v === undefined || v === "" ? undefined : v;
}

type ParsedUrl = {
	host?: string;
	port?: number;
	user?: string;
	password?: string;
	database?: string;
	applicationName?: string;
	sslmode?: string;
};

function parseUrl(urlString: string): ParsedUrl {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		// Do NOT echo `urlString` — a malformed URL may still contain the
		// password (e.g. an unencoded `@` upstream of the real host) and
		// construction-time errors are routinely forwarded to Sentry / stdout.
		throw new Error(`Invalid connection URL: ${redactUrl(urlString)}`);
	}
	if (!ACCEPTED_PROTOCOLS.has(url.protocol)) {
		throw new Error(
			`Unsupported connection URL protocol '${url.protocol}'. Expected postgres:// or postgresql://`,
		);
	}

	const out: ParsedUrl = {};
	if (url.hostname) out.host = decodeURIComponent(url.hostname);
	if (url.port) {
		const port = Number.parseInt(url.port, 10);
		if (!Number.isFinite(port) || port < 1 || port > 65535) {
			throw new Error(`Invalid port in connection URL: ${url.port}`);
		}
		out.port = port;
	}
	if (url.username) out.user = decodeURIComponent(url.username);
	if (url.password) out.password = decodeURIComponent(url.password);
	const pathDb = url.pathname.replace(/^\//, "");
	if (pathDb) out.database = decodeURIComponent(pathDb);

	const sslmode = url.searchParams.get("sslmode");
	if (sslmode) out.sslmode = sslmode;
	const appName = url.searchParams.get("application_name");
	if (appName) out.applicationName = appName;
	return out;
}

function resolveSslmode(
	tlsOption: boolean | undefined,
	urlSslmode: string | undefined,
	fromTlsEnv: boolean,
): SslMode {
	if (tlsOption === true) return "require";
	if (tlsOption === false) return "disable";
	if (urlSslmode) {
		if (urlSslmode === "disable" || urlSslmode === "allow") return "disable";
		if (urlSslmode === "require" || urlSslmode === "prefer") return "require";
		if (urlSslmode === "verify-ca" || urlSslmode === "verify-full") {
			return urlSslmode;
		}
		throw new Error(`Unsupported sslmode '${urlSslmode}'`);
	}
	if (fromTlsEnv) return "require";
	return "disable";
}

function pick(env: Env, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const v = env[key];
		if (v !== undefined && v !== "") return v;
	}
	return undefined;
}

function parsePort(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const port = Number.parseInt(raw, 10);
	if (!Number.isFinite(port)) return undefined;
	return port;
}

/**
 * Strip the password from a connection URL for inclusion in error messages.
 * Best-effort — when the URL is unparseable the regex still catches the
 * standard `scheme://user:password@host` shape.
 */
export function redactUrl(urlString: string): string {
	return urlString.replace(
		/(postgres(?:ql)?:\/\/[^:@\s/]*:)[^@\s]*(@)/i,
		"$1***$2",
	);
}
