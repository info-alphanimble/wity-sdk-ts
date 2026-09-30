// When to try a failed request again, and how long to wait first.

/** Statuses worth retrying: 408 (timeout), 429 (too many requests) and 5xx (Wity's side). */
export const shouldRetryStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/**
 * The longest wait the SDK accepts from a `Retry-After` header.
 * Wity's 503 asks for 90 s. That's too long to block silently, so the SDK
 * throws instead and the caller decides.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Read `Retry-After` as milliseconds. It can be seconds ("1") or a date. */
export const retryAfterMs = (headers: Headers): number | undefined => {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

/** Wait 0.5 s, then 1 s, 2 s... up to 8 s. The random part stops many clients retrying at the same moment. */
export const backoffMs = (attempt: number): number =>
  Math.min(500 * 2 ** attempt, 8_000) * (0.75 + Math.random() * 0.25);

/** How long to wait before the next try, or `undefined` to stop retrying. */
export const delayBeforeRetry = (attempt: number, headers: Headers): number | undefined => {
  const fromServer = retryAfterMs(headers);
  if (fromServer === undefined) return backoffMs(attempt);
  return fromServer <= MAX_RETRY_AFTER_MS ? fromServer : undefined;
};

/** Wait `ms`. If `signal` fires first, stop waiting and reject with its reason. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
