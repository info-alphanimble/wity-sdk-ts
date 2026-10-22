// client.sessions: keep a state on Wity's side, add events, and decide on it (/v1/sessions).
// Session decisions are billed like systemOne. Repeats, events and reads are free.

import { checkRequest, latencyTimeoutMs, listQuery, type ListOptions, pathPart, type Requester } from "./request";
import type {
  AddedEvents,
  CreateSession,
  Deleted,
  List,
  Questions,
  RequestOptions,
  Session,
  SessionDecideRequest,
  SessionDecision,
  SessionEvent,
  SessionEventInput,
  UpdateSession,
} from "./types";

/** Sessions belong to the key's account. They expire after 7 days unless `expires_in` says otherwise. */
export class Sessions {
  readonly #request: Requester;

  constructor(request: Requester) {
    this.#request = request;
  }

  /** Not retried after an unclear failure, so no second session is made. */
  async create(request: CreateSession = {}, options: RequestOptions = {}): Promise<Session> {
    checkRequest(request, "{ state, skills }");
    return (await this.#request({
      method: "POST",
      route: "/v1/sessions",
      path: "/v1/sessions",
      body: request,
      summary: { skills: Array.isArray(request.skills) ? request.skills.length : 0 },
      retry: "busy",
      signal: options.signal,
    })) as Session;
  }

  /** Newest first. */
  async list(options: ListOptions = {}): Promise<List<Session>> {
    return (await this.#request({
      method: "GET",
      route: "/v1/sessions",
      path: "/v1/sessions",
      query: listQuery(options),
      retry: "always",
      signal: options.signal,
    })) as List<Session>;
  }

  async get(id: string, options: RequestOptions = {}): Promise<Session> {
    return (await this.#request({
      method: "GET",
      route: "/v1/sessions/{id}",
      path: `/v1/sessions/${pathPart(id, "id")}`,
      retry: "always",
      signal: options.signal,
    })) as Session;
  }

  /** Change `skills`, `metadata` or `expires_in` (counted from now). The state changes only through events. */
  async update(id: string, changes: UpdateSession, options: RequestOptions = {}): Promise<Session> {
    checkRequest(changes, "{ skills }");
    return (await this.#request({
      method: "PATCH",
      route: "/v1/sessions/{id}",
      path: `/v1/sessions/${pathPart(id, "id")}`,
      body: changes,
      summary: { fields: Object.keys(changes) },
      retry: "always",
      signal: options.signal,
    })) as Session;
  }

  /** Delete the session and its log. Examples made from its feedback stay with their skills. */
  async delete(id: string, options: RequestOptions = {}): Promise<Deleted<"session">> {
    return (await this.#request({
      method: "DELETE",
      route: "/v1/sessions/{id}",
      path: `/v1/sessions/${pathPart(id, "id")}`,
      retry: "always",
      signal: options.signal,
    })) as Deleted<"session">;
  }

  /**
   * Add 1 to 100 events, kept in order. Not retried after an unclear failure, so nothing is added twice.
   *
   * @example sessions.addEvents(id, [{ type: "update", content: "Customer: still broken" }])
   */
  async addEvents(id: string, events: SessionEventInput[], options: RequestOptions = {}): Promise<AddedEvents> {
    return (await this.#request({
      method: "POST",
      route: "/v1/sessions/{id}/events",
      path: `/v1/sessions/${pathPart(id, "id")}/events`,
      body: { events },
      summary: { events: Array.isArray(events) ? events.map((event) => event?.type) : undefined },
      retry: "busy",
      signal: options.signal,
    })) as AddedEvents;
  }

  /** The log, oldest first. */
  async events(id: string, options: ListOptions = {}): Promise<List<SessionEvent>> {
    return (await this.#request({
      method: "GET",
      route: "/v1/sessions/{id}/events",
      path: `/v1/sessions/${pathPart(id, "id")}/events`,
      query: listQuery(options),
      retry: "always",
      signal: options.signal,
    })) as List<SessionEvent>;
  }

  /**
   * Decide on what the session holds now. Leave out `questions` to run the session's skills.
   * The decision is added to the log. Not retried after an unclear failure, so it isn't logged twice.
   */
  async decide<const Q extends Questions = Questions>(
    id: string,
    request: SessionDecideRequest<Q> = {},
    options: RequestOptions = {},
  ): Promise<SessionDecision<Q>> {
    checkRequest(request, "{ questions }");
    return (await this.#request({
      method: "POST",
      route: "/v1/sessions/{id}/decide",
      path: `/v1/sessions/${pathPart(id, "id")}/decide`,
      body: request,
      summary: {
        questions: request.questions ? Object.keys(request.questions) : "session skills",
        reasoning: request.reasoning ?? "default",
      },
      retry: "busy",
      minTimeoutMs: latencyTimeoutMs(request.max_latency_ms),
      signal: options.signal,
    })) as SessionDecision<Q>;
  }
}
