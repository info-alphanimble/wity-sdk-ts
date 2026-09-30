// The public surface of the SDK. Anything not exported here is private and can change freely.

export { DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, WityClient, type WityClientOptions } from "./client";
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InsufficientBalanceError,
  InternalServerError,
  RateLimitError,
  WityError,
} from "./errors";
export { LOG_LEVELS, type LogLevel, type Logger } from "./logging";
export { choice, noul, score } from "./questions";
export type * from "./types";
