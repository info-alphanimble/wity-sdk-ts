import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WityClient, WityError, choice } from "../src/index";
import { TEST_KEY, fakeFetch, fixture, recordingLogger } from "./helpers";

const team = choice("Which team?", { billing: "Payments", technical: "Bugs" });
/** Stands in for customer data. It must never appear in logs. */
const STATE = "PRIVATE_CUSTOMER_TEXT_987 I was charged twice";

beforeEach(() => {
  vi.stubEnv("WITY_API_KEY", "");
  vi.stubEnv("WITY_BASE_URL", "");
  vi.stubEnv("WITY_LOG_LEVEL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const clientWith = (fake: ReturnType<typeof fakeFetch>, options: ConstructorParameters<typeof WityClient>[0] = {}) => {
  const log = recordingLogger();
  const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, logger: log.logger, ...options });
  return { client, log };
};

describe("levels", () => {
  it("defaults to warn: quiet when things work", async () => {
    const { client, log } = clientWith(
      fakeFetch({ status: 429, body: { detail: "slow" }, headers: { "Retry-After": "0" } }, fixture("choice")),
    );
    expect(client.logLevel).toBe("warn");
    await client.systemOne({ state: STATE, questions: { team } });
    // A retry is logged at info, so nothing shows at warn.
    expect(log.lines).toEqual([]);
  });

  it("off logs nothing, not even warnings", async () => {
    const { client, log } = clientWith(fakeFetch(fixture("choice")), { logLevel: "off" });
    const request = { state: STATE, questions: { team }, typo_field: 1 };
    await client.systemOne(request);
    expect(log.lines).toEqual([]);
  });

  it("info shows retries, with the reason and the wait", async () => {
    const { client, log } = clientWith(
      fakeFetch({ status: 429, body: { detail: "slow" }, headers: { "Retry-After": "0" } }, fixture("choice")),
      { logLevel: "info" },
    );
    await client.systemOne({ state: STATE, questions: { team } });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({ level: "info" });
    expect(log.lines[0]?.text).toContain("/v1/systemone: got 429. Retrying in 0 ms (retry 1 of 2).");
  });

  it("debug shows each request's summary, status and request id", async () => {
    const { client, log } = clientWith(
      fakeFetch({ ...fixture("choice"), headers: { "x-railway-request-id": "req_42" } }),
      { logLevel: "debug" },
    );
    await client.systemOne({ state: STATE, questions: { team }, reasoning: "off" });
    const all = log.all();
    expect(all).toContain("/v1/systemone: sending (attempt 1 of 3)");
    expect(all).toContain("questions: [ 'team' ]");
    expect(all).toContain("reasoning: 'off'");
    expect(all).toContain("/v1/systemone: got 200");
    expect(all).toContain("req_42");
  });

  it("reads WITY_LOG_LEVEL, in any case", () => {
    vi.stubEnv("WITY_LOG_LEVEL", "DEBUG");
    expect(clientWith(fakeFetch(fixture("choice"))).client.logLevel).toBe("debug");
  });

  it("the logLevel option wins over WITY_LOG_LEVEL", () => {
    vi.stubEnv("WITY_LOG_LEVEL", "debug");
    expect(clientWith(fakeFetch(fixture("choice")), { logLevel: "off" }).client.logLevel).toBe("off");
  });

  it("refuses unknown levels and lists the valid ones", () => {
    expect(() => clientWith(fakeFetch(fixture("choice")), { logLevel: "loud" as never })).toThrow(
      "must be one of: debug, info, warn, error, off",
    );
    vi.stubEnv("WITY_LOG_LEVEL", "verbose");
    expect(() => clientWith(fakeFetch(fixture("choice")))).toThrow(WityError);
  });

  it("the default logger is the console, with a [wity] prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fakeFetch(fixture("choice")).fetch });
    const request = { state: STATE, questions: { team }, typo_field: 1 };
    await client.systemOne(request);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[wity\] \/v1\/systemone: The request included fields/);
  });
});

describe("what logs never contain", () => {
  it.each([
    ["a success", fakeFetch(fixture("choice")), {}],
    ["a retried 429", fakeFetch({ status: 429, body: {}, headers: { "Retry-After": "0" } }, fixture("choice")), {}],
    ["a retried connection error", fakeFetch(new TypeError("fetch failed"), fixture("choice")), {}],
    ["a broken answer", fakeFetch("broken-body"), { maxRetries: 0 }],
    ["an API error", fakeFetch(fixture("error-bad-key")), {}],
    ["a timeout", fakeFetch("hang"), { timeoutMs: 20 }],
  ])("%s at debug: no API key, no state text", async (_name, fake, options) => {
    const { client, log } = clientWith(fake, { logLevel: "debug", ...options });
    const request = { state: STATE, questions: { team }, typo_field: 1 };
    await client.systemOne(request).catch(() => {});
    await client.generate({ state: STATE, instructions: "Reply" }).catch(() => {});
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.all()).not.toContain(TEST_KEY);
    expect(log.all()).not.toContain("PRIVATE_CUSTOMER_TEXT");
  });
});
