// Calls the real Wity API and saves each response body to test/fixtures/.
// The tests replay these files, so they run offline and cost nothing.
//
// Run from the repo root:
//   node --env-file-if-exists=.env scripts/capture-fixtures.mjs
//
// Successful calls cost a tiny amount. Failed calls are free.
// Only status and body are saved. Headers and the key are never written.

import { mkdirSync, writeFileSync } from "node:fs";

const key = process.env.WITY_API_KEY;
const baseURL = process.env.WITY_BASE_URL?.replace(/\/+$/, "");
if (!key || !baseURL) {
  console.error("Set WITY_API_KEY and WITY_BASE_URL (for example with --env-file).");
  process.exit(1);
}
if (!baseURL.startsWith("https://")) {
  console.error("WITY_BASE_URL must start with https://");
  process.exit(1);
}

const ticket = "I was charged twice for my subscription this month. Please refund one of them today.";

const team = {
  type: "choice",
  instructions: "Which team should handle this ticket?",
  criteria: {
    billing: "Payments, charges and refunds",
    technical: "Bugs, errors and outages",
    other: "Anything else",
  },
};
const urgent = {
  type: "noul",
  instructions: "Does the customer ask for something to happen soon?",
  criteria: { true: "They ask for fast action", false: "No time pressure" },
};
const severity = {
  type: "score",
  instructions: "How much is this hurting the customer?",
  criteria: ["Not at all", "A little", "A lot"],
};

const flight = "Ticket scan: LISBOA (LIS) -> BERLIN BRANDENBURG (BER), 14 Oct, seat 23C.";
const cityShape = {
  type: "object",
  properties: { city: { type: "string", pattern: "^[A-Za-z ]{1,40}$" } },
  required: ["city"],
};

const calls = [
  // Successful calls, one per question type.
  { name: "choice", body: { state: ticket, questions: { team }, reasoning: "off" } },
  // Thinking yes/no and score questions, to capture direct_noul and a score's direct_probabilities.
  { name: "noul-always", body: { state: ticket, questions: { urgent }, reasoning: "always" } },
  { name: "score-always", body: { state: ticket, questions: { severity }, reasoning: "always" } },
  { name: "noul", body: { state: ticket, questions: { urgent }, reasoning: "off" } },
  { name: "score", body: { state: ticket, questions: { severity }, reasoning: "off" } },
  // Forces thinking, to capture the full reasoning object.
  { name: "reasoning-always", body: { state: ticket, questions: { team }, reasoning: "always" } },
  // All three types in one request, with the public default (auto).
  { name: "multi-auto", body: { state: ticket, questions: { team, urgent, severity } } },
  // Error calls. These are free.
  { name: "error-bad-key", body: { state: ticket, questions: { team } }, key: "wity_not_a_real_key" },
  { name: "error-unknown-field", body: { state: ticket, questions: { team }, user: "someone" } },
  {
    name: "error-object-instructions",
    body: { state: ticket, questions: { team: { ...team, instructions: { text: "Which team?" } } } },
  },
  {
    name: "error-one-score-level",
    body: { state: ticket, questions: { severity: { ...severity, criteria: ["Only one"] } } },
  },
  // Generate: free text, JSON in a shape, and a shape cut off by max_tokens.
  {
    name: "generate-text",
    path: "/v1/generate",
    body: { state: ticket, instructions: "Write the one-sentence reply the agent sends to the customer.", max_tokens: 80 },
  },
  {
    name: "generate-shape",
    path: "/v1/generate",
    body: { state: flight, instructions: "Origin city name, in English", shape: cityShape, max_tokens: 40 },
  },
  {
    name: "generate-cut-off",
    path: "/v1/generate",
    body: { state: flight, instructions: "Origin city name, in English", shape: cityShape, max_tokens: 2 },
  },
  {
    name: "error-generate-unknown-field",
    path: "/v1/generate",
    body: { state: flight, instructions: "Origin city", user: "someone" },
  },
];

// Pass names to capture only those, for example: npm run fixtures -- generate-text
const only = process.argv.slice(2);
const unknown = only.filter((name) => !calls.some((call) => call.name === name));
if (unknown.length > 0) {
  console.error(`Unknown fixture names: ${unknown.join(", ")}`);
  process.exit(1);
}
const selected = only.length > 0 ? calls.filter((call) => only.includes(call.name)) : calls;

const outDir = new URL("../test/fixtures/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const call of selected) {
  const started = Date.now();
  const res = await fetch(`${baseURL}${call.path ?? "/v1/systemone"}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${call.key ?? key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(call.body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  const saved = JSON.stringify({ status: res.status, body }, null, 2);
  // Never write the key to disk, even if the server echoed it back.
  if (saved.includes(key)) {
    console.error(`${call.name}: response contains the API key. Not saved.`);
    process.exit(1);
  }
  writeFileSync(new URL(`${call.name}.json`, outDir), `${saved}\n`);

  // Header names only, to learn what the API sends (for example a request id).
  const headerNames = [...res.headers.keys()].join(", ");
  console.log(`${call.name}: ${res.status} in ${Date.now() - started} ms`);
  console.log(`  headers: ${headerNames}`);
}
