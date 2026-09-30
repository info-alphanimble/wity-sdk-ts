# Wity TypeScript SDK

TypeScript and JavaScript client for [Wity](https://wity.alphanimble.com), the typed-decision API. Send some text and a few questions with fixed options. Get back a probability for every option.

## Install

```sh
npm install wity
```

Needs Node.js 20 or newer. Works with both `import` and `require`:

```js
const { WityClient, choice, noul, score } = require("wity");
```

The SDK has no runtime dependencies.

## Quick start

Set your key in the environment:

```sh
export WITY_API_KEY="wity_..."
```

Then ask questions:

```ts
import { WityClient, choice, noul, score } from "wity";

const client = new WityClient();

const res = await client.systemOne({
  state: "I was charged twice for my subscription this month. Please refund one of them today.",
  questions: {
    team: choice("Which team should handle this ticket?", {
      billing: "Payments, charges and refunds",
      technical: "Bugs, errors and outages",
      other: "Anything else",
    }),
    urgent: noul("Does the customer ask for something to happen soon?", {
      true: "They ask for fast action",
      false: "No time pressure",
    }),
    severity: score("How much is this hurting the customer?", ["Not at all", "A little", "A lot"]),
  },
});

res.answers.team.choice;        // "billing" (typed as "billing" | "technical" | "other")
res.answers.team.probabilities; // { billing: 0.99993..., technical: 0.00003..., other: 0.00003... }
res.answers.urgent.noul;        // 0.99989... = probability of yes
res.answers.severity.score;     // 1.97322... = expected level, from 0 (Not at all) to 2 (A lot)
```

Answers come back under the names you gave the questions. Your editor knows each answer's type, including the option ids of a `choice`.

## Questions

| Builder | Asks | Answer fields |
|---|---|---|
| `choice(instructions, { id: "description", ... })` | Pick one of 2–256 options | `choice`, `probabilities`, `confidence` |
| `noul(instructions, { true: "...", false: "..." })` | Yes or no. The descriptions are optional | `noul` (probability of yes) |
| `score(instructions, ["lowest", ..., "highest"])` | Pick one of 2–10 levels | `score`, `legend`, `probabilities`, `confidence` |

- `state` can be text, or an object or array, which Wity reads as JSON.
- Option ids written as numbers (`{ 1: "Ground" }`) come back as strings (`"1"`), and are typed that way.
- `score` levels can come from a variable, like a list loaded from a database.
- Wity checks the limits (option counts, lengths). If one is broken, it says which in a `BadRequestError`. Failed calls aren't billed.
- Probabilities sum to 1, but they are not calibrated. Treat them as a ranking of how sure the model is, not as exact odds.

## Reasoning

Wity answers most questions in one fast pass, and thinks first only when a question needs it.

```ts
await client.systemOne({ state, questions, reasoning: "off", max_latency_ms: 3000 });
```

- `reasoning`:
  - `"auto"` (the default) thinks only when needed.
  - `"off"` never thinks. It's the fastest.
  - `"always"` thinks before every answer.
- `max_latency_ms` caps the time per request, from 200 to 120000 ms. If thinking was cut short, the answer's `reasoning.budget_limited` is `true`. The SDK waits at least `max_latency_ms` plus 10 s before timing out, even if `timeoutMs` is shorter.
- When Wity thought, the answer has `reasoning.thought: true`. It also carries the answer from before thinking: `direct_probabilities` for choice and score, `direct_noul` for noul.

## Images

Both `systemOne` and `generate` take one image as a data URL:

```ts
await client.systemOne({ state: "Photo of the delivered parcel", questions, image: "data:image/jpeg;base64,..." });
```

## Generate

Choice, noul and score pick from options you wrote in advance. `generate` writes text you couldn't list ahead of time: a value read off a document, a form field, a one-line reply. It returns one piece of text per call, with no probabilities. If the answer is one of a known set, use a question instead.

Free text:

```ts
const reply = await client.generate({
  state: "I was charged twice for my subscription this month. Please refund one of them today.",
  instructions: "Write the one-sentence reply the agent sends to the customer.",
  max_tokens: 80,
});

reply.text; // "Thank you for bringing this to our attention; I've reviewed your account..."
```

JSON in a shape you define. `shape` is a JSON Schema whose top level is an object. It can be written inline or kept in a variable:

```ts
const origin = await client.generate<{ city: string }>({
  state: "Ticket scan: LISBOA (LIS) -> BERLIN BRANDENBURG (BER), 14 Oct, seat 23C.",
  instructions: "Origin city name, in English",
  shape: {
    type: "object",
    properties: { city: { type: "string", pattern: "^[A-Za-z ]{1,40}$" } },
    required: ["city"],
  },
  max_tokens: 40,
});

origin.value?.city; // "Lisbon"
```

- When Wity finishes (`finish_reason: "stop"`), the output matches the shape and comes back parsed in `value`.
- If `finish_reason` is `"length"`, Wity hit `max_tokens` (1 to 512, default 128) before finishing. `text` is cut off and `value` is `null`. Raise the limit, or send the item to a person.
- The type you pass (`<{ city: string }>`) is what TypeScript assumes `value` looks like. It must match your `shape`, because the SDK doesn't check.
- Only input tokens are billed.
- Check generated text before acting on it. It can state things that aren't in `state`.

## Errors

Every error the SDK throws extends `WityError`:

```ts
import { RateLimitError, WityError } from "wity";

try {
  await client.systemOne({ state, questions });
} catch (err) {
  if (err instanceof RateLimitError) {
    // still rate limited after retries
  } else if (err instanceof WityError) {
    console.error(err.message);
  }
}
```

| Error | When |
|---|---|
| `BadRequestError` | 400: the request is wrong. The message says which part. |
| `AuthenticationError` | 401: the key is missing or wrong. |
| `InsufficientBalanceError` | 402: the account has no balance left. |
| `RateLimitError` | 429: too many requests, after retries. |
| `InternalServerError` | 5xx: a problem on Wity's side, after retries. |
| `APIError` | Any other status. All the classes above extend it. It has `status`, `body`, `headers` and `requestId`. |
| `APIConnectionError` | The API couldn't be reached, or the connection broke while reading its answer. |
| `APITimeoutError` | No answer within the timeout. |
| `APIUserAbortError` | You cancelled the call with its `signal`. |
| `WityError` | Anything else: a setup problem like a missing key, a request that can't be sent as JSON, or an answer that isn't from Wity. |

`requestId` is the server's id for the request. Quote it when you report a problem.

**Unknown fields.** A field the SDK doesn't know, like a typo (`max_latency` instead of `max_latency_ms`), is still sent. That way, new API fields work without waiting for an SDK update. The SDK logs a warning that names the field. If Wity rejects the request, the `BadRequestError` names it too.

## Retries, timeouts and cancelling

- 408, 429, 5xx and network failures are retried up to 2 times. The SDK waits longer each time, or as long as the `Retry-After` header asks.
- If `Retry-After` asks for more than 60 s, the SDK throws straight away and leaves the decision to you.
- Timeouts aren't retried. The request may already have reached Wity, and you've already waited the full timeout.
- If the connection breaks while the answer is on its way back, Wity may already have billed the call. The retry is billed again.

```ts
new WityClient({ timeoutMs: 30_000, maxRetries: 0 }); // defaults: 60000 and 2
```

Cancel a call with an `AbortSignal`. This also stops any retries and the waits between them. `AbortSignal.timeout(ms)` caps the total time across all attempts:

```ts
await client.systemOne({ state, questions }, { signal: AbortSignal.timeout(20_000) });
```

## Logging

Logging is off except for warnings, unless you turn it up:

```ts
new WityClient({ logLevel: "debug" }); // or set WITY_LOG_LEVEL=debug
new WityClient({ logLevel: "off" });   // nothing at all
new WityClient({ logger: pino() });    // your own logger: anything with debug/info/warn/error
```

| Level | What you see |
|---|---|
| `"warn"` (the default) | Unknown fields in a request, and a `Retry-After` too long to wait for. Nothing when calls succeed. |
| `"info"` | Also each retry (why, and how long it waits), timeouts, connection errors and cancelled calls. |
| `"debug"` | Also each request: route, attempt, size in bytes, question names, status, time and request id. |
| `"off"` | Nothing. |

Logs never contain your API key (not even part of it) or the `state` text, which is usually customer data. Errors are always thrown to you. Logs only add context, whatever the level.

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `WITY_API_KEY` | required |
| `baseURL` | `WITY_BASE_URL` | `DEFAULT_BASE_URL` (the production API) |
| `timeoutMs` | | `60000` |
| `maxRetries` | | `2` |
| `logLevel` | `WITY_LOG_LEVEL` | `"warn"` |
| `logger` | | the console, with a `[wity]` prefix |
| `fetch` | | the global `fetch` |

An option passed in code wins over the environment variable. An empty `apiKey` is an error. It never falls back to `WITY_API_KEY`, which could belong to a different account. `client.baseURL` shows which address the client uses.

## Security

- Keep the key on your server. Anyone who can see your browser code can read a key inside it.
- `WityClient` refuses to run in a browser page or worker, to catch that mistake early. It is not a protection: by the time the check runs, the key is already in the page. Test setups that imitate a browser, like jsdom, count as a browser too. Run tests that create a `WityClient` in a Node environment.
- Load the key from the environment or a secret manager. Don't write it in code.
- The client never shows the key when it's printed, logged or turned into JSON, and errors never include it.
- `baseURL` must use `https://`. Plain `http://` is allowed only for `localhost`, `127.0.0.1` and `[::1]`.
- The client never follows redirects, so the key only goes to the address you set.
- An answer larger than 10 MB can't be from Wity. The client stops reading it and throws a `WityError`.

## Support

Questions, bugs and security problems: info@alphanimble.com. Please report security problems by email, not in public.

## License

Apache-2.0. See [LICENSE](LICENSE).
