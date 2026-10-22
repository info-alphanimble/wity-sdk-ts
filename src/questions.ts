// Small helpers that build question objects.
// They exist so TypeScript remembers your option ids and types the answers with them.
// The API checks the limits (option counts, lengths) and explains any problem in its error.

import type { ChoiceQuestion, NoulQuestion, ScoreQuestion, SkillQuestion } from "./types";

/**
 * Pick one option.
 *
 * @example choice("Which team?", { billing: "Payments and refunds", technical: "Bugs" })
 */
export const choice = <const C extends Record<string, string>>(
  instructions: string,
  criteria: C,
  // Ids written as numbers ({ 1: "Ground" }) come back from the API as strings ("1").
): ChoiceQuestion<`${keyof C & (string | number)}`> => ({ type: "choice", instructions, criteria });

/**
 * Yes or no. Optionally describe what yes and no mean.
 *
 * @example noul("Is this urgent?", { true: "Needs action today", false: "Can wait" })
 */
export const noul = (instructions: string, criteria?: NoulQuestion["criteria"]): NoulQuestion =>
  criteria === undefined
    ? { type: "noul", instructions }
    : { type: "noul", instructions, criteria };

/**
 * Pick a level on a scale of 2 to 10 levels, lowest first.
 * Levels can come from a variable, for example a list loaded from a database.
 *
 * @example score("How upset is the customer?", ["Calm", "Annoyed", "Angry"])
 */
export const score = (instructions: string, criteria: readonly string[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
});

/**
 * Ask a saved skill's question, by its id or name. The answer adds `skill`: which version answered, and how.
 *
 * @example skill("urgent-ticket")
 */
export const skill = (name: string): SkillQuestion => ({ skill: name });
