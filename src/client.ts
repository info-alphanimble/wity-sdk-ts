import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  WityError,
  requestIdFrom,
} from "./errors";
import { DEFAULT_LOG_LEVEL, type LogLevel, type Logger, consoleLogger, parseLogLevel, withLevel } from "./logging";
import { backoffMs, delayBeforeRetry, shouldRetryStatus, sleep } from "./retry";
import { type Call, checkRequest, latencyTimeoutMs, type Requester } from "./request";
import { Sessions } from "./sessions";
import { Skills } from "./skills";
import { showUpdateNoticeOnce } from "./update-notice";
import { VERSION } from "./version";
import type {
  ExtractRequest,
  ExtractResponse,
  GenerateRequest,
  GenerateResponse,
  Questions,
  RequestOptions,
  SplitRequest,
  SplitResponse,
  SystemOneRequest,
  SystemOneResponse,
} from "./types";

/**
 * The production API address.
 * If it ever moves: change this line, bump the version and publish.
 * Until users update, they can set WITY_BASE_URL or the `baseURL` option.
 */
export const DEFAULT_BASE_URL = "https://api.wity.alphanimble.com";

/** Thinking can take a few seconds. Longer `max_latency_ms` values raise the timeout automatically. */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

/** The longest delay `setTimeout` accepts. A longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Split and extract read long documents. The API docs ask for at least two minutes. */
const LONG_READ_TIMEOUT_MS = 120_000;

/** Wity's answers are a few kB. A body far bigger than that isn't a Wity answer, so the SDK stops reading. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Top-level fields each route accepts, from the API. `model` is accepted and ignored by Wity.
 * Other fields are still sent, so new API fields work without an SDK update, but the SDK logs a warning.
 * Routes are named as in the logs: the path alone for POST, the method and path for the others.
 */
const KNOWN_FIELDS: Record<string, Set<string>> = {
  "/v1/systemone": new Set(["state", "questions", "reasoning", "max_latency_ms", "image", "model"]),
  "/v1/generate": new Set(["state", "instructions", "shape", "max_tokens", "image", "model"]),
  "/v1/split": new Set(["text", "split", "skill"]),
  "/v1/extract": new Set(["text", "fields", "types", "model"]),
  "/v1/skills": new Set(["name", "description", "question", "parts", "combine", "examples", "metadata", "split"]),
  "PATCH /v1/skills/{skill}": new Set(["name", "description", "question", "parts", "combine", "metadata", "split"]),
  "/v1/skills/{skill}/examples": new Set(["examples"]),
  "/v1/sessions": new Set(["state", "skills", "metadata", "expires_in"]),
  "PATCH /v1/sessions/{id}": new Set(["skills", "metadata", "expires_in"]),
  "/v1/sessions/{id}/events": new Set(["events"]),
  "/v1/sessions/{id}/decide": new Set(["questions", "reasoning", "max_latency_ms", "remember"]),
};

/** The log name of a route: the path alone for POST, the method and path for the others. */
const routeName = (method: Call["method"], route: string): string => (method === "POST" ? route : `${method} ${route}`);

export interface WityClientOptions {
  /** Defaults to the WITY_API_KEY environment variable. */
  apiKey?: string;
  /**
   * Defaults to the WITY_BASE_URL environment variable, then `DEFAULT_BASE_URL`.
   * Must be https. Plain http is allowed only for localhost.
   */
  baseURL?: string;
  /** Time limit per attempt, in ms. Default 60000. */
  timeoutMs?: number;
  /** How many times to retry 408, 429, 5xx and network failures. Default 2. */
  maxRetries?: number;
  /** `"debug"`, `"info"`, `"warn"`, `"error"` or `"off"`. Defaults to WITY_LOG_LEVEL, then `"warn"`. */
  logLevel?: LogLevel;
  /** Where log messages go. Defaults to the console. Works with pino, winston and similar. */
  logger?: Logger;
  /** A replacement for the global `fetch`. Useful in tests. */
  fetch?: typeof fetch;
}

const readEnv = (name: string): string | undefined => {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name]?.trim() || undefined;
};

/** A browser page, or a browser worker. Server runtimes have neither. */
const inBrowser = (): boolean => {
  const g = globalThis as { window?: unknown; document?: unknown; WorkerGlobalScope?: unknown; importScripts?: unknown };
  const page = typeof g.window !== "undefined" && typeof g.document !== "undefined";
  const worker = typeof g.WorkerGlobalScope !== "undefined" && typeof g.importScripts === "function";
  return page || worker;
};

/** Printable characters only, no spaces. */
const KEY_PATTERN = /^[\x21-\x7E]+$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Check the base URL and return it without a trailing slash.
 * Error messages never repeat the URL, in case a key was pasted into it by mistake.
 */
const checkBaseURL = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WityError("The Wity base URL is not a valid URL. Check WITY_BASE_URL or the baseURL option.");
  }
  const isLocalHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new WityError(
      "The Wity base URL must start with https:// so the API key is encrypted on the way. Plain http:// is only allowed for localhost.",
    );
  }
  if (url.username || url.password) {
    throw new WityError("The Wity base URL must not contain a username or password.");
  }
  if (url.search || url.hash) {
    throw new WityError("The Wity base URL must not contain ? or #.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

/** Parse a body as JSON, or keep it as text. `undefined` when empty. */
const readBody = async (response: Response): Promise<unknown> => {
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new WityError(
          `The answer is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB, so it can't be from Wity. Check WITY_BASE_URL or the baseURL option.`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Client for the Wity API. Use it on a server only: it holds your API key. */
export class WityClient {
  /** The address requests go to. Useful to check which API you're calling. */
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logLevel: LogLevel;
  /** Create, teach and manage skills. */
  readonly skills: Skills;
  /** Keep a state on Wity's side, add to it with events, and decide on it. */
  readonly sessions: Sessions;
  // `#` fields are truly private. They never show up in console.log,
  // JSON.stringify or Object.keys, so the key can't leak through them.
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #log: Logger;

  constructor(options: WityClientOptions = {}) {
    if (inBrowser()) {
      throw new WityError(
        "WityClient can't run in a browser. Your API key would be visible to anyone using the page. Call Wity from your server instead.",
      );
    }

    // An apiKey passed in code always wins, even an empty one. Quietly falling back
    // to WITY_API_KEY could bill a different account.
    const apiKey = options.apiKey !== undefined ? options.apiKey.trim() : readEnv("WITY_API_KEY");
    if (options.apiKey !== undefined && !apiKey) {
      throw new WityError("The apiKey option is empty. Pass a real key, or leave apiKey out to use WITY_API_KEY.");
    }
    if (!apiKey) {
      throw new WityError("No API key found. Set the WITY_API_KEY environment variable, or pass apiKey to WityClient.");
    }
    // A bad character would make fetch throw an error that quotes the whole header, key included.
    if (!KEY_PATTERN.test(apiKey)) {
      throw new WityError("The API key contains spaces or unusual characters. Check WITY_API_KEY.");
    }
    this.#apiKey = apiKey;
    showUpdateNoticeOnce("wity-sdk", VERSION, "npm install wity-sdk@latest");

    this.baseURL = checkBaseURL(options.baseURL ?? readEnv("WITY_BASE_URL") ?? DEFAULT_BASE_URL);

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMER_MS) {
      throw new WityError(`timeoutMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}.`);
    }
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new WityError("maxRetries must be a whole number, 0 or more.");
    }

    const levelFromEnv = readEnv("WITY_LOG_LEVEL");
    this.logLevel =
      options.logLevel !== undefined
        ? parseLogLevel(options.logLevel, "The logLevel option")
        : levelFromEnv !== undefined
          ? parseLogLevel(levelFromEnv, "WITY_LOG_LEVEL")
          : DEFAULT_LOG_LEVEL;
    this.#log = withLevel(options.logger ?? consoleLogger, this.logLevel);

    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    const request: Requester = (call) => this.#request(call);
    this.skills = new Skills(request);
    this.sessions = new Sessions(request);
  }

  /**
   * Ask one or more typed questions about `state`.
   * Answers come back under the same names as the questions.
   */
  async systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: RequestOptions = {},
  ): Promise<SystemOneResponse<Q>> {
    checkRequest(request);
    return (await this.#request({
      method: "POST",
      route: "/v1/systemone",
      path: "/v1/systemone",
      body: request,
      summary: {
        questions: Object.keys(request.questions ?? {}),
        reasoning: request.reasoning ?? "default",
      },
      retry: "always",
      minTimeoutMs: latencyTimeoutMs(request.max_latency_ms),
      signal: options.signal,
    })) as SystemOneResponse<Q>;
  }

  /**
   * Write short text from `state`, or JSON that matches `shape`.
   * Pass the type of `value` yourself if you like: `generate<{ city: string }>(...)`.
   */
  async generate<V = Record<string, unknown>>(
    request: GenerateRequest,
    options: RequestOptions = {},
  ): Promise<GenerateResponse<V>> {
    checkRequest(request);
    return (await this.#request({
      method: "POST",
      route: "/v1/generate",
      path: "/v1/generate",
      body: request,
      summary: { shape: request.shape !== undefined, max_tokens: request.max_tokens ?? "default" },
      retry: "always",
      signal: options.signal,
    })) as GenerateResponse<V>;
  }

  /**
   * Cut `text` into whole items: emails, clauses, messages, entries.
   * Every item is an exact slice: `text.slice(item.start, item.end) === item.text`.
   * Give `split` (what one item is) or `skill` (a split skill), not both.
   */
  async split(request: SplitRequest, options: RequestOptions = {}): Promise<SplitResponse> {
    checkRequest(request, "{ text, split }");
    if (request.split !== undefined && request.skill !== undefined) {
      throw new WityError("Give split or skill, not both. A split skill brings its own split.");
    }
    return (await this.#request({
      method: "POST",
      route: "/v1/split",
      path: "/v1/split",
      body: request,
      summary: {
        chars: typeof request.text === "string" ? request.text.length : undefined,
        split:
          request.skill !== undefined
            ? "skill"
            : request.split === undefined
              ? "default"
              : typeof request.split === "object"
                ? "spec"
                : "words",
      },
      retry: "always",
      minTimeoutMs: LONG_READ_TIMEOUT_MS,
      signal: options.signal,
    })) as SplitResponse;
  }

  /**
   * Pull named fields out of `text`. Each value comes back as written, with its position and a confidence.
   * `fields` maps each field name to what it asks for, in plain words.
   */
  async extract<const F extends Record<string, string>>(
    request: ExtractRequest<F>,
    options: RequestOptions = {},
  ): Promise<ExtractResponse<keyof F & string>> {
    checkRequest(request, "{ text, fields }");
    return (await this.#request({
      method: "POST",
      route: "/v1/extract",
      path: "/v1/extract",
      body: request,
      summary: {
        chars: typeof request.text === "string" ? request.text.length : undefined,
        fields: Object.keys(request.fields ?? {}),
      },
      retry: "always",
      minTimeoutMs: LONG_READ_TIMEOUT_MS,
      signal: options.signal,
    })) as ExtractResponse<keyof F & string>;
  }

  async #request(call: Call): Promise<unknown> {
    const route = routeName(call.method, call.route);
    const { signal, summary } = call;
    let payload: string | undefined;
    let unknownNote: string | undefined;
    if (call.body !== undefined) {
      const body = Object.fromEntries(Object.entries(call.body).filter(([, value]) => value !== undefined));

      // Unknown fields are sent, so new API fields work without an SDK update.
      // They're never dropped silently: a warning names them, and so does a 400 error.
      // Line breaks and other control characters in a name become "?", so a name can't fake a new log line.
      const known = KNOWN_FIELDS[route];
      const unknown = known
        ? Object.keys(body)
            .filter((field) => !known.has(field))
            .map((field) => field.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?"))
        : [];
      unknownNote =
        unknown.length > 0 ? `The request included fields Wity may not know: ${unknown.join(", ")}.` : undefined;
      if (unknownNote) this.#log.warn(`${route}: ${unknownNote} Check for typos.`);

      try {
        payload = JSON.stringify(body);
      } catch (err) {
        throw new WityError("The request can't be turned into JSON. Look for BigInt values or loops in state.", {
          cause: err,
        });
      }
    }

    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) query.set(name, String(value));
    }
    const url = `${this.baseURL}${call.path}${query.size > 0 ? `?${query}` : ""}`;
    const timeoutMs = Math.min(Math.max(this.timeoutMs, call.minTimeoutMs ?? 0), MAX_TIMER_MS);
    const attempts = this.maxRetries + 1;

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;
      const retryLabel = `retry ${attempt + 1} of ${this.maxRetries}`;
      this.#log.debug(`${route}: sending (attempt ${attempt + 1} of ${attempts})`, {
        url,
        ...(payload !== undefined && { bytes: new TextEncoder().encode(payload).length }),
        ...summary,
      });
      const started = Date.now();

      let response: Response;
      let data: unknown;
      try {
        ({ response, data } = await this.#send(call.method, url, payload, timeoutMs, signal));
      } catch (err) {
        const ms = Date.now() - started;
        if (err instanceof APIConnectionError && canRetry) {
          if (call.retry === "always") {
            const delay = Math.round(backoffMs(attempt));
            this.#log.info(`${route}: connection failed after ${ms} ms. Retrying in ${delay} ms (${retryLabel}).`, err.cause);
            await this.#wait(delay, signal);
            continue;
          }
          this.#log.info(`${route}: not retrying. This call adds something, and it may have gone through.`);
        }
        this.#log.info(`${route}: ${(err as Error).message} (after ${ms} ms)`);
        throw err;
      }

      const requestId = requestIdFrom(response.headers);
      this.#log.debug(`${route}: got ${response.status} in ${Date.now() - started} ms`, { requestId });

      if (response.ok) {
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new WityError("Wity answered with something that isn't a JSON object.");
        }
        return data;
      }

      // 429 and 503 mean Wity did no work, so even a call that adds something can go again.
      const safeToRetry = call.retry === "always" || response.status === 429 || response.status === 503;
      if (canRetry && shouldRetryStatus(response.status) && !safeToRetry) {
        this.#log.info(`${route}: got ${response.status}. Not retrying: this call adds something, and it may have gone through.`, {
          requestId,
        });
      }
      if (canRetry && shouldRetryStatus(response.status) && safeToRetry) {
        const delay = delayBeforeRetry(attempt, response.headers);
        if (delay !== undefined) {
          this.#log.info(`${route}: got ${response.status}. Retrying in ${Math.round(delay)} ms (${retryLabel}).`, {
            requestId,
          });
          await this.#wait(delay, signal);
          continue;
        }
        this.#log.warn(`${route}: got ${response.status}, and Retry-After asks for more than 60 s. Not retrying.`, {
          requestId,
        });
      }
      throw APIError.fromResponse(response.status, data, response.headers, response.status === 400 ? unknownNote : undefined);
    }
  }

  /**
   * One attempt: send the request and read the whole answer.
   * One timer and the caller's signal cover both steps, so a stalled or broken
   * answer still ends in a WityError.
   */
  async #send(
    method: Call["method"],
    url: string,
    payload: string | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; data: unknown }> {
    // Checked here too, so nothing is sent even if a custom `fetch` ignores the signal.
    if (signal?.aborted) throw new APIUserAbortError("The request was cancelled.", { cause: signal.reason });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          ...(payload !== undefined && { "Content-Type": "application/json" }),
          Accept: "application/json",
        },
        body: payload,
        // Never follow a redirect: it could carry the key to an address nobody chose.
        redirect: "manual",
        signal: controller.signal,
      });
      const data = await readBody(response);
      return { response, data };
    } catch (err) {
      // The SDK's own errors, like an answer that's too large, pass through unchanged and aren't retried.
      if (err instanceof WityError) throw err;
      // Timeouts aren't retried: the request may have reached Wity, and the caller already waited.
      if (timedOut) throw new APITimeoutError(`Wity didn't answer within ${timeoutMs} ms.`, { cause: err });
      if (signal?.aborted) throw new APIUserAbortError("The request was cancelled.", { cause: err });
      throw new APIConnectionError(
        `Couldn't reach the Wity API at ${this.baseURL}, or the connection broke while reading its answer.`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Wait between retries. Cancelling through `signal` stops the wait. */
  async #wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await sleep(ms, signal);
    } catch (reason) {
      this.#log.info("Cancelled while waiting to retry.");
      throw new APIUserAbortError("The request was cancelled.", { cause: reason });
    }
  }
}
