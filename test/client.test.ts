import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InsufficientBalanceError,
  InternalServerError,
  RateLimitError,
  DEFAULT_BASE_URL,
  WityClient,
  WityError,
  choice,
  noul,
  score,
} from "../src/index";
import { TEST_KEY, fakeFetch, fixture, recordingLogger, sentBody } from "./helpers";

// The same questions scripts/capture-fixtures.mjs sent.
const ticket = "I was charged twice for my subscription this month. Please refund one of them today.";
const team = choice("Which team should handle this ticket?", {
  billing: "Payments, charges and refunds",
  technical: "Bugs, errors and outages",
  other: "Anything else",
});
const urgent = noul("Does the customer ask for something to happen soon?", {
  true: "They ask for fast action",
  false: "No time pressure",
});
const severity = score("How much is this hurting the customer?", ["Not at all", "A little", "A lot"]);

// Logging is off here to keep test output clean. test/logging.test.ts covers logging.
const clientWith = (fake: ReturnType<typeof fakeFetch>, maxRetries = 2) =>
  new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, maxRetries, logLevel: "off" });

beforeEach(() => {
  // Keep the real environment out of the tests.
  vi.stubEnv("WITY_API_KEY", "");
  vi.stubEnv("WITY_BASE_URL", "");
  vi.stubEnv("WITY_LOG_LEVEL", "");
  return () => vi.unstubAllEnvs();
});

describe("request", () => {
  it("sends one POST to /v1/systemone with the key and JSON", async () => {
    const fake = fakeFetch(fixture("choice"));
    await clientWith(fake).systemOne({ state: ticket, questions: { team }, reasoning: "off" });

    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0]!;
    expect(url).toBe(`${DEFAULT_BASE_URL}/v1/systemone`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TEST_KEY}`,
      "Content-Type": "application/json",
    });
    expect(sentBody(fake.calls[0])).toEqual({ state: ticket, questions: { team }, reasoning: "off" });
  });

  it("sends max_latency_ms when given", async () => {
    const fake = fakeFetch(fixture("choice"));
    await clientWith(fake).systemOne({ state: ticket, questions: { team }, max_latency_ms: 3000 });
    expect(sentBody(fake.calls[0])).toEqual({ state: ticket, questions: { team }, max_latency_ms: 3000 });
  });

  it("sends image when given", async () => {
    const fake = fakeFetch(fixture("choice"));
    const image = "data:image/png;base64,iVBORw0KGgo=";
    await clientWith(fake).systemOne({ state: ticket, questions: { team }, image });
    expect(sentBody(fake.calls[0])).toEqual({ state: ticket, questions: { team }, image });
  });

  it("sends unknown fields too, and warns about them by name", async () => {
    const fake = fakeFetch(fixture("choice"));
    const log = recordingLogger();
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, logger: log.logger });
    const request = { state: ticket, questions: { team }, max_latency: 3000, model: "ignored-by-wity" };
    await client.systemOne(request);
    expect(sentBody(fake.calls[0])).toEqual(request);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({ level: "warn" });
    // `model` is accepted by Wity, so only the typo is named.
    expect(log.lines[0]?.text).toContain("fields Wity may not know: max_latency.");
    expect(log.lines[0]?.text).not.toContain("model");
  });

  it("doesn't send fields that are undefined", async () => {
    const fake = fakeFetch(fixture("choice"));
    await clientWith(fake).systemOne({ state: ticket, questions: { team }, reasoning: undefined });
    expect(Object.keys(sentBody(fake.calls[0]))).toEqual(["state", "questions"]);
  });

  it("sends state objects as JSON", async () => {
    const fake = fakeFetch(fixture("choice"));
    await clientWith(fake).systemOne({ state: { ticket, plan: "pro" }, questions: { team } });
    expect(sentBody(fake.calls[0]).state).toEqual({ ticket, plan: "pro" });
  });
});

describe("bad input from plain JavaScript", () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;

  it.each([
    ["a state with a loop", { state: loop, questions: { team } }, "turned into JSON"],
    ["a state with a BigInt", { state: { id: 1n }, questions: { team } }, "turned into JSON"],
    ["null", null, "must be an object"],
    ["a string", "state", "must be an object"],
  ])("%s throws a WityError and sends nothing", async (_name, request, message) => {
    const fake = fakeFetch(fixture("choice"));
    const err = await clientWith(fake)
      .systemOne(request as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(WityError);
    expect(err.message).toContain(message);
    expect(fake.calls).toHaveLength(0);
    const genErr = await clientWith(fake)
      .generate(request as never)
      .catch((e) => e);
    expect(genErr).toBeInstanceOf(WityError);
  });
});

describe("response", () => {
  it.each([
    ["choice", { team }],
    ["noul", { urgent }],
    ["noul-always", { urgent }],
    ["score-always", { severity }],
    ["score", { severity }],
    ["reasoning-always", { team }],
    ["multi-auto", { team, urgent, severity }],
  ])("returns the %s response as the API sent it", async (name, questions) => {
    const saved = fixture(name);
    const fake = fakeFetch(saved);
    const res = await clientWith(fake).systemOne({ state: ticket, questions });
    expect(res).toEqual(saved.body);
  });

  it("gives typed access to answers", async () => {
    const fake = fakeFetch(fixture("multi-auto"));
    const res = await clientWith(fake).systemOne({ state: ticket, questions: { team, urgent, severity } });
    expect(res.answers.team.choice).toBe("billing");
    expect(res.answers.urgent.noul).toBeGreaterThan(0.9);
    expect(res.answers.severity.legend["2"]).toBe("A lot");
    expect(res.answers.team.reasoning?.thought).toBe(false);
  });

  it("throws if a successful response isn't a JSON object", async () => {
    const fake = fakeFetch({ status: 200, body: "not json" });
    await expect(clientWith(fake).systemOne({ state: ticket, questions: { team } })).rejects.toThrow(
      "isn't a JSON object",
    );
  });
});

describe("errors", () => {
  const ask = (fake: ReturnType<typeof fakeFetch>) =>
    clientWith(fake, 0).systemOne({ state: ticket, questions: { team } });

  it("401 becomes AuthenticationError with a hint", async () => {
    const err = await ask(fakeFetch(fixture("error-bad-key"))).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("401 invalid API key. Check WITY_API_KEY.");
  });

  it.each(["error-unknown-field", "error-object-instructions", "error-one-score-level"])(
    "%s becomes BadRequestError with the server's message",
    async (name) => {
      const saved = fixture(name);
      const err = await ask(fakeFetch(saved)).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err.message).toBe(`400 ${(saved.body as { error: string }).error}`);
      expect(err.body).toEqual(saved.body);
    },
  );

  it("402 becomes InsufficientBalanceError", async () => {
    const err = await ask(fakeFetch({ status: 402, body: { detail: "insufficient balance" } })).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect(err.message).toContain("no balance");
  });

  it("reads nested {error: {message}} bodies too", async () => {
    const err = await ask(fakeFetch({ status: 418, body: { error: { message: "nested" } } })).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toBe("418 nested");
  });

  it("404 says the address may have changed", async () => {
    const err = await ask(fakeFetch({ status: 404, body: "Not Found" })).catch((e) => e);
    expect(err.message).toContain("WITY_BASE_URL");
  });

  it("a 400 names the unknown fields that were sent, since Wity's own message can mislead", async () => {
    const fake = fakeFetch(fixture("error-unknown-field"));
    const request = { state: ticket, questions: { team }, user: "someone" };
    const err = await clientWith(fake, 0).systemOne(request).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toBe(
      "400 A System One request requires state and questions. The request included fields Wity may not know: user.",
    );
  });

  it("an HTML error page becomes a readable message", async () => {
    const html = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
    const err = await ask(fakeFetch({ status: 502, body: html })).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerError);
    expect(err.message).toBe("502 the server sent an HTML error page");
    expect(err.body).toBe(html);
  });

  it("a list of validation errors becomes 'field: problem' pairs", async () => {
    const body = {
      detail: [
        { loc: ["body", "questions", "team"], msg: "field required" },
        { loc: ["body", "state"], msg: "too long" },
      ],
    };
    const err = await ask(fakeFetch({ status: 422, body })).catch((e) => e);
    expect(err.message).toBe("422 questions.team: field required; state: too long");
  });

  it("long text bodies are cut to 200 characters in the message", async () => {
    const err = await ask(fakeFetch({ status: 500, body: "x".repeat(500) })).catch((e) => e);
    expect(err.message).toBe(`500 ${"x".repeat(200)}…`);
  });

  it("errors carry the request id when the server sends one", async () => {
    const err = await ask(
      fakeFetch({ ...fixture("error-bad-key"), headers: { "x-railway-request-id": "req_abc123" } }),
    ).catch((e) => e);
    expect(err.requestId).toBe("req_abc123");
    const without = await ask(fakeFetch(fixture("error-bad-key"))).catch((e) => e);
    expect(without.requestId).toBeUndefined();
  });

  it("error names are fixed strings, so they survive minification", async () => {
    const err = await ask(fakeFetch(fixture("error-bad-key"))).catch((e) => e);
    expect(err.name).toBe("AuthenticationError");
    expect(err.stack.split("\n")[0]).toBe("AuthenticationError: 401 invalid API key. Check WITY_API_KEY.");
  });

  it("never follows a redirect", async () => {
    const fake = fakeFetch({ status: 301, headers: { Location: "https://somewhere-else.example/v1/systemone" } });
    const err = await ask(fake).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(301);
    expect(err.message).toContain("never follows");
    expect(err.message).toContain("WITY_BASE_URL");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("retries", () => {
  it("retries a 429, waiting as long as Retry-After says", async () => {
    const fake = fakeFetch({ status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "0" } }, fixture("choice"));
    const res = await clientWith(fake).systemOne({ state: ticket, questions: { team } });
    expect(res.answers.team.choice).toBe("billing");
    expect(fake.calls).toHaveLength(2);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fake = fakeFetch({ status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "0" } });
    const err = await clientWith(fake, 2).systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(fake.calls).toHaveLength(3);
  });

  it("retries a 5xx with backoff when there's no Retry-After", async () => {
    const fake = fakeFetch({ status: 502, body: { error: "model error" } }, fixture("choice"));
    const res = await clientWith(fake, 1).systemOne({ state: ticket, questions: { team } });
    expect(res.model).toBe("wity-1");
    expect(fake.calls).toHaveLength(2);
  });

  it("doesn't retry when Retry-After is longer than 60 s", async () => {
    const fake = fakeFetch({ status: 503, body: { error: "busy" }, headers: { "Retry-After": "90" } });
    const err = await clientWith(fake).systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerError);
    expect(err.headers.get("retry-after")).toBe("90");
    expect(fake.calls).toHaveLength(1);
  });

  it("doesn't retry a 400", async () => {
    const fake = fakeFetch(fixture("error-one-score-level"));
    await clientWith(fake).systemOne({ state: ticket, questions: { team } }).catch(() => {});
    expect(fake.calls).toHaveLength(1);
  });

  it("retries network failures, then throws APIConnectionError", async () => {
    const fake = fakeFetch(new TypeError("fetch failed"));
    const err = await clientWith(fake, 1).systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toContain(new URL(DEFAULT_BASE_URL).host);
    expect(fake.calls).toHaveLength(2);
  });

  it("throws APITimeoutError when Wity doesn't answer in time, without retrying", async () => {
    const fake = fakeFetch("hang");
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, timeoutMs: 50, logLevel: "off" });
    const err = await client.systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(err.message).toContain("50 ms");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("reading the answer", () => {
  it("a connection that breaks mid-answer becomes APIConnectionError, and is retried", async () => {
    const fake = fakeFetch("broken-body", fixture("choice"));
    const res = await clientWith(fake, 1).systemOne({ state: ticket, questions: { team } });
    expect(res.answers.team.choice).toBe("billing");
    expect(fake.calls).toHaveLength(2);

    const alwaysBroken = fakeFetch("broken-body");
    const err = await clientWith(alwaysBroken, 0).systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toContain("connection broke while reading");
  });

  it("an answer that stalls halfway becomes APITimeoutError", async () => {
    const fake = fakeFetch("stall-body");
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, timeoutMs: 50, logLevel: "off" });
    const err = await client.systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("max_latency_ms and the timeout", () => {
  it("waits for max_latency_ms plus 10 s, even when timeoutMs is shorter", async () => {
    // Wity answers after 200 ms. timeoutMs alone (50 ms) would give up first.
    const fake = fakeFetch({ ...fixture("choice"), delayMs: 200 });
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, timeoutMs: 50, logLevel: "off" });
    const res = await client.systemOne({ state: ticket, questions: { team }, max_latency_ms: 300 });
    expect(res.answers.team.choice).toBe("billing");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 3e9])(
    "max_latency_ms %s doesn't make the call time out at once",
    async (max_latency_ms) => {
      const fake = fakeFetch({ ...fixture("choice"), delayMs: 100 });
      const res = await clientWith(fake).systemOne({ state: ticket, questions: { team }, max_latency_ms });
      expect(res.answers.team.choice).toBe("billing");
    },
  );

  it("keeps timeoutMs when it's already longer", async () => {
    const fake = fakeFetch("hang");
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, timeoutMs: 50, logLevel: "off" });
    const err = await client.systemOne({ state: ticket, questions: { team } }).catch((e) => e);
    expect(err.message).toBe("Wity didn't answer within 50 ms.");
  });
});

describe("cancelling with signal", () => {
  it("stops a request that's in flight", async () => {
    const fake = fakeFetch("hang");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const err = await clientWith(fake)
      .systemOne({ state: ticket, questions: { team } }, { signal: controller.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIUserAbortError);
    expect(fake.calls).toHaveLength(1);
  });

  it("doesn't send anything if already cancelled", async () => {
    const fake = fakeFetch(fixture("choice"));
    const err = await clientWith(fake)
      .systemOne({ state: ticket, questions: { team } }, { signal: AbortSignal.abort() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIUserAbortError);
    expect(fake.calls).toHaveLength(0);
  });

  it("stops the wait between retries", async () => {
    const fake = fakeFetch({ status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "30" } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const err = await clientWith(fake)
      .systemOne({ state: ticket, questions: { team } }, { signal: controller.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIUserAbortError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.calls).toHaveLength(1);
  });

  it("AbortSignal.timeout caps the total time across retries", async () => {
    const fake = fakeFetch({ status: 503, body: { error: "busy" }, headers: { "Retry-After": "1" } });
    const err = await clientWith(fake)
      .systemOne({ state: ticket, questions: { team } }, { signal: AbortSignal.timeout(100) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIUserAbortError);
    expect(fake.calls).toHaveLength(1);
  });
});
