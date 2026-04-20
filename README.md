# bun-pg-listen

A zero-dependency polyfill for Postgres `LISTEN` / `NOTIFY` on Bun's `Bun.sql` driver — which [doesn't implement either command yet](https://github.com/oven-sh/bun/issues/18214). This library is **intended to be temporary**: once Bun ships native support, rip it out. Design goals: keep the public surface small, match `Bun.sql`'s ergonomics, and make the eventual removal trivial.

- Zero runtime dependencies — pure Bun + `node:crypto`.
- SCRAM-SHA-256 authentication (RFC 7677). MD5 is intentionally not supported — Postgres 14+ defaults to SCRAM.
- Exponential-backoff reconnect with automatic re-`LISTEN` of every active channel before `onReconnect` fires.
- TLS via `Bun.TCPSocket.upgradeTLS()` — `sslmode=require`, `verify-ca`, and `verify-full` all supported.
- Byte-exact parity with the RFC 7677 SCRAM test vector.

## Install

```bash
bun add bun-pg-listen
```

Requires Bun ≥ 1.2 and Postgres ≥ 13 (SCRAM-SHA-256).

## Usage

```ts
import { PgListener } from "bun-pg-listen";

const listener = new PgListener();
await listener.connect();

const unlisten = await listener.listen("page_updates", (payload) => {
  console.log(payload);
});

await listener.notify(
  "page_updates",
  JSON.stringify({ pageId: "abc", op: "save" }),
);

await unlisten();
await listener.close();
```

Connection config is resolved from env in the same order `Bun.sql` uses — `POSTGRES_URL`, `DATABASE_URL`, `PGURL`, `PG_URL`, `TLS_POSTGRES_DATABASE_URL`, `TLS_DATABASE_URL`, then individual `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`. So the snippet above works unchanged on any machine that can already run `Bun.sql`.

### Custom connection string

```ts
const listener = new PgListener(
  "postgres://user:pass@host:5432/db?sslmode=require",
);
```

### Inline options

Mirrors `Bun.sql`'s shape — pass fields directly or combine with a URL:

```ts
const listener = new PgListener({
  hostname: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "app",
  applicationName: "my-worker", // shows up in pg_stat_activity
  tls: true,
});
```

### Verified TLS (`verify-full` / `verify-ca`)

`sslmode=verify-full` validates the certificate chain and hostname against Bun's bundled CA store — this is the right setting for most managed providers (Neon, Supabase, Railway, Fly, Crunchy Bridge all use public CAs):

```ts
const listener = new PgListener(
  "postgres://user:pass@db.example.com/app?sslmode=verify-full",
);
```

For providers that ship a private CA (AWS RDS, GCP Cloud SQL, on-prem), pass it through `tls`:

```ts
const listener = new PgListener(
  "postgres://user:pass@mydb.rds.amazonaws.com/app?sslmode=verify-full",
  {
    tls: { ca: await Bun.file("./rds-ca.pem").text() },
  },
);
```

`verify-ca` skips the hostname check (useful when connecting through an internal load balancer whose cert SAN doesn't match). Explicit `tls` fields override the `sslmode`-derived defaults.

### Callbacks

```ts
const listener = new PgListener({
  onConnect: () => console.log("connected"),
  onReconnect: () => replayMissedUpdates(), // fired after all channels are re-LISTENed
  onError: (err) => log.warn(err),
  onNotice: (fields) => log.info(fields.M),
});
```

## When Bun ships native `sql.listen`, delete this package

This library is a polyfill. Track [oven-sh/bun#18214](https://github.com/oven-sh/bun/issues/18214) — when it lands, migration is a small codemod. Mapping against [PR #25511](https://github.com/oven-sh/bun/pull/25511) as currently drafted:

```diff
- import { PgListener } from "bun-pg-listen";
- const listener = new PgListener({ onReconnect: replay });
- await listener.connect();
- const unlisten = await listener.listen(channel, cb);
- await listener.notify(channel, payload);
- await listener.close();
+ import { sql } from "bun";
+ const unlisten = await sql.listen(channel, cb);
+ await sql.unsafe(`NOTIFY ${channel}, ${sql.quote(payload)}`);
+ await sql.close();
```

A few features aren't in Bun's proposal yet: `onReconnect` hook, `onError` / `onNotice` callbacks, explicit `connect()`, configurable backoff. If you depend on them, weigh carefully before migrating — or file them upstream.

## Guarantees

- `listen(channel, cb)` resolves only after Postgres acknowledges `LISTEN`. Callbacks registered before the `await` resume — a notification pipelined in the same TCP read as the ack is delivered, not dropped.
- `notify(channel, payload)` resolves only after the server acks `NOTIFY`.
- Payloads over 7999 bytes throw `PayloadTooLargeError` client-side — nothing is sent.
- On reconnect, every active channel is re-`LISTEN`ed before `onReconnect` fires. Your replay logic can assume subscriptions are restored.
- Pending `listen()` / `notify()` / `unlisten()` promises reject with `ConnectionClosedError` when the connection drops.
- Identifiers are rejected if they exceed 63 bytes (Postgres's `NAMEDATALEN - 1`) — silent truncation would cross-wire channels.

## Non-guarantees

- **At-most-once delivery.** Postgres `LISTEN` / `NOTIFY` loses notifications on connection drops. Use a durable side-table with monotonic IDs and reconcile in `onReconnect` if you need reliability.
- **No channel binding** (`SCRAM-SHA-256-PLUS`). V1 supports plain `SCRAM-SHA-256` over TLS. None of the major managed providers (RDS, Cloud SQL, Azure, Neon, Supabase) require it.
- **Separate connection.** `PgListener` opens its own socket — it doesn't share `Bun.sql`'s pool. Budget +1 connection per listener against your server's `max_connections`.

## Commands

| Command                | What it does                                    |
| ---------------------- | ----------------------------------------------- |
| `bun test`             | Unit tests (no Postgres required)               |
| `bun test:integration` | Integration tests (needs Postgres — see below)  |
| `bun test:all`         | Both                                            |
| `bun run check`        | Biome + knip + tsc                              |
| `bun run db:up`        | Start a Postgres 18 container with SCRAM forced |
| `bun run db:down`      | Stop and wipe it                                |

## Architecture

Four layers, bottom up:

1. **`src/protocol/`** — pure binary codecs. `Parser` buffers partial TCP reads and emits tagged-union backend messages; `serializer.ts` writes frontend messages. No I/O, no state beyond the read buffer.
2. **`src/connection.ts`** — owns the `Bun.TCPSocket`, runs the startup handshake (including SCRAM from `src/scram.ts`), and dispatches decoded messages to handler callbacks.
3. **`src/listener.ts`** — public `PgListener` API. Channel → callbacks map, a FIFO `pendingOps` queue correlating `CommandComplete` / `ErrorResponse` / `ReadyForQuery` to in-flight promises, exponential-backoff reconnect, re-`LISTEN` on reconnect.
4. **`src/config.ts`** — resolves a `PgConfig` from a connection string, inline options, and env vars. SSL-mode resolution lives here.

## License

MIT — see [LICENSE](./LICENSE).
