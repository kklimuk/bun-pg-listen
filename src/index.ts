// Public entry for bun-pg-listen.

export type { PgConfig, ResolveOptions, SslMode } from "./config.ts";
export { resolveConfig } from "./config.ts";

export type {
	BackendKeyData,
	ConnectionHandlers,
	ConnectionOptions,
} from "./connection.ts";
export { Connection } from "./connection.ts";

export {
	ConnectionClosedError,
	ConnectionNotReadyError,
	PayloadTooLargeError,
	PgProtocolError,
} from "./errors.ts";

export type { NotifyCallback, PgListenerOptions } from "./listener.ts";
export { escapeIdentifier, escapeLiteral, PgListener } from "./listener.ts";

export type { ReconnectDelayFn } from "./reconnect.ts";
export { defaultReconnectDelay } from "./reconnect.ts";

export {
	WriteBufferClosedError,
	WriteBufferOverflowError,
} from "./write-buffer.ts";
