// "Is the automatic process still working on this?" — answered in ONE place.
//
// Lena (closing answer): "I'd want to know clearly when the automatic process stops or fails, so
// Carla and I don't assume it's still running."
//
// Everything here is pure (no Temporal calls, no clock reads), so it can be unit-tested and the API
// can use it for every opening card and for the system-wide banner.
import type { OpeningState } from "./types";

// ---------------------------------------------------------------------------
// Words shown to staff (kept here so the API, the page and the tests agree)
// ---------------------------------------------------------------------------
export const WORKER_DOWN_BANNER =
  "Automatic offers have STOPPED — the background service isn't running. Nothing is being sent or timed out until it's back.";
export const TEMPORAL_DOWN_BANNER =
  "Automatic offers have STOPPED — the dashboard can't reach Temporal, the system that runs them. Nothing is being sent or timed out until it's back.";
/** Second line of the outage banner: what it means for clients, and what staff can do meanwhile. */
export const OUTAGE_ADVICE =
  "Clients who try to reply now are asked to try again or call. If an opening is urgent, text or call clients yourself. Nothing is lost: openings pick up where they left off when it's back (any reply time or hold that ended meanwhile closes straight away).";
export const WORKER_BACK_NOTICE = "Automatic offers are running again";
export const UNEXPECTED_STOP_TEXT =
  "Stopped unexpectedly — automatic offers are no longer running for this opening. Check it in Temporal and contact clients yourself if needed.";
export const WORKER_DOWN_DETAIL = "background service not running";

/** A step that has already failed this many times (i.e. is on attempt ≥ 3) is flagged to staff. */
export const TEXT_FAILURE_MIN_ATTEMPT = 3;
/**
 * A Worker whose newest poll hasn't changed for this long is treated as gone. Idle long-polls refresh
 * about once a minute; the time is measured on the API's own clock, so server clock skew doesn't matter.
 */
export const WORKER_STALE_AFTER_MS = 90_000;
/** The active check (a quick query) must time out this many times in a row before we call the Worker down. */
export const PROBE_FAILURES_FOR_DOWN = 2;
/** DescribeTaskQueue must fail this many times in a row before we say Temporal can't be reached. */
export const DESCRIBE_FAILURES_FOR_DOWN = 2;

// ---------------------------------------------------------------------------
// Errors: "no answer right now" (timeouts, connection) vs a real failure
// ---------------------------------------------------------------------------
/** gRPC status codes that mean "no answer right now", not "this is broken": CANCELLED, DEADLINE_EXCEEDED, UNAVAILABLE. */
const TRANSIENT_GRPC_CODES = new Set([1, 4, 14]);
const TRANSIENT_MESSAGE =
  /DEADLINE_EXCEEDED|deadline exceeded|UNAVAILABLE|ECONNREFUSED|ECONNRESET|timed? ?out|No connection established|no poller seen|worker may be down/i;

/**
 * True when a Temporal call failed only because nothing answered in time or the connection dropped.
 * The SDK wraps these: a query that times out is ServiceError("Failed to query Workflow") with the gRPC
 * DEADLINE_EXCEEDED error as its `cause`, so the whole cause chain is checked, not just the outer message.
 * Once the server has noticed the Worker is gone, it answers queries straight away with FAILED_PRECONDITION
 * "no poller seen for task queue recently, worker may be down": that is "no Worker", too.
 * A QueryFailedError (the Workflow answered with an error) or WorkflowNotFoundError is a real failure.
 */
export function isTransientTemporalError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "QueryFailedError" || name === "WorkflowNotFoundError") return false;
  let e: unknown = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const x = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof x.code === "number" && TRANSIENT_GRPC_CODES.has(x.code)) return true;
    if (typeof x.message === "string" && TRANSIENT_MESSAGE.test(x.message)) return true;
    e = x.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-opening status line
// ---------------------------------------------------------------------------
export type AutomationKind =
  | "running" // the system is working on it by itself
  | "scheduled" // it will carry on by itself later (outside texting hours)
  | "paused" // it will carry on when the background service is back
  | "waiting_for_you" // nothing happens until staff act
  | "stopped" // outreach is over; nothing more will happen unless staff choose
  | "finished" // done: confirmed in Square
  | "unknown" // can't be read right now (no answer in time) — don't assume it's running
  | "texts_failing" // still running, but the text-sending step keeps failing
  | "step_failing" // still running, but another step it waits on keeps failing
  | "stopped_unexpectedly"; // the opening's workflow ended (failed / terminated / timed out) or can't be read

export type AutomationStatus = {
  kind: AutomationKind;
  tone: "info" | "warn" | "neutral" | "ok" | "danger";
  /** Icon name; the words always carry the meaning too. */
  icon: "play" | "pause" | "clock" | "hand" | "stop" | "check" | "alert" | "question";
  /** Bold lead, e.g. "Automatic offers: running". */
  label: string;
  /** The rest of the sentence, e.g. "waiting for replies until 1:02 PM". */
  detail: string;
  /** label + " — " + detail: the one plain line on the card. */
  text: string;
  /** For whoever fixes it (e.g. the last error), shown in smaller type under the line. */
  technical?: string;
  /** Put the card in "Needs you" because of the automation itself (on top of approval / held / unfilled). */
  needsYou: boolean;
  /** The system will still act on this opening by itself (when the background service is running). */
  active: boolean;
};

export type TextFailure = {
  attempt: number;
  lastError?: string;
  /** Activity type; sendOfferTexts (the default) is "texts aren't going out". */
  activity?: string;
};

export type AutomationInput = {
  state?: OpeningState;
  /** Temporal execution status name: RUNNING, COMPLETED, FAILED, TERMINATED, TIMED_OUT, CANCELLED, … */
  executionStatus?: string;
  /** Set when the opening couldn't be read and it's a real failure (not just "no answer in time"). */
  queryError?: string;
  /** The opening couldn't be read only because nothing answered in time (shown as Unknown, not broken). */
  queryTransient?: boolean;
  /** Is a Worker polling the task queue right now? */
  workerOk: boolean;
  /** workerOk is false because Temporal itself can't be reached. */
  temporalUnreachable?: boolean;
  /** A step is being retried (attempt ≥ TEXT_FAILURE_MIN_ATTEMPT). */
  textFailure?: TextFailure;
  /** Staff marked an unexpected stop as handled (epoch ms): it leaves "Needs you". */
  handledAt?: number;
  /** Salon-local clock time, e.g. "1:02 PM". */
  formatTime: (ms: number) => string;
};

/** Temporal ended the workflow itself, not through the opening's own flow. */
export const UNEXPECTED_END_STATUSES = ["FAILED", "TERMINATED", "TIMED_OUT", "CANCELLED"] as const;

function line(
  kind: AutomationKind,
  tone: AutomationStatus["tone"],
  icon: AutomationStatus["icon"],
  label: string,
  detail: string,
  opts: { needsYou?: boolean; active?: boolean; technical?: string } = {},
): AutomationStatus {
  return {
    kind,
    tone,
    icon,
    label,
    detail,
    text: detail ? `${label} — ${detail}` : label,
    ...(opts.technical ? { technical: opts.technical } : {}),
    needsYou: opts.needsYou ?? false,
    active: opts.active ?? false,
  };
}

const RUNNING = "Automatic offers: running";

const unexpected = (handledAt: number | undefined, formatTime: (ms: number) => string) => {
  const [label, ...rest] = UNEXPECTED_STOP_TEXT.split(" — ");
  if (handledAt !== undefined) {
    return line("stopped_unexpectedly", "neutral", "stop", label, `marked as handled at ${formatTime(handledAt)}. Automatic offers aren't running for this opening.`);
  }
  return line("stopped_unexpectedly", "danger", "alert", label, rest.join(" — "), { needsYou: true });
};

/** Quieter than a per-opening failure: the banner at the top explains the outage. */
const workerDown = (temporalUnreachable?: boolean) =>
  line(
    "paused",
    "warn",
    "pause",
    "Paused",
    `${temporalUnreachable ? "can't reach Temporal" : WORKER_DOWN_DETAIL} (see the banner at the top). Nothing is sent or timed out until it's back.`,
    { active: true },
  );

const unknown = () =>
  line("unknown", "warn", "question", "Unknown", "this opening didn't answer in time, so the page can't tell if it's still running. Checking again.");

/** Plain words for a step (Activity) that keeps failing. */
const STEP_WORDS: Record<string, string> = {
  suggestMatches: "Can't check the waitlist for matches",
  textingWindow: "Can't check texting hours",
  reserveForOffers: "Can't reserve people on the waitlist",
  markClientBooked: "Can't mark the client as booked on the waitlist",
  releaseClientBooking: "Can't update the waitlist",
};
/** Steps the opening waits on (a failure here holds everything up). Background notices aren't included. */
export const WATCHED_ACTIVITIES = ["sendOfferTexts", ...Object.keys(STEP_WORDS)];

const failedTimes = (attempt: number) => {
  const n = Math.max(1, attempt - 1);
  return `failed ${n} time${n === 1 ? "" : "s"} so far`;
};

function stepFailing(f: TextFailure): AutomationStatus {
  const err = (f.lastError ?? "unknown").trim().replace(/[.\s]+$/, "");
  const technical = `Last error: ${err}.`;
  if (!f.activity || f.activity === "sendOfferTexts") {
    return line(
      "texts_failing",
      "danger",
      "alert",
      "Texts aren't going out",
      `nobody in this round has been texted yet. It keeps retrying (${failedTimes(f.attempt)}). Text them yourself or cancel the opening.`,
      { needsYou: true, active: true, technical },
    );
  }
  return line(
    "step_failing",
    "danger",
    "alert",
    STEP_WORDS[f.activity] ?? "A step keeps failing",
    `it keeps retrying (${failedTimes(f.attempt)}). Nothing moves forward on this opening until it works. Check it in Temporal.`,
    { needsYou: true, active: true, technical },
  );
}

/** The opening's own flow has finished (it will not do anything else by itself). */
function businessEnd(s: OpeningState): AutomationStatus | undefined {
  if (s.status === "filled" && s.square.done) return line("finished", "ok", "check", "Finished", "confirmed in Square");
  if (s.status === "cancelled") return line("stopped", "neutral", "stop", "Stopped", "cancelled");
  if (s.status === "left_open") return line("stopped", "neutral", "stop", "Stopped", "left open. Nothing more will happen.");
  return undefined;
}

/** The line for an opening that is running normally (the background service is up). */
function runningLine(s: OpeningState, formatTime: (ms: number) => string): AutomationStatus {
  switch (s.status) {
    case "finding_matches":
      return line("running", "info", "play", RUNNING, "checking the waitlist for matches", { active: true });
    case "awaiting_approval":
      return line("waiting_for_you", "warn", "hand", "Waiting for you", "approve who gets texted. Nothing is sent until you do.");
    case "offering": {
      if (s.scheduled) {
        const when = s.scheduled.untilLabel || formatTime(s.scheduled.until);
        return line("scheduled", "info", "clock", "Scheduled", `texts go out at ${when} (outside texting hours)`, { active: true });
      }
      const round = s.currentRound;
      const roundOffers = round ? s.offers.filter((o) => round.offerIds.includes(o.offerId)) : [];
      if (roundOffers.some((o) => o.status === "sending")) return line("running", "info", "play", RUNNING, "sending texts", { active: true });
      if (round?.deadline) {
        return line("running", "info", "play", RUNNING, `waiting for replies until ${formatTime(round.deadline)}`, { active: true });
      }
      return line("running", "info", "play", RUNNING, "getting the next round ready", { active: true });
    }
    case "filled": {
      const until = s.winner?.holdUntil;
      return line(
        "waiting_for_you",
        "warn",
        "hand",
        "Waiting for you",
        `confirm in Square${until ? ` (the hold is released automatically at ${formatTime(until)})` : ""}`,
        { active: true },
      );
    }
    case "unfilled": {
      const why =
        s.unfilledKind === "too_close"
          ? "too close to the start time"
          : s.unfilledKind === "time_passed"
            ? "the appointment time has passed"
            : s.unfilledKind === "no_matches"
              ? "nobody on the waitlist matches"
              : "nobody took it";
      return line("stopped", "neutral", "stop", "Stopped", `${why}. Nothing more will happen until you choose.`);
    }
    default:
      return line("running", "info", "play", RUNNING, "working on it", { active: true });
  }
}

export function automationStatus(input: AutomationInput): AutomationStatus {
  const { state: s, executionStatus, queryError, queryTransient, workerOk, temporalUnreachable, textFailure, handledAt, formatTime } = input;
  const running = executionStatus === undefined || executionStatus === "RUNNING";
  const endedUnexpectedly = !running && UNEXPECTED_END_STATUSES.includes(executionStatus as (typeof UNEXPECTED_END_STATUSES)[number]);

  if (!s) {
    if (endedUnexpectedly) return unexpected(handledAt, formatTime);
    if (running && !workerOk) return workerDown(temporalUnreachable);
    if (running && queryError) return unexpected(handledAt, formatTime); // the Worker is up and this opening answers with an error: it's stuck
    if (running && queryTransient) return unknown();
    if (!running && /nondeterminism/i.test(queryError ?? "")) {
      return line("finished", "neutral", "stop", "Finished", "closed opening from an earlier prototype build");
    }
    if (!running) return line("finished", "neutral", "stop", "Finished", workerOk ? "closed" : "details can't be read while the background service isn't running");
    return line("running", "info", "play", RUNNING, "starting", { active: true });
  }

  const ended = businessEnd(s);
  if (ended) return ended;
  // Not finished by its own flow, yet Temporal no longer runs it (failed, terminated, timed out, …).
  if (!running) return unexpected(handledAt, formatTime);

  const normal = runningLine(s, formatTime);
  if (!workerOk) {
    // Openings that were already waiting on staff (or stopped) keep their own line; nothing can be saved meanwhile.
    if (normal.kind === "stopped" || (normal.kind === "waiting_for_you" && s.status === "awaiting_approval")) {
      return { ...normal, detail: `${normal.detail} (can't be changed until the background service is back)`, text: `${normal.text} (can't be changed until the background service is back)` };
    }
    return workerDown(temporalUnreachable);
  }
  // Showing the last state read, because it didn't answer this time: don't claim it's running.
  if (queryTransient) return unknown();
  if (textFailure && textFailure.attempt >= TEXT_FAILURE_MIN_ATTEMPT) return stepFailing(textFailure);
  return normal;
}

// ---------------------------------------------------------------------------
// Worker health (system-wide), from Temporal's DescribeTaskQueue
// ---------------------------------------------------------------------------
type Seconds = number | string | { toNumber(): number } | null | undefined;
export type PollerLike = {
  identity?: string | null;
  lastAccessTime?: { seconds?: Seconds; nanos?: number | null } | null;
};
export type TaskQueueDescriptionLike = { pollers?: PollerLike[] | null };

/**
 * When the newest poll last CHANGED, on the API's clock. Comparing that (instead of the server's
 * lastAccessTime) with the API's clock makes "stale" immune to clock skew between the two machines.
 */
export type PollTrack = { newest?: number; changedAt?: number };

export function trackPoll(prev: PollTrack | undefined, newest: number | undefined, nowMs: number): PollTrack {
  if (newest === undefined) return prev ?? {};
  if (!prev || prev.newest === undefined) return { newest, changedAt: Math.min(newest, nowMs) };
  if (newest > prev.newest) return { newest, changedAt: nowMs };
  return prev;
}

export type WorkerHealthInput = {
  nowMs: number;
  /** DescribeTaskQueue for the WORKFLOW task-queue type. */
  workflow?: TaskQueueDescriptionLike;
  /** DescribeTaskQueue for the ACTIVITY task-queue type (Activities send the texts). */
  activity?: TaskQueueDescriptionLike;
  /** When the newest poll last changed, per type (API clock). Without it, the server's lastAccessTime is used. */
  workflowTrack?: PollTrack;
  activityTrack?: PollTrack;
  /** DescribeTaskQueue itself failed (Temporal unreachable). */
  describeError?: string;
  /** Consecutive DescribeTaskQueue failures (defaults to 1 when describeError is set). */
  describeFailures?: number;
  /** Consecutive timeouts of the quick "are you answering?" check (a query only a Worker can answer). */
  probeFailures?: number;
  probeError?: string;
  staleAfterMs?: number;
  taskQueue?: string;
};

export type WorkerHealth = {
  /** undefined = not sure yet (one failed check): keep showing what we showed before. */
  workerOk: boolean | undefined;
  /** Temporal itself can't be reached (rather than "no Worker"). */
  temporalUnreachable?: boolean;
  /** Newest poll seen from any Worker (epoch ms), if any. */
  lastPollAt?: number;
  problems: string[];
  /** Worker identities polling recently (one per Worker process). */
  workers: string[];
  /** Not an outage, but worth knowing (e.g. more than one Worker is polling). */
  warnings: string[];
};

export function timestampMs(t: PollerLike["lastAccessTime"]): number | undefined {
  if (!t || t.seconds == null) return undefined;
  const s = typeof t.seconds === "object" ? t.seconds.toNumber() : Number(t.seconds);
  if (!Number.isFinite(s)) return undefined;
  return s * 1000 + Math.round((t.nanos ?? 0) / 1e6);
}

export function newestPoll(d?: TaskQueueDescriptionLike): number | undefined {
  let best: number | undefined;
  for (const p of d?.pollers ?? []) {
    const ms = timestampMs(p.lastAccessTime);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best;
}

const ago = (nowMs: number, ms?: number) => {
  if (ms === undefined) return "never seen";
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  return s < 120 ? `last seen ${s} s ago` : `last seen ${Math.round(s / 60)} min ago`;
};

export function evaluateWorkerHealth(input: WorkerHealthInput): WorkerHealth {
  const { nowMs, staleAfterMs = WORKER_STALE_AFTER_MS, taskQueue = "juniper-salon" } = input;
  if (input.describeError) {
    const failures = input.describeFailures ?? 1;
    if (failures < DESCRIBE_FAILURES_FOR_DOWN) return { workerOk: undefined, problems: [], workers: [], warnings: [] };
    return {
      workerOk: false,
      temporalUnreachable: true,
      problems: [`Can't reach Temporal to check the background service (${failures} checks in a row): ${input.describeError}`],
      workers: [],
      warnings: [],
    };
  }
  const wf = input.workflowTrack?.changedAt ?? newestPoll(input.workflow);
  const act = input.activityTrack?.changedAt ?? newestPoll(input.activity);
  const fresh = (ms?: number) => ms !== undefined && nowMs - ms <= staleAfterMs;
  const problems: string[] = [];
  if (!fresh(wf)) problems.push(`No Worker is picking up workflow tasks on the “${taskQueue}” task queue (${ago(nowMs, wf)}).`);
  if (!fresh(act)) problems.push(`No Worker is picking up activity tasks on “${taskQueue}”, so no texts can be sent (${ago(nowMs, act)}).`);
  if ((input.probeFailures ?? 0) >= PROBE_FAILURES_FOR_DOWN) {
    problems.push(
      `The background service didn't answer ${input.probeFailures} checks in a row${input.probeError ? ` (${input.probeError})` : ""}.`,
    );
  }
  // Who is polling (by the server's own lastAccessTime, relative to the newest poll, so skew doesn't matter).
  const all = [...(input.workflow?.pollers ?? []), ...(input.activity?.pollers ?? [])];
  const newest = Math.max(newestPoll(input.workflow) ?? 0, newestPoll(input.activity) ?? 0);
  const workers = [
    ...new Set(
      all
        .filter((p) => p.identity && newest - (timestampMs(p.lastAccessTime) ?? 0) <= staleAfterMs)
        .map((p) => String(p.identity)),
    ),
  ].sort();
  const warnings =
    workers.length > 1
      ? [
          `${workers.length} Workers are polling “${taskQueue}” (${workers.join(", ")}). Just after a restart this clears by itself within about a minute and a half. Otherwise, if one is from an old copy of the app, stop it: it runs openings on old code, and while it polls this page can't tell when the other one stops.`,
        ]
      : [];
  const polls = [newestPoll(input.workflow), newestPoll(input.activity)].filter((x): x is number => x !== undefined);
  return { workerOk: problems.length === 0, lastPollAt: polls.length ? Math.max(...polls) : undefined, problems, workers, warnings };
}

// ---------------------------------------------------------------------------
// Steps that keep failing, from the workflow's pending Activities (handle.describe())
// ---------------------------------------------------------------------------
export type PendingActivityLike = {
  activityType?: { name?: string | null } | null;
  attempt?: number | null;
  lastFailure?: { message?: string | null; cause?: { message?: string | null } | null } | null;
};

/**
 * The worst pending step the opening waits on that is on attempt ≥ minAttempt (texts first when tied).
 * Background notices (notifyStaff, notifyTimedOut, …) are ignored: they don't hold the opening up.
 */
export function textFailureFromPending(
  pending: PendingActivityLike[] | null | undefined,
  minAttempt = TEXT_FAILURE_MIN_ATTEMPT,
  activities: readonly string[] = WATCHED_ACTIVITIES,
): TextFailure | undefined {
  let worst: TextFailure | undefined;
  for (const a of pending ?? []) {
    const activity = a.activityType?.name ?? "";
    if (!activities.includes(activity)) continue;
    const attempt = a.attempt ?? 0;
    if (attempt < minAttempt) continue;
    // Texts outrank other steps; then the higher attempt wins.
    const isText = (name?: string) => (name === "sendOfferTexts" ? 1 : 0);
    if (worst && (isText(worst.activity) > isText(activity) || (isText(worst.activity) === isText(activity) && worst.attempt >= attempt))) continue;
    const lastError = a.lastFailure?.message || a.lastFailure?.cause?.message || undefined;
    worst = { attempt, lastError: lastError ?? undefined, activity };
  }
  return worst;
}
