# Changelog

All notable changes to `wity-sdk` (TypeScript). Versions follow [semver](https://semver.org). Before 1.0, a minor version can add features.

## 0.2.1 (2026-10-26)

### Added

- **Update notice.** On Node at a terminal, a client tells you on stderr when a newer `wity-sdk` is on npm, at most once a day. The check runs at most once a day in the background and never keeps your program running. It stays quiet in CI, when output is piped, on servers, and outside Node. `WITY_NO_UPDATE_CHECK=1` turns it off.
- `VERSION`, this package's version.

## 0.2.0 (2026-10-22)

Split documents, extract fields, and teach Wity with skills and sessions.

### Added

- **Split.** `client.split({ text, split })` cuts a document into whole items: emails, clauses, messages, log entries. Every item is an exact slice of the text, with `start` and `end` offsets.
  - `split` is plain words (`"one item per email"`) or a spec: `{ unit, starts_at, keep_together, never_split }`.
  - `how` says whether the model cut it (`"model"`) or a rule did (`"rule:sentence"`, `"rule:line"`, ...).
  - `skill` splits the way a split skill's examples do. Give `split` or `skill`, not both.
- **Extract.** `client.extract({ text, fields, types })` pulls named fields out of a document. Each value comes back as written, with its offsets and a confidence. `types` normalises a field as a `date`, `duration` or `number`.
- **Skills.** `client.skills` saves a question once and learns your definition from labelled examples.
  - `create`, `list`, `get`, `update` and `delete`.
  - `examples.add`, `examples.list` and `examples.delete`.
  - Decision skills take a `noul` or `choice` question, with optional `parts` and a `combine` rule. Split skills take a `split` and example splits.
  - A skill comes back as `DecisionSkill` or `SplitSkill`, told apart by `kind`.
- **Skill questions.** `skill("name")` asks a saved skill's question in `systemOne`. The answer adds `skill` (which version answered, and how) and, for skills with parts, `parts`.
- **Sessions.** `client.sessions` keeps a state on Wity's side.
  - `create`, `list`, `get`, `update` and `delete`.
  - `addEvents` adds updates, a new state, notes, or feedback that becomes a skill example.
  - `events` reads the log.
  - `decide` runs the session's skills, or your own questions, on what the session holds now.
- **Errors.** `NotFoundError` (404) for a missing skill, session or example. `ConflictError` (409) for a skill name that's taken.
- **Types** for every new request and response, and `ListOptions` (`limit`, `after`) for the list calls.

### Changed

- Calls that add something retry only after 429 and 503, when Wity did no work. These are `skills.create`, `skills.examples.add`, `sessions.create`, `sessions.addEvents` and `sessions.decide`. After any other failure the call may have gone through, so the SDK throws instead of adding it, or billing it, twice. Other calls retry as before.
- Split and extract wait at least 120 s before timing out, even if `timeoutMs` is shorter. Long documents take a while.
- A 404 from Wity's own "not found" no longer adds the hint that the API address may have changed. A 404 for an address that doesn't exist still does.

### Security

- Ids and names are encoded before they go in a URL path. `.` and `..` are refused, since in a URL they point at a different address.

## 0.1.1 (2026-10-05)

### Changed

- The default API address is now `https://api.wity.alphanimble.com`. It reaches the same server as the old Railway address, which keeps working for 0.1.0.

## 0.1.0 (2026-09-30)

First release.

- `WityClient` for `POST /v1/systemone` (typed decisions) and `POST /v1/generate` (short text, or JSON in a shape you define).
- `choice`, `noul` and `score` builders. Answers are typed, including a choice's option ids.
- Images as data URLs, `reasoning` modes and `max_latency_ms`.
- Errors that say what went wrong, retries with backoff and `Retry-After`, timeouts, and cancelling with an `AbortSignal`.
- Logging that never includes the key or the state.
- Refuses to run in a browser, plain `http` outside localhost, and redirects.
