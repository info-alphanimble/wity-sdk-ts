import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL, WityClient, WityError, choice } from "../src/index";
import { TEST_KEY, fakeFetch, fixture } from "./helpers";

const team = choice("Which team?", { billing: "Payments", technical: "Bugs" });

beforeEach(() => {
  vi.stubEnv("WITY_API_KEY", "");
  vi.stubEnv("WITY_BASE_URL", "");
  vi.stubEnv("WITY_LOG_LEVEL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Every way a key could leak when an object is printed, logged or serialised. */
const allPrintedForms = (value: unknown): string =>
  [
    inspect(value, { depth: 10, showHidden: true }),
    JSON.stringify(value) ?? "",
    String(value),
    value instanceof Error ? `${value.message} ${value.stack} ${inspect(value.cause)}` : "",
  ].join("\n");

describe("base URL", () => {
  const urlOf = (options: ConstructorParameters<typeof WityClient>[0]) =>
    new WityClient({ apiKey: TEST_KEY, ...options }).baseURL;

  it("defaults to the production address", () => {
    expect(urlOf({})).toBe(DEFAULT_BASE_URL);
  });

  it("uses WITY_BASE_URL when set", () => {
    vi.stubEnv("WITY_BASE_URL", "https://api.example.com");
    expect(urlOf({})).toBe("https://api.example.com");
  });

  it("prefers the baseURL option over WITY_BASE_URL", () => {
    vi.stubEnv("WITY_BASE_URL", "https://from-env.example.com");
    expect(urlOf({ baseURL: "https://from-option.example.com" })).toBe("https://from-option.example.com");
  });

  it("keeps a path like /api and sends requests under it", async () => {
    const fake = fakeFetch(fixture("choice"));
    const client = new WityClient({ apiKey: TEST_KEY, baseURL: "https://wity.example.com/api/", fetch: fake.fetch });
    expect(client.baseURL).toBe("https://wity.example.com/api");
    await client.systemOne({ state: "x", questions: { team } });
    expect(fake.calls[0]?.url).toBe("https://wity.example.com/api/v1/systemone");
  });

  it("refuses plain http, so the key is never sent unencrypted", () => {
    expect(() => urlOf({ baseURL: "http://api.example.com" })).toThrow("https://");
  });

  it.each(["http://localhost:8123", "http://127.0.0.1:8123", "http://[::1]:8123"])("allows http for %s", (url) => {
    expect(urlOf({ baseURL: url })).toBe(url);
  });

  it.each([
    ["a username or password", "https://user:pass@api.example.com"],
    ["? or #", "https://api.example.com?key=abc"],
    ["? or #", "https://api.example.com#part"],
  ])("refuses URLs with %s", (reason, url) => {
    expect(() => urlOf({ baseURL: url })).toThrow(reason);
  });

  it("doesn't repeat an invalid URL in the error, in case a key was pasted there", () => {
    const err = (() => {
      try {
        urlOf({ baseURL: `not a url ${TEST_KEY}` });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WityError);
    expect(allPrintedForms(err)).not.toContain(TEST_KEY);
  });
});

describe("API key", () => {
  it("reads WITY_API_KEY when no apiKey is passed", async () => {
    vi.stubEnv("WITY_API_KEY", TEST_KEY);
    const fake = fakeFetch(fixture("choice"));
    await new WityClient({ fetch: fake.fetch }).systemOne({ state: "x", questions: { team } });
    expect(fake.calls[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${TEST_KEY}` });
  });

  it("explains how to set the key when it's missing", () => {
    expect(() => new WityClient()).toThrow("WITY_API_KEY");
  });

  it.each(["", "   "])(
    "refuses an empty apiKey (%j) instead of quietly using WITY_API_KEY, which could bill another account",
    (empty) => {
      vi.stubEnv("WITY_API_KEY", "wity_someone_elses_key");
      expect(() => new WityClient({ apiKey: empty })).toThrow("The apiKey option is empty");
    },
  );

  it.each(["wity_abc def", "wity_abc\ndef", "wity_abc\tdef", "wity_abcé"])(
    "refuses keys with spaces or line breaks, without quoting them",
    (badKey) => {
      let err: unknown;
      try {
        new WityClient({ apiKey: badKey });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WityError);
      expect(allPrintedForms(err)).not.toContain("wity_");
    },
  );

  it("never shows the key when the client is printed or serialised", () => {
    const client = new WityClient({ apiKey: TEST_KEY });
    expect(allPrintedForms(client)).not.toContain(TEST_KEY);
    expect(Object.values(client).join(" ")).not.toContain(TEST_KEY);
  });

  it.each([
    ["an API error", fakeFetch(fixture("error-bad-key")), {}],
    ["a connection error", fakeFetch(new TypeError("fetch failed")), {}],
    ["a timeout", fakeFetch("hang"), { timeoutMs: 20 }],
    ["a redirect", fakeFetch({ status: 302, headers: { Location: "https://elsewhere.example" } }), {}],
    ["a broken answer", fakeFetch("broken-body"), {}],
    ["a cancelled call", fakeFetch("hang"), {}],
  ])("never shows the key in %s", async (name, fake, options) => {
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, maxRetries: 0, logLevel: "off", ...options });
    const signal = name === "a cancelled call" ? AbortSignal.timeout(20) : undefined;
    const err = await client.systemOne({ state: "x", questions: { team } }, { signal }).catch((e) => e);
    expect(err).toBeInstanceOf(WityError);
    expect(allPrintedForms(err)).not.toContain(TEST_KEY);
  });
});

describe("browser", () => {
  it("refuses to run in a browser, where visitors could read the key", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => new WityClient({ apiKey: TEST_KEY })).toThrow("browser");
  });

  it("refuses to run in a browser worker too", () => {
    vi.stubGlobal("WorkerGlobalScope", class {});
    vi.stubGlobal("importScripts", () => {});
    expect(() => new WityClient({ apiKey: TEST_KEY })).toThrow("browser");
  });
});

describe("answers from the wrong server", () => {
  it("stops reading an answer over 10 MB, and doesn't retry", async () => {
    const fake = fakeFetch({ status: 200, body: "x".repeat(11 * 1024 * 1024) });
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, logLevel: "off" });
    const err = await client.systemOne({ state: "x", questions: { team } }).catch((e) => e);
    expect(err).toBeInstanceOf(WityError);
    expect(err.message).toContain("larger than 10 MB");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("log lines", () => {
  it("a field name with a line break can't fake a new log line", async () => {
    const lines: string[] = [];
    const logger = { debug() {}, info() {}, warn: (message: string) => lines.push(message), error() {} };
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fakeFetch(fixture("choice")).fetch, logger });
    const request = { state: "x", questions: { team }, ["typo\n[wity] all good "]: 1 };
    await client.systemOne(request);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fields Wity may not know: typo?[wity] all good?.");
  });
});

describe("options", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3e9])("refuses timeoutMs %s", (timeoutMs) => {
    expect(() => new WityClient({ apiKey: TEST_KEY, timeoutMs })).toThrow("timeoutMs");
  });

  it.each([-1, 1.5])("refuses maxRetries %s", (maxRetries) => {
    expect(() => new WityClient({ apiKey: TEST_KEY, maxRetries })).toThrow("maxRetries");
  });
});
