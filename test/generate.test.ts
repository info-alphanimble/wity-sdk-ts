import { inspect } from "node:util";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { AuthenticationError, BadRequestError, DEFAULT_BASE_URL, type GenerateShape, WityClient } from "../src/index";
import { TEST_KEY, fakeFetch, fixture, sentBody } from "./helpers";

// The same inputs scripts/capture-fixtures.mjs sent.
const flight = "Ticket scan: LISBOA (LIS) -> BERLIN BRANDENBURG (BER), 14 Oct, seat 23C.";
const cityShape = {
  type: "object",
  properties: { city: { type: "string", pattern: "^[A-Za-z ]{1,40}$" } },
  required: ["city"],
} satisfies GenerateShape;

const clientWith = (fake: ReturnType<typeof fakeFetch>) =>
  new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, maxRetries: 0, logLevel: "off" });

beforeEach(() => {
  vi.stubEnv("WITY_API_KEY", "");
  vi.stubEnv("WITY_BASE_URL", "");
  vi.stubEnv("WITY_LOG_LEVEL", "");
  return () => vi.unstubAllEnvs();
});

describe("generate request", () => {
  it("sends one POST to /v1/generate with the key, redirects off", async () => {
    const fake = fakeFetch(fixture("generate-shape"));
    await clientWith(fake).generate({ state: flight, instructions: "Origin city", shape: cityShape, max_tokens: 40 });

    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0]!;
    expect(url).toBe(`${DEFAULT_BASE_URL}/v1/generate`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TEST_KEY}` });
    expect(sentBody(fake.calls[0])).toEqual({
      instructions: "Origin city",
      state: flight,
      shape: cityShape,
      max_tokens: 40,
    });
  });

  it("sends only instructions when that's all you give", async () => {
    const fake = fakeFetch(fixture("generate-text"));
    await clientWith(fake).generate({ instructions: "Say hello" });
    expect(sentBody(fake.calls[0])).toEqual({ instructions: "Say hello" });
  });

  it("sends image when given", async () => {
    const fake = fakeFetch(fixture("generate-text"));
    const image = "data:image/png;base64,iVBORw0KGgo=";
    await clientWith(fake).generate({ instructions: "Describe the photo", image });
    expect(sentBody(fake.calls[0])).toEqual({ instructions: "Describe the photo", image });
  });

  it("sends unknown fields too, and names them if Wity rejects the request", async () => {
    const fake = fakeFetch(fixture("error-generate-unknown-field"));
    const request = { instructions: "Say hello", user: "someone" };
    const err = await clientWith(fake).generate(request).catch((e) => e);
    expect(sentBody(fake.calls[0])).toEqual(request);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("fields Wity may not know: user.");
  });
});

describe("generate response", () => {
  it("returns free text, with no value", async () => {
    const saved = fixture("generate-text");
    const res = await clientWith(fakeFetch(saved)).generate({ instructions: "Reply" });
    expect(res).toEqual(saved.body);
    expect(res.finish_reason).toBe("stop");
    expect(res.value).toBeUndefined();
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("returns the parsed value when a shape was sent", async () => {
    const saved = fixture("generate-shape");
    const res = await clientWith(fakeFetch(saved)).generate<{ city: string }>({
      state: flight,
      instructions: "Origin city",
      shape: cityShape,
    });
    expect(res).toEqual(saved.body);
    expect(res.value?.city).toBe("Lisbon");
    expect(JSON.parse(res.text)).toEqual(res.value);
  });

  it("returns value null and finish_reason length when cut off", async () => {
    const saved = fixture("generate-cut-off");
    const res = await clientWith(fakeFetch(saved)).generate({ state: flight, instructions: "x", shape: cityShape });
    expect(res.finish_reason).toBe("length");
    expect(res.value).toBeNull();
  });
});

describe("generate errors", () => {
  it("400 becomes BadRequestError with the server's message", async () => {
    const saved = fixture("error-generate-unknown-field");
    const err = await clientWith(fakeFetch(saved)).generate({ instructions: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    // No unknown fields were sent this time, so the SDK adds nothing.
    expect(err.message).toBe("400 unknown fields: ['user']");
  });

  it("401 becomes AuthenticationError, without the key", async () => {
    const err = await clientWith(fakeFetch(fixture("error-bad-key"))).generate({ instructions: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(inspect(err, { depth: 10 })).not.toContain(TEST_KEY);
  });

  it("retries 5xx like systemOne", async () => {
    const fake = fakeFetch({ status: 502, body: { error: "model error" } }, fixture("generate-text"));
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, maxRetries: 1, logLevel: "off" });
    const res = await client.generate({ instructions: "Reply" });
    expect(res.finish_reason).toBe("stop");
    expect(fake.calls).toHaveLength(2);
  });
});

describe("generate types", () => {
  it("value is a plain object unless you say otherwise", () => {
    const _plain = async (c: WityClient) => {
      const res = await c.generate({ instructions: "x" });
      expectTypeOf(res.value).toEqualTypeOf<Record<string, unknown> | null | undefined>();
    };
  });

  it("value takes the type you pass", () => {
    const _typed = async (c: WityClient) => {
      const res = await c.generate<{ city: string }>({ instructions: "x" });
      expectTypeOf(res.value).toEqualTypeOf<{ city: string } | null | undefined>();
    };
  });

  it("a shape can live in a variable or have an interface type", () => {
    const _ok = (c: WityClient) => {
      const inVariable = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
      c.generate({ instructions: "x", shape: inVariable });
      interface Schema {
        type: string;
        properties: Record<string, { type: string }>;
      }
      const typed: Schema = { type: "object", properties: { city: { type: "string" } } };
      c.generate({ instructions: "x", shape: typed });
    };
  });

  it("instructions are required", () => {
    const _wrong = (c: WityClient) => {
      // @ts-expect-error: instructions are required
      c.generate({ state: "x" });
    };
  });
});
