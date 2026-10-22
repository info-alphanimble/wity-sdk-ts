// client.skills: create, teach and manage skills (/v1/skills).
// Reading and managing skills is free. Adding examples is billed once, on their tokens.

import { checkRequest, listQuery, type ListOptions, pathPart, type Requester } from "./request";
import type {
  AddedExamples,
  CreatedSkill,
  CreateDecisionSkill,
  CreateSplitSkill,
  DecisionExampleInput,
  DecisionSkill,
  Deleted,
  List,
  RequestOptions,
  Skill,
  SkillExample,
  SplitExampleInput,
  SplitSkill,
  UpdateDecisionSkill,
  UpdateSplitSkill,
} from "./types";

/** Teach a skill more examples, list them, or remove one. */
export class SkillExamples {
  readonly #request: Requester;

  constructor(request: Requester) {
    this.#request = request;
  }

  /**
   * Add 1 to 1,000 examples. The skill starts learning a moment later.
   * Decision skills take `{ state, answer }`, split skills `{ text, items }` or `{ text, starts }`.
   * Billed once, on the examples' tokens. Not retried after an unclear failure, so nothing is added twice.
   */
  async add(
    skill: string,
    examples: DecisionExampleInput[] | SplitExampleInput[],
    options: RequestOptions = {},
  ): Promise<AddedExamples> {
    return (await this.#request({
      method: "POST",
      route: "/v1/skills/{skill}/examples",
      path: `/v1/skills/${pathPart(skill, "skill")}/examples`,
      body: { examples },
      summary: { examples: Array.isArray(examples) ? examples.length : undefined },
      retry: "busy",
      signal: options.signal,
    })) as AddedExamples;
  }

  /** Newest first. */
  async list(skill: string, options: ListOptions = {}): Promise<List<SkillExample>> {
    return (await this.#request({
      method: "GET",
      route: "/v1/skills/{skill}/examples",
      path: `/v1/skills/${pathPart(skill, "skill")}/examples`,
      query: listQuery(options),
      retry: "always",
      signal: options.signal,
    })) as List<SkillExample>;
  }

  async delete(skill: string, exampleId: string, options: RequestOptions = {}): Promise<Deleted<"skill.example">> {
    return (await this.#request({
      method: "DELETE",
      route: "/v1/skills/{skill}/examples/{example_id}",
      path: `/v1/skills/${pathPart(skill, "skill")}/examples/${pathPart(exampleId, "exampleId")}`,
      retry: "always",
      signal: options.signal,
    })) as Deleted<"skill.example">;
  }
}

/** Skills belong to the key's account. Wherever a method takes `skill`, pass the id (`sk_...`) or the name. */
export class Skills {
  readonly examples: SkillExamples;
  readonly #request: Requester;

  constructor(request: Requester) {
    this.#request = request;
    this.examples = new SkillExamples(request);
  }

  /**
   * Make a skill. With `question`, a decision skill: use it as `{ skill: name }` in `questions`.
   * With `split`, a split skill: use it with `client.split({ text, skill })`.
   * Not retried after an unclear failure. A retry after the skill was made would fail with ConflictError.
   */
  async create(request: CreateDecisionSkill, options?: RequestOptions): Promise<CreatedSkill<DecisionSkill>>;
  async create(request: CreateSplitSkill, options?: RequestOptions): Promise<CreatedSkill<SplitSkill>>;
  async create(request: CreateDecisionSkill | CreateSplitSkill, options?: RequestOptions): Promise<CreatedSkill>;
  async create(
    request: CreateDecisionSkill | CreateSplitSkill,
    options: RequestOptions = {},
  ): Promise<CreatedSkill> {
    checkRequest(request, "{ name, question }");
    return (await this.#request({
      method: "POST",
      route: "/v1/skills",
      path: "/v1/skills",
      body: request,
      summary: {
        kind: "split" in request ? "split" : "decision",
        examples: Array.isArray(request.examples) ? request.examples.length : 0,
      },
      retry: "busy",
      signal: options.signal,
    })) as CreatedSkill;
  }

  /** Newest first. */
  async list(options: ListOptions = {}): Promise<List<Skill>> {
    return (await this.#request({
      method: "GET",
      route: "/v1/skills",
      path: "/v1/skills",
      query: listQuery(options),
      retry: "always",
      signal: options.signal,
    })) as List<Skill>;
  }

  async get(skill: string, options: RequestOptions = {}): Promise<Skill> {
    return (await this.#request({
      method: "GET",
      route: "/v1/skills/{skill}",
      path: `/v1/skills/${pathPart(skill, "skill")}`,
      retry: "always",
      signal: options.signal,
    })) as Skill;
  }

  /**
   * Change a skill. A new question, parts or rule makes it learn again.
   * A decision skill takes name, description, question, parts, combine and metadata.
   * A split skill takes name, description, split and metadata.
   */
  async update(
    skill: string,
    changes: UpdateDecisionSkill | UpdateSplitSkill,
    options: RequestOptions = {},
  ): Promise<Skill> {
    checkRequest(changes, "{ description }");
    return (await this.#request({
      method: "PATCH",
      route: "/v1/skills/{skill}",
      path: `/v1/skills/${pathPart(skill, "skill")}`,
      body: changes,
      summary: { fields: Object.keys(changes) },
      retry: "always",
      signal: options.signal,
    })) as Skill;
  }

  /** Delete the skill and its examples. */
  async delete(skill: string, options: RequestOptions = {}): Promise<Deleted<"skill">> {
    return (await this.#request({
      method: "DELETE",
      route: "/v1/skills/{skill}",
      path: `/v1/skills/${pathPart(skill, "skill")}`,
      retry: "always",
      signal: options.signal,
    })) as Deleted<"skill">;
  }
}
