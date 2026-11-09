/**
 * @local/dsh-failure-classifier
 *
 * Observe the agent loop's `agent/request-error` waterfall and classify every
 * model-request failure into one of three shapes:
 *
 *   retry -> transient jitter, a short wait usually helps
 *   pause -> self-healing but on a human timescale (quota / account quota /
 *            rate limited with a long provider Retry-After)
 *   stop  -> deterministic failure, retrying cannot help
 *
 * PHASE 1 IS OBSERVATION ONLY. We await `next()` exactly once, hand its return
 * value back untouched (no rewriting of the downstream retry decision), and we
 * never throw out of the observation path. See CONTRACT.md for why the session
 * event is gated instead of being written unconditionally.
 */

import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Plugin identity. */
export const name = "failure-classifier";

/**
 * `agents` is declared so the Loader mounts us after the agent service exists,
 * matching the shipped `llm-retry` listener we sit downstream of.
 */
export const inject = ["agents"];

/** Session event type written for each classification. */
export const EVENT_TYPE = "llm/failure-classified";

/** Code used when the failure carries no usable `code` string. */
export const UNKNOWN_CODE = "UNKNOWN";

/** `messageHead` is truncated so a huge provider payload cannot bloat a log. */
export const MESSAGE_HEAD_LIMIT = 200;

/** A RATE_LIMIT whose provider Retry-After exceeds this is a `pause`, not a `retry`. */
export const PAUSE_RETRY_AFTER_MS = 60_000;

/** The three classification kinds. */
export const KINDS = Object.freeze(["retry", "pause", "stop"]);

const KIND_SET = new Set(KINDS);

/**
 * Built-in classification table. Every code that is not listed here is a
 * `stop` (deterministic by default: an unknown failure is not worth retrying).
 */
export const DEFAULT_MAP = Object.freeze({
  // transient
  TRANSPORT: "retry",
  TIMEOUT: "retry",
  SERVER: "retry",
  EMPTY_RESPONSE: "retry",
  RATE_LIMIT: "retry", // promoted to "pause" by a long Retry-After, see classify()
  // self-healing on a human timescale
  QUOTA: "pause",
  ACCOUNT_QUOTA: "pause",
  // deterministic
  CONTEXT_WINDOW_EXCEEDED: "stop",
  INVALID_CREDENTIAL: "stop",
  IMAGE_OFFLOAD_REQUIRED: "stop",
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The schema library is imported lazily: this module must stay importable from a
// bare checkout (tests, `node -e import(...)`) where no @deepseek-ai/* package
// resolves. Without the schema the Loader simply skips validation, and every
// default below is re-applied defensively in apply().
let z;
try {
  z = (await import("@deepseek-ai/schemastery")).default;
} catch {
  z = undefined;
}

/** Runtime schema for the plugin Config; `undefined` when schemastery is absent. */
export const Config = z === undefined
  ? undefined
  : z.object({
    /** Per-code overrides; values are "retry" | "pause" | "stop". */
    overrides: z.dict(z.string()).default({}),
    /** "auto" writes the session event only when the vocabulary knows it. */
    sessionEvent: z.union([z.const("auto"), z.const("always"), z.const("never")]).default("auto"),
    /** Durable JSONL observation journal (phase 1 primary sink). */
    journal: z.object({
      enabled: z.boolean().default(true),
      /** Empty = resolve from $DSH_HOME, else ~/.dsh. */
      dir: z.string().default(""),
    }),
  });

// ---------------------------------------------------------------------------
// Pure classification core (unit-testable without a harness)
// ---------------------------------------------------------------------------

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Collapse whitespace and truncate, so a multi-line provider error stays one line. */
function normalizeMessage(message) {
  if (typeof message !== "string") return "";
  return message.replace(/\s+/g, " ").trim().slice(0, MESSAGE_HEAD_LIMIT);
}

function pickKind(code, providerRetryAfterMs, overrides) {
  const override = overrides?.[code];
  if (typeof override === "string" && KIND_SET.has(override)) return override;
  const base = DEFAULT_MAP[code];
  if (base === undefined) return "stop";
  if (
    code === "RATE_LIMIT"
    && providerRetryAfterMs !== undefined
    && providerRetryAfterMs > PAUSE_RETRY_AFTER_MS
  ) {
    return "pause";
  }
  return base;
}

/**
 * Classify one `LlmFailure` into the three-state model.
 * @param failure - the `failure` field of the `agent/request-error` payload.
 * @param overrides - per-code kind overrides; invalid values are ignored here
 *   (apply() warns about them once at mount time).
 * @returns classification fields, with absent inputs omitted rather than set to
 *   `undefined` (a session append rejects non-JSON-serializable data).
 */
export function classify(failure, overrides = {}) {
  const raw = failure ?? {};
  const code = typeof raw.code === "string" && raw.code.trim().length > 0
    ? raw.code.trim()
    : UNKNOWN_CODE;
  const providerRetryAfterMs = positiveNumber(raw.providerRetryAfterMs);
  const status = Number.isInteger(raw.status) ? raw.status : undefined;
  return {
    kind: pickKind(code, providerRetryAfterMs, overrides),
    code,
    ...(status === undefined ? {} : { status }),
    messageHead: normalizeMessage(raw.message),
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  };
}

/**
 * Build the session-event / journal payload from a classification plus the
 * waterfall payload. Keys whose source value is absent are omitted on purpose.
 */
export function buildEventData(classification, payload = {}) {
  const { kind, code, status, messageHead, providerRetryAfterMs } = classification;
  const turn = Number.isInteger(payload.turn) ? payload.turn : undefined;
  const step = Number.isInteger(payload.step) ? payload.step : undefined;
  const provider = typeof payload.provider === "string" && payload.provider.length > 0
    ? payload.provider
    : undefined;
  return {
    kind,
    code,
    ...(status === undefined ? {} : { status }),
    messageHead,
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    ...(provider === undefined ? {} : { provider }),
  };
}

/** One log line per classification, stable enough to grep in host logs. */
export function formatLogLine(classification, payload = {}) {
  const provider = typeof payload.provider === "string" && payload.provider.length > 0
    ? payload.provider
    : "unknown";
  const turn = Number.isInteger(payload.turn) ? payload.turn : "?";
  const step = Number.isInteger(payload.step) ? payload.step : "?";
  return `failure-classifier: ${classification.kind} code=${classification.code} provider=${provider} turn/step=${turn}/${step}`;
}

/** Keep only recognized kind strings; report anything else to the caller. */
export function normalizeOverrides(input) {
  const overrides = {};
  const rejected = [];
  if (input === undefined || input === null) return { overrides, rejected };
  if (typeof input !== "object" || Array.isArray(input)) {
    rejected.push(String(input));
    return { overrides, rejected };
  }
  for (const [code, kind] of Object.entries(input)) {
    if (typeof kind === "string" && KIND_SET.has(kind)) overrides[code] = kind;
    else rejected.push(`${code}=${String(kind)}`);
  }
  return { overrides, rejected };
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

function dayStamp(iso) {
  return String(iso).slice(0, 10).replace(/-/g, "");
}

/** Resolve the journal directory: explicit config, then $DSH_HOME, then ~/.dsh. */
export function resolveJournalDir(configured) {
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  const home = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR;
  if (typeof home === "string" && home.trim().length > 0) {
    return path.join(home.trim(), "logs", "failure-classifier");
  }
  return path.join(os.homedir(), ".dsh", "logs", "failure-classifier");
}

/**
 * Append-only JSONL journal. Writes are serialized through one promise chain so
 * concurrent failures cannot interleave partial lines, and the first failure
 * disables the sink instead of retrying forever.
 *
 * The returned promise never rejects: a broken journal must not surface in the
 * request-error path. Callers await it only so tests (and the next step) can see
 * a durable record.
 */
function createJournal(dir, logger) {
  let queue = Promise.resolve();
  let ready;
  let broken = false;
  return function writeJournal(record) {
    if (broken) return queue;
    const line = `${JSON.stringify(record)}\n`;
    const file = path.join(dir, `classified-${dayStamp(record.time)}.jsonl`);
    queue = queue.then(async () => {
      if (broken) return;
      try {
        ready ??= mkdir(dir, { recursive: true });
        await ready;
        await appendFile(file, line, "utf8");
      } catch (error) {
        broken = true;
        logger.warn(`failure-classifier: journal write failed, journal disabled: ${String(error)}`);
      }
    });
    return queue;
  };
}

/**
 * Ask the installed session package whether it knows our event type.
 *
 * `session.append()` writes an event with no `ignorable` marker, and both the
 * persistence reader and the V4 restore path refuse a log that carries an
 * unknown, non-ignorable event type. So "auto" only writes the session event
 * when the current build lists the type in KNOWN_SESSION_EVENT_TYPES.
 */
async function probeSessionVocabulary(logger) {
  try {
    const mod = await import("@deepseek-ai/dsh-session");
    const known = mod?.KNOWN_SESSION_EVENT_TYPES;
    if (known instanceof Set && known.has(EVENT_TYPE)) return true;
    logger.info(
      `failure-classifier: "${EVENT_TYPE}" is absent from this build's session-event vocabulary; `
      + "writing the JSONL journal only (see CONTRACT.md 4)",
    );
    return false;
  } catch (error) {
    logger.info(
      `failure-classifier: session vocabulary probe unavailable (${String(error)}); `
      + "writing the JSONL journal only",
    );
    return false;
  }
}

function createSessionSink(mode, logger) {
  let allowed;
  let broken = false;
  return async function writeSessionEvent(agent, data) {
    if (broken || mode === "never") return;
    if (mode === "always") {
      allowed ??= true;
    } else {
      allowed ??= probeSessionVocabulary(logger);
      if (!(await allowed)) return;
    }
    const session = agent?.session;
    if (session === undefined || typeof session.append !== "function") {
      broken = true;
      logger.warn("failure-classifier: agent.session.append unavailable; session events disabled");
      return;
    }
    try {
      session.append(EVENT_TYPE, data);
    } catch (error) {
      broken = true;
      logger.warn(
        `failure-classifier: session append refused, disabled for this process: ${String(error)}`,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Mount the observer.
 * @param ctx - the Cordis context.
 * @param config - validated Config (defensive defaults are re-applied here).
 */
export function apply(ctx, config = {}) {
  const { overrides, rejected } = normalizeOverrides(config.overrides);
  if (rejected.length > 0) {
    ctx.logger.warn(
      `failure-classifier: ignoring invalid overrides (${rejected.join(", ")}); `
      + `expected one of ${KINDS.join("/")}`,
    );
  }

  const journalCfg = config.journal ?? {};
  const journalEnabled = journalCfg.enabled !== false;
  const journalDir = resolveJournalDir(journalCfg.dir);
  if (journalEnabled) ctx.logger.info(`failure-classifier: journal -> ${journalDir}`);
  const journal = journalEnabled ? createJournal(journalDir, ctx.logger) : undefined;

  const sessionMode = config.sessionEvent === "always" || config.sessionEvent === "never"
    ? config.sessionEvent
    : "auto";
  const writeSessionEvent = createSessionSink(sessionMode, ctx.logger);

  async function record(payload, downstreamFailed) {
    const classification = classify(payload?.failure, overrides);
    const data = buildEventData(classification, payload ?? {});
    ctx.logger.info(formatLogLine(classification, payload ?? {}));
    await writeSessionEvent(payload?.agent, data);
    await journal?.({
      time: new Date().toISOString(),
      ...data,
      ...(downstreamFailed ? { downstreamFailed: true } : {}),
    });
  }

  const dispose = ctx.on("agent/request-error", (payload, next) => {
    // Downstream first: our return value must be exactly the downstream one.
    let failed = false;
    let downstreamError;
    return (async () => {
      let decision;
      try {
        decision = await next();
      } catch (error) {
        failed = true;
        downstreamError = error;
      }
      // Observation can never affect the request outcome.
      try {
        await record(payload, failed);
      } catch (error) {
        ctx.logger.warn(`failure-classifier: observation failed: ${String(error)}`);
      }
      if (failed) throw downstreamError;
      return decision;
    })();
  });

  ctx.effect(() => async () => {
    dispose();
  }, "failure-classifier: dispose request-error listener");
}

export default apply;
