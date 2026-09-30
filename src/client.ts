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
import type {
  GenerateRequest,
  GenerateResponse,
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResponse,
} from "./types";

/**
 * The production API address.
 * If it ever moves: change this line, bump the version and publish.
 * Until users update, they can set WITY_BASE_URL or the `baseURL` option.
 */
export const DEFAULT_BASE_URL = "https://wity-proxy-production-2c33.up.railway.app";

/** Thinking can take a few seconds. Longer `max_latency_ms` values raise the timeout automatically. */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

/** Extra time on top of `max_latency_ms` for the network and Wity's own work. */
const LATENCY_MARGIN_MS = 10_000;

/** The longest delay `setTimeout` accepts. A longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Wity's answers are a few kB. A body far bigger than that isn't a Wity answer, so the SDK stops reading. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Top-level fields each route accepts, from the API docs. `model` is accepted and ignored by Wity.
 * Other fields are still sent, so new API fields work without an SDK update, but the SDK logs a warning.
 */
const KNOWN_FIELDS = {
  "/v1/systemone": new Set(["state", "questions", "reasoning", "max_latency_ms", "image", "model"]),
  "/v1/generate": new Set(["state", "instructions", "shape", "max_tokens", "image", "model"]),
};
type Route = keyof typeof KNOWN_FIELDS;

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

/** What `debug` logs about a request. Never the key, never the `state` text. */
type Summary = Record<string, unknown>;

/** Plain JavaScript can pass anything. Fail with a WityError before reading fields off it. */
const checkRequest = (request: unknown): void => {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new WityError("The request must be an object, for example { state, questions }.");
  }
};

/** Client for the Wity API. Use it on a server only: it holds your API key. */
export class WityClient {
  /** The address requests go to. Useful to check which API you're calling. */
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logLevel: LogLevel;
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
    const latency = request.max_latency_ms;
    const summary = {
      questions: Object.keys(request.questions ?? {}),
      reasoning: request.reasoning ?? "default",
    };
    return (await this.#post("/v1/systemone", request, summary, {
      signal: options.signal,
      // Give Wity the full time it was allowed, plus room for the network.
      minTimeoutMs: Number.isFinite(latency) ? (latency as number) + LATENCY_MARGIN_MS : 0,
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
    const summary = { shape: request.shape !== undefined, max_tokens: request.max_tokens ?? "default" };
    return (await this.#post("/v1/generate", request, summary, {
      signal: options.signal,
      minTimeoutMs: 0,
    })) as GenerateResponse<V>;
  }

  async #post(
    route: Route,
    request: object,
    summary: Summary,
    { signal, minTimeoutMs }: { signal: AbortSignal | undefined; minTimeoutMs: number },
  ): Promise<unknown> {
    const body = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));

    // Unknown fields are sent, so new API fields work without an SDK update.
    // They're never dropped silently: a warning names them, and so does a 400 error.
    // Line breaks and other control characters in a name become "?", so a name can't fake a new log line.
    const unknown = Object.keys(body)
      .filter((field) => !KNOWN_FIELDS[route].has(field))
      .map((field) => field.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?"));
    const unknownNote =
      unknown.length > 0 ? `The request included fields Wity may not know: ${unknown.join(", ")}.` : undefined;
    if (unknownNote) this.#log.warn(`${route}: ${unknownNote} Check for typos.`);

    const url = `${this.baseURL}${route}`;
    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch (err) {
      throw new WityError("The request can't be turned into JSON. Look for BigInt values or loops in state.", {
        cause: err,
      });
    }
    const timeoutMs = Math.min(Math.max(this.timeoutMs, minTimeoutMs), MAX_TIMER_MS);
    const attempts = this.maxRetries + 1;

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;
      const retryLabel = `retry ${attempt + 1} of ${this.maxRetries}`;
      this.#log.debug(`${route}: sending (attempt ${attempt + 1} of ${attempts})`, {
        url,
        bytes: new TextEncoder().encode(payload).length,
        ...summary,
      });
      const started = Date.now();

      let response: Response;
      let data: unknown;
      try {
        ({ response, data } = await this.#send(url, payload, timeoutMs, signal));
      } catch (err) {
        const ms = Date.now() - started;
        if (err instanceof APIConnectionError && canRetry) {
          const delay = Math.round(backoffMs(attempt));
          this.#log.info(`${route}: connection failed after ${ms} ms. Retrying in ${delay} ms (${retryLabel}).`, err.cause);
          await this.#wait(delay, signal);
          continue;
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

      if (canRetry && shouldRetryStatus(response.status)) {
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
    url: string,
    payload: string,
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
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
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
