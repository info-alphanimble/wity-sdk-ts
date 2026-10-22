import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  ConflictError,
  DEFAULT_BASE_URL,
  InternalServerError,
  NotFoundError,
  WityClient,
  WityError,
  noul,
  skill,
} from "../src/index";
import { TEST_KEY, fakeFetch, recordingLogger, sentBody } from "./helpers";

// No fixtures were captured for these routes yet. These bodies follow the server code
// (wity-server engine/src/open_decision/skills_api.py and api_server.py, 20 Oct 2026).
const email = "From: dana@example.com\nSeal test failed.\n\nFrom: marcus@example.com\nRerun tomorrow.";
const splitReply = {
  items: [
    { start: 0, end: 40, text: email.slice(0, 40) },
    { start: 42, end: email.length, text: email.slice(42) },
  ],
  how: "model",
  timing_ms: { total: 84 },
  usage: { input_tokens: 412, output_tokens: 0 },
};
const extractReply = {
  fields: { party: ["Kestrel Foods Ltd."], "effective date": ["2025-03-14"] },
  entities: [
    { field: "party", text: "Kestrel Foods Ltd.", start: 10, end: 28, confidence: 0.98 },
    { field: "effective date", text: "2025-03-14", start: 60, end: 74, confidence: 0.91 },
  ],
  timing_ms: 503,
  usage: { input_tokens: 301, output_tokens: 0 },
};
const urgentSkill = {
  id: "sk_4f1c9e",
  object: "skill",
  kind: "decision",
  name: "urgent-ticket",
  description: "",
  question: { type: "noul", instructions: "Does this ticket need a reply within the hour?" },
  parts: null,
  combine: null,
  metadata: {},
  examples: 0,
  status: "needs_examples",
  answered_by: "question",
  active: false,
  version: 1,
  quality: null,
  created_at: 1792400000,
  updated_at: 1792400000,
};
const session = {
  id: "ses_9a41c0",
  object: "session",
  state: "Ticket #5120 from Northwind Foods.",
  skills: ["sk_4f1c9e"],
  metadata: {},
  events: 0,
  created_at: 1792400000,
  updated_at: 1792400000,
  expires_at: 1793004800,
};
const notFound = { status: 404, body: { error: "no skill 'nope'", code: "not_found" } };

const clientWith = (fake: ReturnType<typeof fakeFetch>, maxRetries = 2) =>
  new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, maxRetries, logLevel: "off" });

beforeEach(() => {
  vi.stubEnv("WITY_API_KEY", "");
  vi.stubEnv("WITY_BASE_URL", "");
  vi.stubEnv("WITY_LOG_LEVEL", "");
  return () => vi.unstubAllEnvs();
});

describe("split", () => {
  it("sends text and split to /v1/split", async () => {
    const fake = fakeFetch({ status: 200, body: splitReply });
    const res = await clientWith(fake).split({ text: email, split: "one item per email" });

    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/split`);
    expect(fake.calls[0]?.init.method).toBe("POST");
    expect(sentBody(fake.calls[0])).toEqual({ text: email, split: "one item per email" });
    for (const item of res.items) expect(email.slice(item.start, item.end)).toBe(item.text);
  });

  it("sends a split spec as it is", async () => {
    const fake = fakeFetch({ status: 200, body: splitReply });
    const split = { unit: "email", starts_at: ["a From: line"] };
    await clientWith(fake).split({ text: email, split });
    expect(sentBody(fake.calls[0])).toEqual({ text: email, split });
  });

  it("splits with a skill", async () => {
    const skillInfo = { id: "sk_1", name: "tickets", version: 2, answered_by: "examples", active: true };
    const fake = fakeFetch({ status: 200, body: { ...splitReply, skill: skillInfo } });
    const res = await clientWith(fake).split({ text: email, skill: "tickets" });
    expect(sentBody(fake.calls[0])).toEqual({ text: email, skill: "tickets" });
    expect(res.skill?.answered_by).toBe("examples");
  });

  it("refuses split and skill together, before sending anything", async () => {
    const fake = fakeFetch({ status: 200, body: splitReply });
    const request = { text: email, split: "one item per email", skill: "tickets" } as never;
    await expect(clientWith(fake).split(request)).rejects.toThrow("Give split or skill, not both.");
    expect(fake.calls).toHaveLength(0);
  });

  it("waits at least two minutes, even with a shorter timeout set", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeFetch("hang");
      const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, timeoutMs: 1000, maxRetries: 0, logLevel: "off" });
      const result = client.split({ text: email }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(fake.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(String(await result)).toContain("within 120000 ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("extract", () => {
  it("sends text, fields and types to /v1/extract", async () => {
    const fake = fakeFetch({ status: 200, body: extractReply });
    const fields = { party: "a company that signs the agreement", "effective date": "when it takes effect" };
    const res = await clientWith(fake).extract({ text: "…", fields, types: { "effective date": "date" } });

    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/extract`);
    expect(sentBody(fake.calls[0])).toEqual({ text: "…", fields, types: { "effective date": "date" } });
    expect(res.fields["effective date"]).toEqual(["2025-03-14"]);
  });
});

describe("skill questions", () => {
  it("sends { skill } as a question", async () => {
    const answer = {
      type: "noul",
      noul: 0.97,
      skill: { id: "sk_4f1c9e", name: "urgent-ticket", version: 3, answered_by: "examples", active: true },
    };
    const fake = fakeFetch({ status: 200, body: { model: "wity-1", answers: { urgent: answer }, usage: {} } });
    const res = await clientWith(fake).systemOne({ state: "…", questions: { urgent: skill("urgent-ticket") } });
    expect(sentBody(fake.calls[0])).toEqual({ state: "…", questions: { urgent: { skill: "urgent-ticket" } } });
    expect(res.answers.urgent.skill?.version).toBe(3);
  });
});

describe("skills", () => {
  it("creates a skill with POST /v1/skills", async () => {
    const fake = fakeFetch({ status: 200, body: { ...urgentSkill, usage: { input_tokens: 0, output_tokens: 0 } } });
    const question = noul("Does this ticket need a reply within the hour?");
    const created = await clientWith(fake).skills.create({ name: "urgent-ticket", question });

    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills`);
    expect(fake.calls[0]?.init.method).toBe("POST");
    expect(sentBody(fake.calls[0])).toEqual({ name: "urgent-ticket", question });
    expect(created.kind).toBe("decision");
  });

  it("lists with GET, no body, and limit and after in the query", async () => {
    const fake = fakeFetch({ status: 200, body: { object: "list", data: [urgentSkill], has_more: false } });
    await clientWith(fake).skills.list({ limit: 5, after: "sk_1" });

    const { url, init } = fake.calls[0]!;
    expect(url).toBe(`${DEFAULT_BASE_URL}/v1/skills?limit=5&after=sk_1`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  it("leaves the query out when there's nothing to send", async () => {
    const fake = fakeFetch({ status: 200, body: { object: "list", data: [], has_more: false } });
    await clientWith(fake).skills.list();
    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills`);
  });

  it("encodes names in the path", async () => {
    const fake = fakeFetch({ status: 200, body: urgentSkill });
    await clientWith(fake).skills.get("a b/c?d");
    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills/a%20b%2Fc%3Fd`);
  });

  it.each([".", "..", ""])("refuses %j as a name in a path", async (name) => {
    const fake = fakeFetch({ status: 200, body: urgentSkill });
    await expect(clientWith(fake).skills.get(name)).rejects.toThrow(WityError);
    expect(fake.calls).toHaveLength(0);
  });

  it("updates with PATCH and deletes with DELETE", async () => {
    const fake = fakeFetch(
      { status: 200, body: urgentSkill },
      { status: 200, body: { id: "sk_4f1c9e", object: "skill", deleted: true } },
    );
    const client = clientWith(fake);
    await client.skills.update("urgent-ticket", { description: "Within the hour" });
    const deleted = await client.skills.delete("urgent-ticket");

    expect(fake.calls[0]?.init.method).toBe("PATCH");
    expect(sentBody(fake.calls[0])).toEqual({ description: "Within the hour" });
    expect(fake.calls[1]?.init.method).toBe("DELETE");
    expect(fake.calls[1]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills/urgent-ticket`);
    expect(deleted.deleted).toBe(true);
  });

  it("adds, lists and deletes examples", async () => {
    const fake = fakeFetch(
      { status: 200, body: { object: "list", data: [], skill: urgentSkill, usage: { input_tokens: 9, output_tokens: 0 } } },
      { status: 200, body: { object: "list", data: [], has_more: false } },
      { status: 200, body: { id: "ex_1", object: "skill.example", deleted: true } },
    );
    const client = clientWith(fake);
    await client.skills.examples.add("urgent-ticket", [{ state: "Site down", answer: "yes" }]);
    await client.skills.examples.list("urgent-ticket", { limit: 10 });
    await client.skills.examples.delete("urgent-ticket", "ex_1");

    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills/urgent-ticket/examples`);
    expect(sentBody(fake.calls[0])).toEqual({ examples: [{ state: "Site down", answer: "yes" }] });
    expect(fake.calls[1]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills/urgent-ticket/examples?limit=10`);
    expect(fake.calls[2]?.init.method).toBe("DELETE");
    expect(fake.calls[2]?.url).toBe(`${DEFAULT_BASE_URL}/v1/skills/urgent-ticket/examples/ex_1`);
  });
});

describe("sessions", () => {
  it("creates, gets, updates and deletes", async () => {
    const fake = fakeFetch(
      { status: 200, body: session },
      { status: 200, body: session },
      { status: 200, body: session },
      { status: 200, body: { id: session.id, object: "session", deleted: true } },
    );
    const client = clientWith(fake);
    await client.sessions.create({ state: session.state, skills: ["urgent-ticket"] });
    await client.sessions.get(session.id);
    await client.sessions.update(session.id, { expires_in: 3600 });
    await client.sessions.delete(session.id);

    expect(fake.calls.map((call) => `${call.init.method} ${call.url.replace(DEFAULT_BASE_URL, "")}`)).toEqual([
      "POST /v1/sessions",
      `GET /v1/sessions/${session.id}`,
      `PATCH /v1/sessions/${session.id}`,
      `DELETE /v1/sessions/${session.id}`,
    ]);
    expect(sentBody(fake.calls[0])).toEqual({ state: session.state, skills: ["urgent-ticket"] });
    expect(sentBody(fake.calls[2])).toEqual({ expires_in: 3600 });
  });

  it("adds events and reads the log", async () => {
    const fake = fakeFetch(
      { status: 200, body: { object: "list", data: [], session } },
      { status: 200, body: { object: "list", data: [], has_more: false } },
    );
    const client = clientWith(fake);
    const events = [
      { type: "update", content: "Customer: still broken" },
      { type: "feedback", decision_id: "ev_2", answer: "no" },
    ] as const;
    await client.sessions.addEvents(session.id, [...events]);
    await client.sessions.events(session.id, { after: "ev_1" });

    expect(sentBody(fake.calls[0])).toEqual({ events });
    expect(fake.calls[1]?.url).toBe(`${DEFAULT_BASE_URL}/v1/sessions/${session.id}/events?after=ev_1`);
  });

  it("decides with an empty body to run the session's skills", async () => {
    const decision = {
      model: "wity-1",
      answers: { "urgent-ticket": { type: "noul", noul: 0.999 } },
      metadata: { reasoning: "off", elapsed_ms: 39.5 },
      decision_id: "ev_2",
      session_id: session.id,
      context: { updates_read: 2, updates_left_out: 0 },
      cached: false,
      usage: { input_tokens: 202, output_tokens: 0 },
    };
    const fake = fakeFetch({ status: 200, body: decision });
    const res = await clientWith(fake).sessions.decide(session.id);

    expect(fake.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/sessions/${session.id}/decide`);
    expect(sentBody(fake.calls[0])).toEqual({});
    expect(res.decision_id).toBe("ev_2");
  });
});

describe("retries", () => {
  it("retries a read after a 500", async () => {
    const fake = fakeFetch({ status: 500, body: { error: "oops" } }, { status: 200, body: urgentSkill });
    await clientWith(fake).skills.get("urgent-ticket");
    expect(fake.calls).toHaveLength(2);
  });

  it("doesn't retry a call that adds something after a 500", async () => {
    const fake = fakeFetch({ status: 500, body: { error: "oops" } }, { status: 200, body: session });
    await expect(clientWith(fake).sessions.create({ state: "x" })).rejects.toThrow(InternalServerError);
    expect(fake.calls).toHaveLength(1);
  });

  it("doesn't retry a call that adds something after a broken connection", async () => {
    const fake = fakeFetch(new TypeError("fetch failed"), { status: 200, body: session });
    await expect(
      clientWith(fake).skills.examples.add("urgent-ticket", [{ state: "x", answer: "yes" }]),
    ).rejects.toThrow(APIConnectionError);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([429, 503])("retries a call that adds something after a %i", async (status) => {
    const fake = fakeFetch({ status, headers: { "retry-after": "0" } }, { status: 200, body: session });
    await clientWith(fake).sessions.create({ state: "x" });
    expect(fake.calls).toHaveLength(2);
  });

  it("logs why it didn't retry", async () => {
    const fake = fakeFetch({ status: 502, body: { error: "oops" } });
    const log = recordingLogger();
    const client = new WityClient({ apiKey: TEST_KEY, fetch: fake.fetch, logger: log.logger, logLevel: "info" });
    await expect(client.sessions.addEvents("ses_1", [{ type: "note", content: "x" }])).rejects.toThrow();
    expect(log.all()).toContain("/v1/sessions/{id}/events: got 502. Not retrying: this call adds something");
  });
});

describe("errors", () => {
  it("throws NotFoundError for a missing skill, without the moved-address hint", async () => {
    const fake = fakeFetch(notFound);
    const err = await clientWith(fake).skills.get("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toBe("404 no skill 'nope'");
  });

  it("keeps the moved-address hint for a 404 that isn't Wity's", async () => {
    const fake = fakeFetch({ status: 404, body: { detail: "Not Found" } });
    const err = await clientWith(fake).skills.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain("The API address may have changed.");
  });

  it("throws ConflictError when the name is taken", async () => {
    const fake = fakeFetch({ status: 409, body: { error: "a skill named 'x' already exists", code: "conflict" } });
    const question = noul("Is it urgent?");
    await expect(clientWith(fake).skills.create({ name: "x", question })).rejects.toThrow(ConflictError);
  });
});
