import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import type { Logger } from "../src/index";

/** A made-up key. Tests check that it never leaks into errors or logs. */
export const TEST_KEY = "wity_test_secret_1234567890";

/** A real API response saved by scripts/capture-fixtures.mjs. */
export const fixture = (name: string): { status: number; body: unknown } =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number }
  | Error
  /** Never answer, so the request times out. */
  | "hang"
  /** Send the headers, then stop halfway through the body. */
  | "stall-body"
  /** Send the headers, then break the connection while the body is read. */
  | "broken-body";

const aborted = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * A fake `fetch` that gives the replies in order (the last one repeats)
 * and records every call so tests can check what was sent.
 */
export const fakeFetch = (...replies: Reply[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply === undefined) throw new Error("fakeFetch needs at least one reply");
    if (reply instanceof Error) throw reply;
    if (reply === "hang") return aborted(init.signal);
    if (reply === "stall-body" || reply === "broken-body") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model": "wity-1", "ans'));
          if (reply === "broken-body") controller.error(new TypeError("terminated"));
          // Like real fetch: aborting the request also stops reading its body.
          else aborted(init.signal).catch((reason) => controller.error(reason));
        },
      });
      return new Response(body, { status: 200 });
    }
    if (reply.delayMs) await Promise.race([new Promise((r) => setTimeout(r, reply.delayMs)), aborted(init.signal)]);
    const text =
      reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: reply.headers });
  };
  return { fetch, calls };
};

/** The JSON body a recorded call sent. */
export const sentBody = (call: { init: RequestInit } | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init.body));

/** A logger that keeps every message, so tests can read what was logged. */
export const recordingLogger = () => {
  const lines: { level: keyof Logger; text: string }[] = [];
  const at =
    (level: keyof Logger) =>
    (message: string, ...args: unknown[]) =>
      lines.push({ level, text: [message, ...args.map((arg) => inspect(arg, { depth: 10 }))].join(" ") });
  const logger: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { logger, lines, all: () => lines.map((line) => line.text).join("\n") };
};
