// Request and response shapes for every Wity route.
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

/** Ask a saved skill's question. The answer is a noul or choice answer, with `skill` added. */
export interface SkillQuestion {
  /** The skill's id (`sk_...`) or name. A split skill can't be a question: use it with `split`. */
  skill: string;
}

/** Questions keyed by a name you choose. Answers come back under the same names. */
export type Questions = Record<string, Question | SkillQuestion>;

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

/** Which skill answered, and how. On answers to skill questions only. */
export interface SkillInfo {
  id: string;
  name: string;
  /** The skill version that answered. */
  version: number;
  /** `"examples"` once the skill has learned from its examples and beats the plain question. */
  answered_by: AnsweredBy;
  /** `true` when the answer used what the skill learned from its examples. */
  active: boolean;
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
  /** Only on answers to skill questions. */
  skill?: SkillInfo;
  /** The answers to a skill's parts, by part name. Only for skills with parts. */
  parts?: Record<string, NoulAnswer | ChoiceAnswer>;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability of yes, from 0 to 1. It is not calibrated. */
  noul: number;
  /** Probability of yes before thinking. Only present when Wity thought. */
  direct_noul?: number;
  reasoning?: ReasoningInfo;
  /** Only on answers to skill questions. */
  skill?: SkillInfo;
  /** The answers to a skill's parts, by part name. Only for skills with parts. */
  parts?: Record<string, NoulAnswer | ChoiceAnswer>;
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
export type AnswerFor<Q extends Question | SkillQuestion> = Q extends ChoiceQuestion<infer K>
  ? ChoiceAnswer<K>
  : Q extends NoulQuestion
    ? NoulAnswer
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : Q extends SkillQuestion
        ? NoulAnswer | ChoiceAnswer
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

/** Tokens a call read. `input_tokens` is what's billed. */
export interface Usage {
  input_tokens: number;
  /** Always 0 here. */
  output_tokens: number;
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/** A precise description of one item. */
export interface SplitSpec {
  /** What one item is, 2 to 80 characters: `"email"`, `"clause"`. */
  unit: string;
  /** What a new item starts with. Up to 8 entries of up to 300 characters. */
  starts_at?: string[];
  /** What stays inside one item. Up to 8. */
  keep_together?: string[];
  /** Where an item never starts. Up to 8. */
  never_split?: string[];
}

interface SplitRequestBase {
  /** The document. 1 to 60,000 characters of plain text. */
  text: string;
}

/** Give `split` (what one item is) or `skill` (a split skill), not both. */
export type SplitRequest =
  | (SplitRequestBase & {
      /**
       * Plain words (3 to 300 characters, like `"one item per email"`) or a spec.
       * The API default is `"one item per paragraph"`.
       */
      split?: string | SplitSpec;
      skill?: undefined;
    })
  | (SplitRequestBase & {
      /** A split skill's id or name. It splits the way its examples do. */
      skill: string;
      split?: undefined;
    });

export interface SplitItem {
  /** Character offset where the item starts. */
  start: number;
  /** Character offset where the item ends (exclusive). */
  end: number;
  /** Exactly `text.slice(start, end)`. */
  text: string;
}

export interface SplitResponse {
  /** Every item, in document order. Together they cover the document but the whitespace between them. */
  items: SplitItem[];
  /** `"model"`, or `"rule:<kind>"` when the unit was cut by rule, like `"rule:sentence"`. */
  how: string;
  /** Only when you split with a skill. */
  skill?: SkillInfo;
  timing_ms: { total: number };
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

/** Typed fields come back normalised: dates as YYYY-MM-DD. */
export type ExtractType = "date" | "duration" | "number";

export interface ExtractRequest<F extends Record<string, string> = Record<string, string>> {
  /** The document. 1 to 60,000 characters of plain text. */
  text: string;
  /**
   * 1 to 16 fields: name (up to 64 characters, no double quotes) to what the field asks for,
   * in plain words (up to 300 characters).
   */
  fields: F;
  /** Field name to type, for fields that should come back normalised. */
  types?: { [N in keyof F]?: ExtractType };
}

export interface ExtractEntity<N extends string = string> {
  field: N;
  /** The value as written. For a typed field, the normalised value. */
  text: string;
  /** Character offset where the value was read. */
  start: number;
  /** Character offset where it ends (exclusive). */
  end: number;
  /** From 0 to 1. It is not calibrated. */
  confidence: number;
}

export interface ExtractResponse<N extends string = string> {
  /** Every field you asked for, in your order, with its values. `[]` when the document has none. */
  fields: Record<N, string[]>;
  /** The same values with positions and confidence, by field and then by position. */
  entities: ExtractEntity<N>[];
  /** Time spent on the server. */
  timing_ms: number;
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Free-form data you keep on a skill or session. Up to 8,000 characters as JSON. */
export type Metadata = { [key: string]: JsonValue };

/** A page of results. Pass the last item's id as `after` to get the next page. */
export interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

export interface Deleted<O extends string = string> {
  id: string;
  object: O;
  deleted: true;
}

/** How a skill answers now. */
export type AnsweredBy = "question" | "rule" | "parts" | "examples";

/** `needs_examples` until it has enough to learn from, then `learning`, then `ready`. */
export type SkillStatus = "needs_examples" | "learning" | "ready";

/** Accuracy on the skill's own held-back examples, with and without what it learned. */
export interface SkillQuality {
  accuracy: number;
  accuracy_without_skill: number;
  checked_on: number;
}

interface SkillBase {
  /** `sk_...`. Paths take the id or the name. */
  id: string;
  object: "skill";
  name: string;
  description: string;
  metadata: Metadata;
  /** How many examples it has. */
  examples: number;
  status: SkillStatus;
  answered_by: AnsweredBy;
  /** `true` when answers use what it learned from its examples. */
  active: boolean;
  /** Goes up each time it learns or changes. */
  version: number;
  /** `null` until it has learned. */
  quality: SkillQuality | null;
  /** Unix seconds. */
  created_at: number;
  updated_at: number;
}

/** A question you save once and teach with labelled examples. Use it as `{ skill: name }` in `questions`. */
export interface DecisionSkill extends SkillBase {
  kind: "decision";
  question: NoulQuestion | ChoiceQuestion;
  /** Simpler questions the main one is split into, by name. */
  parts: Record<string, NoulQuestion | ChoiceQuestion> | null;
  /** The rule over the part names, like `"not same_state and amount"`. */
  combine: string | null;
}

/** A way to split, taught with example splits. Use it with `split({ text, skill })`. */
export interface SplitSkill extends SkillBase {
  kind: "split";
  split: string | SplitSpec;
}

export type Skill = DecisionSkill | SplitSkill;

/** A labelled example for a decision skill. */
export interface DecisionExampleInput {
  state: string | { [key: string]: JsonValue } | JsonValue[];
  /** `"yes"` / `"no"` (or `true` / `false`) for noul, an option id for choice. */
  answer: string | boolean;
}

/** An example split: the item texts in order, or the offsets where items start. */
export type SplitExampleInput = { text: string; items: string[] } | { text: string; starts: number[] };

export interface DecisionExample {
  id: string;
  object: "skill.example";
  state: string;
  answer: string;
  /** `"api"` for examples you sent, `"session"` for session feedback. */
  source: "api" | "session";
  /** Only for examples made from session feedback. */
  session_id?: string;
  created_at: number;
}

export interface SplitExample {
  id: string;
  object: "skill.example";
  text: string;
  starts: number[];
  items: string[];
  source: "api" | "session";
  created_at: number;
}

export type SkillExample = DecisionExample | SplitExample;

/** A part: a yes/no question as plain words, or a full question object. */
export type PartInput = string | NoulQuestion | ChoiceQuestion;

export interface CreateDecisionSkill {
  /** Up to 64 characters: letters, digits, `_`, `-` and `.`. Unique in your account. Not starting with `sk_`. */
  name: string;
  /** A noul or choice question. */
  question: NoulQuestion | ChoiceQuestion;
  /** For you and your team. Up to 2,000 characters. */
  description?: string;
  /** Up to 1,000 labelled examples. Learning starts at 8, with at least 2 for each of two answers. */
  examples?: DecisionExampleInput[];
  /** Up to 32 parts by name, or `"auto"` for Wity to write them. */
  parts?: Record<string, PartInput> | "auto";
  /** A rule over the part names with `and`, `or`, `not` and brackets. Noul skills only. */
  combine?: string;
  metadata?: Metadata;
}

export interface CreateSplitSkill {
  name: string;
  /** What one item is: plain words or a spec. */
  split: string | SplitSpec;
  description?: string;
  /** Up to 50 example splits, each text up to 20,000 characters. */
  examples?: SplitExampleInput[];
  metadata?: Metadata;
}

/** A new question, parts or rule makes the skill learn again. `parts: null` removes the parts and their rule. */
export interface UpdateDecisionSkill {
  name?: string;
  description?: string;
  question?: NoulQuestion | ChoiceQuestion;
  parts?: Record<string, PartInput> | "auto" | null;
  combine?: string | null;
  metadata?: Metadata;
}

export interface UpdateSplitSkill {
  name?: string;
  description?: string;
  split?: string | SplitSpec;
  metadata?: Metadata;
}

/** What `create` returns: the skill, plus what adding its examples cost. */
export type CreatedSkill<S extends Skill = Skill> = S & { usage: Usage };

export interface AddedExamples<E extends SkillExample = SkillExample> {
  object: "list";
  data: E[];
  /** The skill after the change. It starts learning a moment later. */
  skill: Skill;
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Session {
  /** `ses_...`. */
  id: string;
  object: "session";
  /** What Wity reads first. Changes only through events. */
  state: string;
  /** Skill ids the session decides with when `decide` names no questions. */
  skills: string[];
  metadata: Metadata;
  /** How many events the log holds. */
  events: number;
  /** Unix seconds. */
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface CreateSession {
  /** What Wity reads first. May be empty. */
  state?: string | { [key: string]: JsonValue };
  /** Skill ids or names, up to 64. */
  skills?: string[];
  metadata?: Metadata;
  /** Seconds until the session and its log are deleted: 60 to 7,776,000 (90 days). The API default is 7 days. */
  expires_in?: number;
}

/** The state changes only through events. */
export interface UpdateSession {
  skills?: string[];
  metadata?: Metadata;
  /** Seconds from now. */
  expires_in?: number;
}

/**
 * An event to add to a session's log.
 * `update`: added to what Wity reads. `state`: what Wity reads from here on, instead of everything before.
 * `note`: kept in the log, never read. `feedback`: the right answer to an earlier decision, which becomes
 * an example of that skill.
 */
export type SessionEventInput =
  | { type: "update" | "state" | "note"; content: string | { [key: string]: JsonValue } }
  | {
      type: "feedback";
      decision_id: string;
      answer: string | boolean;
      /** Needed when that decision had more than one skill question. */
      question?: string;
    };

export interface SessionEvent {
  id: string;
  object: "session.event";
  type: "update" | "state" | "note" | "feedback" | "decision";
  content: { [key: string]: JsonValue };
  created_at: number;
}

export interface AddedEvents {
  object: "list";
  data: SessionEvent[];
  /** The session after the change. */
  session: Session;
}

export interface SessionDecideRequest<Q extends Questions = Questions> {
  /** Leave out to run the session's skills, each keyed by its name. */
  questions?: Q;
  /** The default here is `"off"`. Skill questions are always answered in fast mode. */
  reasoning?: Reasoning;
  max_latency_ms?: number;
  /** Add this decision's answers to what later decisions read. Default false. */
  remember?: boolean;
}

export type SessionDecision<Q extends Questions = Questions> = SystemOneResponse<Q> & {
  /** Give this to a `feedback` event to correct the answer. */
  decision_id: string;
  session_id: string;
  /** How many updates the decision read, and how many of the oldest were left out to fit. */
  context: { updates_read: number; updates_left_out: number };
  /** `true` when the same contents and questions were answered before. Same answer, 0 tokens. */
  cached: boolean;
};
