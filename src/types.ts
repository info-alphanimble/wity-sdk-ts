// Request and response shapes for POST /v1/systemone and POST /v1/generate.
// Field names match the real API responses saved in test/fixtures/.

/** A JSON value. Used for state given as an object or array. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** How much Wity thinks before answering. The API default is `"auto"`. */
export type Reasoning = "off" | "auto" | "always";

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Pick one option. `criteria` maps each option id to a description. */
export interface ChoiceQuestion<K extends string = string> {
  type: "choice";
  instructions: string;
  criteria: Record<K, string>;
}

/** Yes or no. `criteria` optionally describes what yes and no mean. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

/** Pick a level on a scale. `criteria` lists 2 to 10 levels, lowest first. Wity checks the count. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: readonly string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

/** Questions keyed by a name you choose. Answers come back under the same names. */
export type Questions = Record<string, Question>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** How Wity reasoned about one answer. Missing when reasoning is `"off"`. */
export interface ReasoningInfo {
  mode: "auto" | "always";
  /** Whether Wity thought before answering. */
  thought: boolean;
  /** Why it thought, for example `"close_call"` or `"requested"`. `null` if it didn't. */
  reason: string | null;
  /** Whether the question asks for a likelihood. */
  forecast: boolean;
  /** Tokens spent thinking. `null` if it didn't think. */
  thought_tokens: number | null;
  /** `true` when `max_latency_ms` cut the thinking short. */
  budget_limited: boolean;
  samples: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  /** The option with the highest probability. */
  choice: K;
  /** Probability per option. They sum to 1. They are not calibrated. */
  probabilities: Record<K, number>;
  confidence: number;
  /** Probabilities before thinking. Only present when Wity thought. */
  direct_probabilities?: Record<K, number>;
  reasoning?: ReasoningInfo;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability of yes, from 0 to 1. It is not calibrated. */
  noul: number;
  /** Probability of yes before thinking. Only present when Wity thought. */
  direct_noul?: number;
  reasoning?: ReasoningInfo;
}

export interface ScoreAnswer {
  type: "score";
  /** Expected level. It can fall between levels, for example 1.97. */
  score: number;
  /** Level descriptions keyed by level number ("0", "1", ...). */
  legend: Record<string, string>;
  /** Probability per level number. They sum to 1. They are not calibrated. */
  probabilities: Record<string, number>;
  confidence: number;
  /** Probabilities before thinking. Only present when Wity thought. */
  direct_probabilities?: Record<string, number>;
  reasoning?: ReasoningInfo;
}

/** The answer type for a question. A choice answer keeps its option ids. */
export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion<infer K>
  ? ChoiceAnswer<K>
  : Q extends NoulQuestion
    ? NoulAnswer
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

// ---------------------------------------------------------------------------
// Request and response
// ---------------------------------------------------------------------------

export interface SystemOneRequest<Q extends Questions = Questions> {
  /** What the decision is about. Objects and arrays are read as JSON. */
  state: string | { [key: string]: JsonValue } | JsonValue[];
  questions: Q;
  /** Defaults to `"auto"` on the API. */
  reasoning?: Reasoning;
  /**
   * Time limit per request, 200 to 120000 ms. Thinking stops early to meet it.
   * The SDK waits at least this long plus 10 s before timing out.
   */
  max_latency_ms?: number;
  /** One image as a data URL: `data:image/png;base64,...`. */
  image?: string;
}

/** Options for a single call. */
export interface RequestOptions {
  /**
   * Cancel the call, including any retries and the waits between them.
   * For a total time limit across retries, pass `AbortSignal.timeout(ms)`.
   */
  signal?: AbortSignal;
}

export interface SystemOneResponse<Q extends Questions = Questions> {
  /** Always `"wity-1"` today. */
  model: string;
  answers: { [N in keyof Q]: AnswerFor<Q[N]> };
  metadata: {
    reasoning: Reasoning;
    elapsed_ms: number;
  };
  usage: {
    input_tokens: number;
    /** Always 0. Output is free. */
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

/**
 * A JSON Schema for the output, with `"type": "object"` at the top level.
 * Any object is accepted here, so schemas kept in variables work too. Wity checks the schema itself.
 */
export type GenerateShape = object;

export interface GenerateRequest {
  /** What to write from. Objects and arrays are read as JSON. */
  state?: string | { [key: string]: JsonValue } | JsonValue[];
  /** What to write. */
  instructions: string;
  /**
   * Leave out for free text. With a shape, a finished answer (`finish_reason: "stop"`)
   * matches it and comes back parsed in `value`.
   */
  shape?: GenerateShape;
  /** 1 to 512. The API default is 128. */
  max_tokens?: number;
  /** One image as a data URL: `data:image/png;base64,...`. */
  image?: string;
}

/** `V` is the type of `value`. Pass it yourself, for example `generate<{ city: string }>(...)`. */
export interface GenerateResponse<V = Record<string, unknown>> {
  /** Always `"wity-1"` today. */
  model: string;
  /** What Wity wrote. With a shape, this is the JSON as text. If cut off, it's incomplete. */
  text: string;
  /** Only present when you sent a shape. `null` if the output was cut off by `max_tokens`. */
  value?: V | null;
  /** `"length"` means Wity hit `max_tokens`. Raise it if the text looks cut off. */
  finish_reason: "stop" | "length";
  usage: {
    input_tokens: number;
    /** Reported, not billed. */
    output_tokens: number;
  };
  metadata: {
    elapsed_ms: number;
  };
}
