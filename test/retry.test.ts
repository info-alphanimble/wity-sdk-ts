import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RETRY_AFTER_MS, backoffMs, delayBeforeRetry, retryAfterMs, shouldRetryStatus, sleep } from "../src/retry";

const headers = (retryAfter?: string) => new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shouldRetryStatus", () => {
  it.each([408, 429, 500, 502, 503, 599])("retries %i", (status) => {
    expect(shouldRetryStatus(status)).toBe(true);
  });
  it.each([200, 301, 400, 401, 402, 404, 422])("doesn't retry %i", (status) => {
    expect(shouldRetryStatus(status)).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds", () => {
    expect(retryAfterMs(headers("1"))).toBe(1_000);
    expect(retryAfterMs(headers("0.5"))).toBe(500);
    expect(retryAfterMs(headers("0"))).toBe(0);
  });

  it("reads an HTTP date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    expect(retryAfterMs(headers("Wed, 30 Sep 2026 12:00:05 GMT"))).toBe(5_000);
  });

  it("treats a date in the past as no wait", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    expect(retryAfterMs(headers("Wed, 30 Sep 2026 11:00:00 GMT"))).toBe(0);
  });

  it.each([undefined, "", "soon"])("ignores %j", (value) => {
    expect(retryAfterMs(headers(value))).toBeUndefined();
  });

  it("treats negative seconds as no wait", () => {
    expect(retryAfterMs(headers("-5"))).toBe(0);
  });
});

describe("backoffMs", () => {
  it("doubles from 0.5 s, and random jitter takes off up to 25%", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([500, 1_000, 2_000, 4_000]);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffMs(0)).toBe(375);
  });

  it("never waits more than 8 s", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffMs(10)).toBe(8_000);
    expect(backoffMs(100)).toBe(8_000);
  });
});

describe("delayBeforeRetry", () => {
  it("uses Retry-After when the server sends one", () => {
    expect(delayBeforeRetry(0, headers("2"))).toBe(2_000);
  });

  it("falls back to backoff without Retry-After", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(delayBeforeRetry(1, headers())).toBe(1_000);
  });

  it("stops retrying when Retry-After asks for more than 60 s", () => {
    expect(delayBeforeRetry(0, headers(String(MAX_RETRY_AFTER_MS / 1000)))).toBe(MAX_RETRY_AFTER_MS);
    expect(delayBeforeRetry(0, headers("90"))).toBeUndefined();
  });
});

describe("sleep", () => {
  it("waits, then resolves", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const waiting = sleep(1_000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toHaveBeenCalled();
  });

  it("stops early when the signal fires", async () => {
    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
  });

  it("rejects at once if the signal already fired", async () => {
    await expect(sleep(60_000, AbortSignal.abort(new Error("already")))).rejects.toThrow("already");
  });
});
