// Type tests. `npm run typecheck` fails if any of these types are wrong.
// At runtime they only check the builders' output.

import { describe, expect, expectTypeOf, it } from "vitest";
import { type SystemOneResponse, choice, noul, score } from "../src/index";

const team = choice("Which team?", { billing: "Payments", technical: "Bugs" });
const urgent = noul("Is it urgent?");
const severity = score("How bad?", ["Low", "High"]);

type Answers = SystemOneResponse<{ team: typeof team; urgent: typeof urgent; severity: typeof severity }>["answers"];

describe("types", () => {
  it("builders make the question objects the API expects", () => {
    expect(team).toEqual({ type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } });
    expect(urgent).toEqual({ type: "noul", instructions: "Is it urgent?" });
    expect(severity).toEqual({ type: "score", instructions: "How bad?", criteria: ["Low", "High"] });
  });

  it("a choice answer knows its option ids", () => {
    expectTypeOf<Answers["team"]["choice"]>().toEqualTypeOf<"billing" | "technical">();
    expectTypeOf<Answers["team"]["probabilities"]>().toEqualTypeOf<Record<"billing" | "technical", number>>();
  });

  it("each answer has its own type", () => {
    expectTypeOf<Answers["urgent"]["noul"]>().toEqualTypeOf<number>();
    expectTypeOf<Answers["urgent"]["direct_noul"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Answers["severity"]["score"]>().toEqualTypeOf<number>();
    // @ts-expect-error: noul answers have no `choice`
    type _NoChoice = Answers["urgent"]["choice"];
  });

  it("unknown question names are a type error", () => {
    // @ts-expect-error: there is no question called `nope`
    type _Nope = Answers["nope"];
  });

  it("works with plain objects too, not just builders", () => {
    type Plain = SystemOneResponse<{
      q: { type: "choice"; instructions: string; criteria: { yes: string; no: string } };
    }>;
    expectTypeOf<Plain["answers"]["q"]["choice"]>().toEqualTypeOf<"yes" | "no">();
  });

  it("catches wrong input before any request is sent", () => {
    // Never called: these lines only need to fail the typecheck.
    const _wrong = () => {
      // @ts-expect-error: choice criteria are a map, not a list
      choice("Which?", ["a", "b"]);
    };
  });

  it("option ids written as numbers become strings, like the API returns them", () => {
    const floor = choice("Which floor?", { 1: "Ground", 2: "First" });
    type FloorAnswers = SystemOneResponse<{ floor: typeof floor }>["answers"];
    expectTypeOf<FloorAnswers["floor"]["choice"]>().toEqualTypeOf<"1" | "2">();
    expectTypeOf<FloorAnswers["floor"]["probabilities"]>().toEqualTypeOf<Record<"1" | "2", number>>();
  });

  it("score levels can come from a variable, like a list loaded from a database", () => {
    const levels: string[] = ["Low", "Medium", "High"];
    expect(score("How bad?", levels).criteria).toEqual(levels);
  });
});
