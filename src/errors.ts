// Every error the SDK throws extends WityError, so one `catch` can handle them all.
// None of them ever contain the API key.
//
// Each class sets `name` as a plain string, not from the class name,
// so it stays readable after a bundler shortens class names.

/** Base class for all SDK errors. Also thrown for setup problems, like a missing key. */
export class WityError extends Error {
  override name = "WityError";
}

const MOVED_HINT = "The API address may have changed. Set WITY_BASE_URL to the new address, or update the wity package.";

/** Wity's own "no such skill, session or example" answer, as opposed to an address that doesn't exist. */
const isMissingThing = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as Record<string, unknown>).code === "not_found";

/** Extra advice added to the message for some statuses. */
const hintFor = (status: number, body: unknown): string | undefined => {
  if (status >= 300 && status < 400) return `The API answered with a redirect, which this SDK never follows. ${MOVED_HINT}`;
  if (status === 401) return "Check WITY_API_KEY.";
  if (status === 402) return "The account has no balance left.";
  if (status === 404 && !isMissingThing(body)) return MOVED_HINT;
  return undefined;
};

const MAX_TEXT_IN_MESSAGE = 200;

/** Turn a list of validation errors (`[{loc, msg}, ...]`) into "field: problem; field: problem". */
const describeList = (items: unknown[]): string | undefined => {
  const parts = items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { loc, msg } = item as Record<string, unknown>;
    if (typeof msg !== "string") return [];
    const where = Array.isArray(loc) ? loc.filter((part) => part !== "body").join(".") : "";
    return [where ? `${where}: ${msg}` : msg];
  });
  return parts.length > 0 ? parts.join("; ") : undefined;
};

/**
 * Read the message out of an error body.
 * Wity uses `{"error": "..."}` on some routes and `{"detail": "..."}` on others.
 */
const messageFrom = (body: unknown): string | undefined => {
  if (typeof body === "string") {
    const text = body.trim();
    if (text.startsWith("<")) return "the server sent an HTML error page";
    return text.length > MAX_TEXT_IN_MESSAGE ? `${text.slice(0, MAX_TEXT_IN_MESSAGE)}…` : text || undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const { error, detail, message } = body as Record<string, unknown>;
  for (const value of [error, detail, message]) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return describeList(value);
    if (typeof value === "object" && value !== null) {
      const inner = (value as Record<string, unknown>).message;
      if (typeof inner === "string") return inner;
    }
  }
  return undefined;
};

/** The id the server gave this request. Quote it when reporting a problem. */
export const requestIdFrom = (headers: Headers): string | undefined =>
  headers.get("x-request-id") ?? headers.get("x-railway-request-id") ?? undefined;

/** The API answered with an error status. */
export class APIError extends WityError {
  override name = "APIError";
  /** HTTP status code, for example 400. */
  readonly status: number;
  /** The response body: parsed JSON, text, or `undefined` if empty. */
  readonly body: unknown;
  /** The response headers, for example `Retry-After`. */
  readonly headers: Headers;
  /** The server's id for this request, if it sent one. */
  readonly requestId: string | undefined;

  /** `note` is extra context from the SDK, added to the end of the message. */
  constructor(status: number, body: unknown, headers: Headers, note?: string) {
    // For example: "401 invalid API key. Check WITY_API_KEY."
    const detail = messageFrom(body)?.replace(/\.+$/, "");
    const head = detail ? `${status} ${detail}` : String(status);
    const extra = [hintFor(status, body), note].filter(Boolean).join(" ");
    super(extra ? `${head}. ${extra}` : head);
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.requestId = requestIdFrom(headers);
  }

  /** Pick the error class that matches the status. */
  static fromResponse(status: number, body: unknown, headers: Headers, note?: string): APIError {
    if (status === 400) return new BadRequestError(status, body, headers, note);
    if (status === 401) return new AuthenticationError(status, body, headers, note);
    if (status === 402) return new InsufficientBalanceError(status, body, headers, note);
    if (status === 404) return new NotFoundError(status, body, headers, note);
    if (status === 409) return new ConflictError(status, body, headers, note);
    if (status === 429) return new RateLimitError(status, body, headers, note);
    if (status >= 500) return new InternalServerError(status, body, headers, note);
    return new APIError(status, body, headers, note);
  }
}

/** 400: the request is wrong. The message says which part. */
export class BadRequestError extends APIError {
  override name = "BadRequestError";
}
/** 401: the API key is missing or wrong. */
export class AuthenticationError extends APIError {
  override name = "AuthenticationError";
}
/** 402: the account has no balance left. */
export class InsufficientBalanceError extends APIError {
  override name = "InsufficientBalanceError";
}
/** 404: no skill, session or example by that id or name. Or the API address is wrong: the message says which. */
export class NotFoundError extends APIError {
  override name = "NotFoundError";
}
/** 409: a skill with that name already exists. */
export class ConflictError extends APIError {
  override name = "ConflictError";
}
/** 429: too many requests. Thrown after the SDK's retries run out. */
export class RateLimitError extends APIError {
  override name = "RateLimitError";
}
/** 5xx: a problem on Wity's side. Thrown after the SDK's retries run out. */
export class InternalServerError extends APIError {
  override name = "InternalServerError";
}

/** The API couldn't be reached, or the connection broke while reading the answer. */
export class APIConnectionError extends WityError {
  override name = "APIConnectionError";
}
/** The API didn't answer within the timeout. */
export class APITimeoutError extends WityError {
  override name = "APITimeoutError";
}
/** You cancelled the request with its `signal`. */
export class APIUserAbortError extends WityError {
  override name = "APIUserAbortError";
}
