// What one API call looks like, shared by the client and the skills and sessions resources.

import { WityError } from "./errors";
import type { RequestOptions } from "./types";

/** Extra time on top of `max_latency_ms` for the network and Wity's own work. */
const LATENCY_MARGIN_MS = 10_000;

/** What `debug` logs about a request. Never the key, never `state` or `text`. */
export type Summary = Record<string, unknown>;

/**
 * Which failures a call may retry.
 * `"always"`: calls that change nothing, or change the same thing again (read, decide, update, delete).
 * `"busy"`: calls that add something (a skill, examples, a session, events). Only 429 and 503 are retried,
 * because then Wity did no work. After any other failure the call may have gone through, so a retry
 * could add it twice.
 */
export type Retry = "always" | "busy";

/** One API call. */
export interface Call {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path with placeholders, like `/v1/skills/{skill}`. Used in logs, never filled in with ids. */
  route: string;
  /** The real path, ids filled in and encoded. */
  path: string;
  body?: object;
  query?: Record<string, string | number | undefined>;
  summary?: Summary;
  retry: Retry;
  minTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs a `Call` and returns the parsed JSON object. */
export type Requester = (call: Call) => Promise<unknown>;

/** The `limit` and `after` options of every list call. */
export interface ListOptions extends RequestOptions {
  /** 1 to 100. */
  limit?: number;
  /** The last id of the page before. */
  after?: string;
}

/** The query string of a list call. */
export const listQuery = ({ limit, after }: ListOptions) => ({ limit, after });

/**
 * An id or name, ready to go in a path.
 * `.` and `..` are refused: in a URL they would point at a different address.
 */
export const pathPart = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new WityError(`${what} must be a non-empty string.`);
  if (value === "." || value === "..") {
    throw new WityError(`${what} can't be "${value}" in a URL. Use the id instead.`);
  }
  return encodeURIComponent(value);
};

/** Plain JavaScript can pass anything. Fail with a WityError before reading fields off it. */
export const checkRequest = (request: unknown, example = "{ state, questions }"): void => {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new WityError(`The request must be an object, for example ${example}.`);
  }
};

/** Give Wity the full time `max_latency_ms` allows, plus room for the network. */
export const latencyTimeoutMs = (latency: number | undefined): number =>
  Number.isFinite(latency) ? (latency as number) + LATENCY_MARGIN_MS : 0;
