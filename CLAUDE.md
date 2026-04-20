Read this file completely before writing any code. These are hard rules, not suggestions.

# bun-pg-listen

A zero-dependency polyfill for Postgres `LISTEN`/`NOTIFY` on Bun's `Bun.sql` driver, which does not implement either command. This library is **intended to be temporary** — once Bun ships native support, consumers will rip it out. Design for that: keep the public surface small, avoid novel abstractions, and mirror the ergonomics of `Bun.sql` where you can. Every extra concept is one more thing someone has to delete later.

Default to Bun over Node.js. Use `bun <file>` instead of `node`, `bun install` instead of `npm install`, `bunx` instead of `npx`. Bun loads `.env` automatically — don't use dotenv.

## Commands

- `bun test` — unit tests (no Postgres required)
- `bun test:integration` — integration tests (needs a running Postgres; see below)
- `bun test:all` — both
- `bun run check` — biome + knip + tsc
- `bun run db:up` — start the Postgres 18 SCRAM container for integration tests
- `bun run db:down` — stop and wipe it

## Project Structure

```
src/
  index.ts              public entry — re-exports only
  config.ts             connection-string / env parsing, SSL mode resolution
  connection.ts         TCP socket + startup handshake + simple-query dispatch
  scram.ts              SCRAM-SHA-256 client (SASL) — inline during startup
  listener.ts           PgListener — public API, subscription + pendingOps queue
  reconnect.ts          exponential-backoff delay function
  write-buffer.ts       FIFO byte queue preserving write order across short writes
  errors.ts             typed errors (ConnectionClosed, PayloadTooLarge, ...)
  protocol/
    messages.ts         backend message decoders (tagged union)
    parser.ts           incremental framer — buffers partial reads
    reader.ts           big-endian primitive reader over Uint8Array
    writer.ts           big-endian primitive writer
    serializer.ts       frontend message encoders (Query, PasswordMessage, ...)
tests/
  unit/                 bun:test — pure logic, mirrors src/
    protocol/           parser / reader / writer / serializer / messages
  integration/          bun:test — real Postgres over docker-compose
  docker-compose.yml    Postgres 18 with scram-sha-256 forced on
```

## Key Conventions

- **Library, not app.** No runtime dependencies. Only `devDependencies` (biome, knip, tsc, husky). Don't add runtime deps without a very good reason — this code will be deleted, so every dep makes that harder.
- **Public surface lives in `src/index.ts`.** If it isn't re-exported there, it's internal. Keep it small.
- **Path alias**: `@src/*` → `./src/*`. Use it in **tests only** — relative imports (`./foo.ts`, `../bar.ts`) inside `src/` so the published package resolves without requiring consumers to replicate our tsconfig.
- **File naming**: Kabob-case by default. Should be named after the main purpose of the file.
- **Formatting**: tabs, double quotes (enforced by biome). Don't hand-format - use biome.
- **Function declarations over arrows** for named top-level functions, so top-down ordering works via hoisting. Arrows for inline callbacks only.
- **Early returns** on validation / null paths. No else-if chains when an early return reads cleaner.
- **Bun APIs first**: `Bun.file`, `Bun.env`, `Bun.$`, `Bun.TCPSocket`. Don't reach for `node:net`, `node:tls`, or `pg` — the whole point of this package is "no runtime deps, pure Bun". (`node:crypto` is fine: SCRAM needs sync `pbkdf2`/`hmac` primitives that Bun doesn't expose natively, and Bun's `node:crypto` is Zig-backed anyway.)
- **Top-down file ordering**: exports and entry points go first, followed by their direct dependencies, followed by their dependencies, and so on. A reader should encounter the "what" before the "how" — like a newspaper. Use `function` declarations (hoisted) over `const` arrow functions for internal helpers so this ordering works at runtime
- **Feature structure**: Features start as a single file at `src/<feature>.ts`. When a feature grows past ~500 LoC or accumulates helpers, promote it to a sibling `src/<feature>/` folder with an `index.ts` that re-exports the public surface — same pattern as `protocol/`. Subfeatures nest the same way.

## Architecture

Four layers, bottom up:

1. **`protocol/`** — pure binary codecs. `Parser` buffers partial TCP reads and emits complete backend messages as a tagged union; `serializer.ts` writes frontend messages. No I/O, no state beyond the read buffer.
2. **`Connection`** — owns the `Bun.TCPSocket`, runs the startup handshake (including SCRAM via `scram.ts`), and dispatches decoded messages to handler callbacks (`onNotification`, `onReadyForQuery`, `onNotice`, `onProtocolError`, `onClose`). Does not know about channels or reconnection.
3. **`PgListener`** — public API. Holds the `listeners` map (channel → Set of callbacks) and a FIFO `pendingOps` queue that correlates `CommandComplete` / `ErrorResponse` / `ReadyForQuery` back to in-flight `LISTEN` / `NOTIFY` / `UNLISTEN` promises. Wraps `Connection` with exponential-backoff reconnect and re-sends `LISTEN` for every active channel on reconnect.
4. **`config.ts`** — resolves a `PgConfig` from a connection string, discrete fields, or env vars. SSL mode resolution happens here.

## Testing

```bash
bun test                  # unit only (default)
bun test:integration      # integration only (needs Postgres)
bun test:all              # both
bun run check             # biome + knip + tsc
```

- **Unit tests in `tests/unit/`** mirror `src/`. They're pure — no network, no Postgres. Protocol parser tests drive bytes through `Parser` directly; SCRAM tests use the RFC 5802 test vectors.
- **Integration tests in `tests/integration/`** require a real Postgres with SCRAM auth. Spin it up with `bun run db:up` (docker-compose — Postgres 18, `scram-sha-256` forced for both host and local auth). They read `TEST_DATABASE_URL`; CI sets it to the service container, local dev inherits from `.env` or the compose defaults.
- **Every new feature or bug fix ships with a test.** Prefer unit tests when the logic can be isolated (most protocol and state-machine bugs can). Reach for integration only when the behavior actually depends on round-tripping with Postgres — reconnect, auth, real NOTIFY delivery.
- **Run `bun run check` before finishing.** Knip will catch unused exports; since the public surface is `src/index.ts`, it's easy to leave an internal export behind after a refactor.

## Gotchas

These are the subtle invariants. Read before modifying the relevant file.

- **`Parser` message-data is a live view, not a copy** ([src/protocol/messages.ts:82](src/protocol/messages.ts#L82)). For unknown message types, the `data: Uint8Array` field is a `subarray` over the parser's internal buffer and will be corrupted by the next `push()`. Unknown types are defensively copied; if you add a new typed message, don't retain sub-slices past the current dispatch.
- **LISTEN callbacks must be registered before awaiting the command** ([src/listener.ts:97](src/listener.ts#L97)). Postgres pipelines `CommandComplete` / `ReadyForQuery` / `NotificationResponse` into one TCP read. Microtasks run FIFO, so a notification delivered in the same batch as the LISTEN ack will dispatch to an empty callback set if you register after the `await`. If you refactor `listen()`, preserve this ordering.
- **`pendingOps` errors peek, they don't shift** ([src/listener.ts:290](src/listener.ts#L290)). On `ErrorResponse` we mark the head op as errored but leave it in the queue; the following `ReadyForQuery` (guaranteed by the simple-query protocol) shifts and rejects it. Shifting early misaligns errors with pipelined queries.
- **Reconnect re-LISTENs before firing `onReconnect`** ([src/listener.ts:212](src/listener.ts#L212)). Caller's replay logic can assume server-side subscriptions are restored. If the connection dies mid-replay, the code detects it and bails to let the next `onConnectionClosed` drive the state machine — don't try to recover inline.
- **NOTIFY payload limit is 7999 bytes, not 8000** ([src/listener.ts:150](src/listener.ts#L150)). Postgres's 8000-byte slot includes a trailing NUL. `PayloadTooLargeError.LIMIT` is 8000 and the check is `>=`, which is correct — don't "fix" it to `>`.
- **Channel identifiers are byte-length checked, not character-length** ([src/listener.ts:365](src/listener.ts#L365)). A 16-emoji channel name (64 bytes) is rejected. Postgres would silently truncate to 63 bytes, which causes cross-wiring between channels that differ only in their tail — we reject upfront.
- **Payload literals use `E'...'` with both `\` and `'` doubled** ([src/listener.ts:385](src/listener.ts#L385)). Parses identically under `standard_conforming_strings=on` or `off`. If you change escape logic, run the integration tests against both settings.
- **SCRAM server nonce must extend the client nonce as a prefix** ([src/scram.ts:62](src/scram.ts#L62)). The RFC requires it; we enforce it. A server that returns a fresh nonce is either broken or an attacker.
- **`Connection.send()` preserves write order across short writes via `WriteBuffer`; it is NOT backpressure** ([src/connection.ts:131](src/connection.ts#L131)). Flow-control against a slow peer comes from the `pendingOps` chain (each LISTEN / NOTIFY / UNLISTEN awaits `ReadyForQuery` before the next is issued). `WriteBuffer` only ensures bytes leave the socket in the same order they were pushed when a single write returns short. It has a `maxBytes` guard (default 1 MiB) that throws `WriteBufferOverflowError` rather than growing unbounded — that's a runaway-caller safety net, not flow control. The writer callback returns `-1` when the socket is closed; `push` translates that into a thrown `ConnectionClosedError` instead of silently queuing onto a dead socket. `send()` also checks `socket.readyState === 1` synchronously so a peer FIN racing ahead of Bun's close callback doesn't slip through. Post-ready writes must go through `send()`; startup-phase writes (`sslRequest`, `startup`, `saslInitial`, `saslResponse`, `terminate`) bypass it because the state machine can't tolerate queuing there and those messages are small enough the kernel send buffer always accepts them whole. Queue logic is covered by [tests/unit/write-buffer.test.ts](tests/unit/write-buffer.test.ts) with a fake writer (real short writes are hard to force in integration).
- **Bun's `upgradeTLS` has two quirks we work around in `tlsHandler` / `plaintextHandler`** ([src/connection.ts:164](src/connection.ts#L164)). (1) After upgrade, the **original plaintext handler keeps receiving raw encrypted TLS records** alongside the new TLS handler receiving decrypted bytes — feeding those raw bytes into `Parser` corrupts it, so the plaintext `data` callback returns early whenever `sslmode !== "disable"`. (2) `upgradeTLS` **completes the handshake regardless of cert trust** ([oven-sh/bun#9365](https://github.com/oven-sh/bun/issues/9365), [#22870](https://github.com/oven-sh/bun/issues/22870)); `rejectUnauthorized: true` is not honored at handshake time. Verification failures surface via the `handshake(socket, success, authError)` callback's `authorizationError` parameter, which we inspect in `tlsHandler` to enforce `verify-ca` / `verify-full`. Startup is also deferred to `handshake` because writes in the TLS `open` callback can be lost (same issue). If Bun fixes either behavior upstream, simplify accordingly.

## CI

GitHub Actions runs on push to `main` and on pull requests ([.github/workflows/ci.yml](.github/workflows/ci.yml)). Three jobs:

- **check** — `bun run check` (biome + knip + tsc).
- **unit-tests** — `bun test tests/unit`, no services.
- **integration-tests** — `bun test tests/integration` against a Postgres 18 service container with `scram-sha-256` forced for both host and local auth, exposed on port 54329. `TEST_DATABASE_URL` is set in the job env.
