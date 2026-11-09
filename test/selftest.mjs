/**
 * Self-test for @local/dsh-failure-classifier.
 *
 * Runs with plain `node test/selftest.mjs` — no harness, no network, no writes
 * outside a temporary directory. Covers every known failure code, the
 * RATE_LIMIT threshold boundary, unknown/missing fields, override handling, and
 * the pass-through contract of the waterfall listener.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Config,
  EVENT_TYPE,
  apply,
  buildEventData,
  classify,
  formatLogLine,
  normalizeOverrides,
  resolveJournalDir,
  name,
  inject,
} from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

const kindOf = (failure, overrides) => classify(failure, overrides).kind;

console.log("-- plugin shape --");
check("exports plugin name", () => assert.equal(name, "failure-classifier"));
check("declares inject list", () => assert.deepEqual(inject, ["agents"]));
check("event type constant", () => assert.equal(EVENT_TYPE, "llm/failure-classified"));
check("exposes apply()", () => assert.equal(typeof apply, "function"));
check("Config is a schema or intentionally absent", () => {
  assert.ok(Config === undefined || typeof Config === "object");
});

console.log("-- retry: transient jitter --");
check("TRANSPORT -> retry", () => assert.equal(kindOf({ code: "TRANSPORT", message: "terminated" }), "retry"));
check("TIMEOUT -> retry", () => assert.equal(kindOf({ code: "TIMEOUT", message: "timeout" }), "retry"));
check("SERVER -> retry", () => assert.equal(kindOf({ code: "SERVER", status: 503, message: "upstream" }), "retry"));
check("EMPTY_RESPONSE -> retry", () => assert.equal(kindOf({ code: "EMPTY_RESPONSE", message: "" }), "retry"));
check("RATE_LIMIT without Retry-After -> retry", () => assert.equal(kindOf({ code: "RATE_LIMIT", status: 429, message: "slow down" }), "retry"));

console.log("-- pause: human timescale --");
check("RATE_LIMIT with Retry-After 5s -> retry", () => assert.equal(kindOf({ code: "RATE_LIMIT", providerRetryAfterMs: 5_000, message: "x" }), "retry"));
check("RATE_LIMIT with Retry-After exactly 60s -> retry (boundary)", () => assert.equal(kindOf({ code: "RATE_LIMIT", providerRetryAfterMs: 60_000, message: "x" }), "retry"));
check("RATE_LIMIT with Retry-After 61s -> pause", () => assert.equal(kindOf({ code: "RATE_LIMIT", providerRetryAfterMs: 61_000, message: "x" }), "pause"));
check("QUOTA -> pause", () => assert.equal(kindOf({ code: "QUOTA", message: "额度不足" }), "pause"));
check("ACCOUNT_QUOTA -> pause", () => assert.equal(kindOf({ code: "ACCOUNT_QUOTA", status: 402, message: "quota" }), "pause"));

console.log("-- stop: deterministic --");
check("CONTEXT_WINDOW_EXCEEDED -> stop", () => assert.equal(kindOf({ code: "CONTEXT_WINDOW_EXCEEDED", message: "too long" }), "stop"));
check("INVALID_CREDENTIAL -> stop", () => assert.equal(kindOf({ code: "INVALID_CREDENTIAL", status: 401, message: "bad key" }), "stop"));
check("IMAGE_OFFLOAD_REQUIRED -> stop", () => assert.equal(kindOf({ code: "IMAGE_OFFLOAD_REQUIRED", message: "offload" }), "stop"));
check("unknown code -> stop and code preserved", () => {
  const result = classify({ code: "SOMETHING_NEW", status: 418, message: "???" });
  assert.equal(result.kind, "stop");
  assert.equal(result.code, "SOMETHING_NEW");
  assert.equal(result.status, 418);
});

console.log("-- missing / malformed fields --");
check("missing code -> stop with UNKNOWN", () => {
  const result = classify({ message: "no code" });
  assert.equal(result.kind, "stop");
  assert.equal(result.code, "UNKNOWN");
});
check("empty failure object -> stop", () => assert.equal(classify({}).kind, "stop"));
check("null failure -> stop", () => assert.equal(classify(null).kind, "stop"));
check("missing message -> empty messageHead", () => assert.equal(classify({ code: "TIMEOUT" }).messageHead, ""));
check("500-char message truncated to 200", () => {
  const head = classify({ code: "SERVER", message: "x".repeat(500) }).messageHead;
  assert.equal(head.length, 200);
});
check("multi-line message collapsed to one line", () => {
  const head = classify({ code: "SERVER", message: "line1\nline2\tline3" }).messageHead;
  assert.equal(head, "line1 line2 line3");
});
check("non-numeric status omitted", () => {
  assert.equal(Object.hasOwn(classify({ code: "SERVER", status: "503" }), "status"), false);
});
check("non-finite Retry-After ignored", () => {
  assert.equal(Object.hasOwn(classify({ code: "RATE_LIMIT", providerRetryAfterMs: Number.NaN }), "providerRetryAfterMs"), false);
  assert.equal(kindOf({ code: "RATE_LIMIT", providerRetryAfterMs: Number.POSITIVE_INFINITY }), "retry");
});

console.log("-- overrides --");
check("override TRANSPORT -> pause", () => assert.equal(kindOf({ code: "TRANSPORT", message: "x" }, { TRANSPORT: "pause" }), "pause"));
check("override unknown code -> retry", () => assert.equal(kindOf({ code: "WEIRD", message: "x" }, { WEIRD: "retry" }), "retry"));
check("invalid override value ignored", () => assert.equal(kindOf({ code: "TRANSPORT", message: "x" }, { TRANSPORT: "maybe" }), "retry"));
check("override beats the RATE_LIMIT Retry-After promotion", () => {
  assert.equal(kindOf({ code: "RATE_LIMIT", providerRetryAfterMs: 300_000, message: "x" }, { RATE_LIMIT: "stop" }), "stop");
});
check("normalizeOverrides reports rejects", () => {
  const { overrides, rejected } = normalizeOverrides({ TRANSPORT: "pause", QUOTA: 7 });
  assert.deepEqual(overrides, { TRANSPORT: "pause" });
  assert.deepEqual(rejected, ["QUOTA=7"]);
});

console.log("-- event payload --");
check("buildEventData drops absent keys and stays JSON-safe", () => {
  const data = buildEventData(
    classify({ code: "RATE_LIMIT", message: "slow", providerRetryAfterMs: 90_000 }),
    { turn: 3, step: 2, provider: "deepseek-official" },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(data)), {
    kind: "pause",
    code: "RATE_LIMIT",
    messageHead: "slow",
    providerRetryAfterMs: 90_000,
    turn: 3,
    step: 2,
    provider: "deepseek-official",
  });
  assert.equal(Object.hasOwn(data, "status"), false);
});
check("buildEventData tolerates a bare payload", () => {
  const data = buildEventData(classify({ code: "TIMEOUT" }), undefined);
  assert.equal(Object.hasOwn(data, "turn"), false);
  assert.equal(Object.hasOwn(data, "provider"), false);
});
check("log line format", () => {
  const line = formatLogLine(classify({ code: "QUOTA", message: "x" }), { turn: 1, step: 2, provider: "p" });
  assert.equal(line, "failure-classifier: pause code=QUOTA provider=p turn/step=1/2");
});
check("journal dir honours explicit config", () => {
  assert.equal(resolveJournalDir("  /tmp/x  "), "/tmp/x");
});
check("journal dir falls back to a logs subdirectory", () => {
  assert.match(resolveJournalDir(""), /failure-classifier$/);
});

console.log("-- waterfall pass-through (fake ctx) --");

function fakeCtx() {
  const listeners = new Map();
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };
  return { ctx, listeners, logs };
}

await checkAsync("returns the downstream decision unchanged", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "failure-classifier-"));
  try {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { overrides: {}, sessionEvent: "never", journal: { enabled: true, dir } });
    const listener = listeners.get("agent/request-error");
    assert.equal(typeof listener, "function", "listener registered");
    const sentinel = { kind: "retry" };
    let calls = 0;
    const result = await listener(
      { agent: undefined, turn: 4, step: 5, provider: "prov", failure: { code: "TRANSPORT", message: "boom" }, retryPolicy: undefined },
      async () => { calls += 1; return sentinel; },
    );
    assert.equal(calls, 1, "next() called exactly once");
    assert.equal(result, sentinel, "downstream decision passed through by identity");
    const file = path.join(dir, `classified-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`);
    const journal = await readFile(file, "utf8");
    const record = JSON.parse(journal.trim());
    assert.equal(record.kind, "retry");
    assert.equal(record.code, "TRANSPORT");
    assert.equal(record.turn, 4);
    assert.equal(record.step, 5);
    assert.equal(record.provider, "prov");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await checkAsync("rethrows the downstream error unchanged, after recording", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "failure-classifier-"));
  try {
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { sessionEvent: "never", journal: { enabled: true, dir } });
    const listener = listeners.get("agent/request-error");
    const original = new Error("downstream exploded");
    await assert.rejects(
      listener(
        { turn: 1, step: 1, provider: "prov", failure: { code: "SERVER", message: "x" } },
        async () => { throw original; },
      ),
      (error) => error === original,
    );
    const file = path.join(dir, `classified-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`);
    const record = JSON.parse((await readFile(file, "utf8")).trim());
    assert.equal(record.downstreamFailed, true, "failure still recorded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await checkAsync("a broken journal never blocks the decision", async () => {
  const { ctx, listeners } = fakeCtx();
  // A path under a file (not a directory) makes mkdir fail deterministically.
  apply(ctx, { sessionEvent: "never", journal: { enabled: true, dir: path.join(HERE, "..", "package.json", "nope") } });
  const listener = listeners.get("agent/request-error");
  const result = await listener(
    { turn: 1, step: 1, provider: "prov", failure: { code: "QUOTA", message: "x" } },
    async () => ({ kind: "retry" }),
  );
  assert.deepEqual(result, { kind: "retry" });
});

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} assertion(s) failed, ${passed} passed`);
  for (const { label, error } of failures) console.error(` - ${label}: ${error.message}`);
  process.exit(1);
}
console.log(`all ${passed} assertions passed`);
