// Real calls through WityClient to the real API. Skipped unless you run:
//   npm run test:live
// It reads WITY_API_KEY and WITY_BASE_URL from the environment, or from .env in this folder.
// Two calls are billed (a tiny amount). The two error calls are free.

import { describe, expect, it } from "vitest";
import { AuthenticationError, BadRequestError, WityClient, choice, noul, score } from "../src/index";

const live = process.env.WITY_LIVE === "1";

describe.runIf(live)("live API", () => {
  const client = () => new WityClient({ logLevel: "off" });
  const ticket = "I was charged twice for my subscription this month. Please refund one of them today.";

  it("systemOne answers all three question types", async () => {
    const res = await client().systemOne({
      state: ticket,
      questions: {
        team: choice("Which team should handle this ticket?", { billing: "Payments", technical: "Bugs" }),
        urgent: noul("Does the customer ask for something to happen soon?"),
        upset: score("How upset is the customer?", ["Calm", "Annoyed", "Angry"]),
      },
      reasoning: "off",
    });
    expect(res.model).toBe("wity-1");
    expect(["billing", "technical"]).toContain(res.answers.team.choice);
    const total = res.answers.team.probabilities.billing + res.answers.team.probabilities.technical;
    expect(total).toBeCloseTo(1, 5);
    expect(res.answers.urgent.noul).toBeGreaterThanOrEqual(0);
    expect(res.answers.urgent.noul).toBeLessThanOrEqual(1);
    expect(res.answers.upset.score).toBeGreaterThanOrEqual(0);
    expect(res.answers.upset.score).toBeLessThanOrEqual(2);
    expect(res.usage.input_tokens).toBeGreaterThan(0);
  });

  it("generate returns JSON in the shape", async () => {
    const res = await client().generate<{ city: string }>({
      state: "Ticket scan: LISBOA (LIS) -> BERLIN BRANDENBURG (BER), 14 Oct, seat 23C.",
      instructions: "Origin city name, in English",
      shape: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      max_tokens: 40,
    });
    expect(res.finish_reason).toBe("stop");
    expect(typeof res.value?.city).toBe("string");
  });

  it("a wrong key gives AuthenticationError with a request id", async () => {
    const err = await new WityClient({ apiKey: "wity_not_a_real_key", logLevel: "off" })
      .systemOne({ state: "x", questions: { q: noul("x?") } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(typeof err.requestId).toBe("string");
  });

  it("an unknown field is sent, rejected, and named in the error", async () => {
    const request = { state: "x", questions: { q: noul("x?") }, not_a_field: true };
    const err = await client().systemOne(request).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("fields Wity may not know: not_a_field");
  });
});
