// System-wide health for the staff dashboard: is a Worker (the "background service") running?
//
// Two signals, both from Temporal:
//  1. DescribeTaskQueue (WORKFLOW and ACTIVITY types): which Workers poll "juniper-salon", and when the
//     newest poll last changed (measured on this API's clock, so server clock skew doesn't matter).
//     An idle Worker re-polls about once a minute, so this alone can take ~90 s to notice.
//  2. A quick query to the always-running waitlist Workflow, which only a Worker can answer. It answers
//     in milliseconds when a Worker is up and times out when none is, so an outage shows in ~10–15 s.
//     Only "no answer in time" counts against it: an error answer still proves a Worker is there.
//
// Hysteresis, so one slow check doesn't flip the page: 2 failed checks in a row to call it down,
// 2 good checks in a row to call it back. The banner shows straight away; the (simulated) alert texts to
// Lena and Carla go out once an outage has lasted ALERT_AFTER_MS, once per outage.
import { WorkflowNotFoundError, type Client } from "@temporalio/client";
import {
  evaluateWorkerHealth,
  isTransientTemporalError,
  newestPoll,
  OUTAGE_ADVICE,
  TEMPORAL_DOWN_BANNER,
  trackPoll,
  WORKER_BACK_NOTICE,
  WORKER_DOWN_BANNER,
  type PollTrack,
  type TaskQueueDescriptionLike,
} from "./automation";
import { getWaitlist, TASK_QUEUE, WAITLIST_WORKFLOW_ID } from "./messages";
import { STAFF_ALERT_RECIPIENTS } from "./rules";
import { listNames } from "./format";
import { ensureWaitlist, NAMESPACE } from "./temporal";

const SIMULATED = "[SIMULATED TEXT — NOT SENT]";
const CHECK_EVERY_MS = Number(process.env.HEALTH_CHECK_MS ?? 5_000);
const PROBE_DEADLINE_MS = 4_000;
const MAX_ALERTS = 20;
/** Good checks in a row before an outage is declared over (avoids flapping). */
const GOOD_CHECKS_TO_RECOVER = 2;
/** Text Lena and Carla once an outage has lasted this long (the banner shows straight away). */
const ALERT_AFTER_MS = Number(process.env.HEALTH_ALERT_AFTER_MS ?? 30_000);
/**
 * `npm run dev` starts the API and the Worker together, and the Worker takes a few seconds to bundle its
 * Workflows. Don't call that an outage: only report "stopped" once the API has been up this long.
 */
const STARTUP_GRACE_MS = Number(process.env.HEALTH_STARTUP_GRACE_MS ?? 20_000);
const startedAt = Date.now();

export type SystemAlert = {
  at: number;
  kind: "worker_down" | "worker_back";
  /** Who the simulated text went to. */
  to: string[];
  text: string;
  simulated: true;
};

export type SystemHealth = {
  workerOk: boolean;
  /** Temporal itself can't be reached (so the Worker can't run anything either). */
  temporalUnreachable: boolean;
  /** The banner sentence while automatic offers are stopped. */
  message?: string;
  /** The banner's second line: what it means for clients and what staff can do meanwhile. */
  advice?: string;
  /** When the API last saw the background service working (epoch ms). */
  lastSeenAt: number | null;
  checkedAt: number | null;
  problems: string[];
  /** Not an outage, but worth knowing (e.g. more than one Worker is polling). */
  warnings: string[];
  /** Worker identities polling the task queue recently. */
  workers: string[];
  taskQueue: string;
  /** The current outage, or the most recent one (so the page can say "running again"). */
  outage: { startedAt: number; detectedAt: number; endedAt?: number; alerted?: boolean } | null;
  /** Newest first. Every entry is a SIMULATED text — nothing is sent. */
  alerts: SystemAlert[];
};

const state: SystemHealth = {
  workerOk: true,
  temporalUnreachable: false,
  lastSeenAt: null,
  checkedAt: null,
  problems: [],
  warnings: [],
  workers: [],
  taskQueue: TASK_QUEUE,
  outage: null,
  alerts: [],
};
let probeFailures = 0;
let probeError: string | undefined;
let describeFailures = 0;
let goodChecks = 0;
let workflowTrack: PollTrack | undefined;
let activityTrack: PollTrack | undefined;
let inFlight: Promise<SystemHealth> | undefined;
let getClientFn: (() => Promise<Client>) | undefined;
/** The most recent DescribeTaskQueue failed (Temporal may be unreachable): callers can skip slow calls. */
let lastDescribeFailed = false;

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function alertStaff(kind: SystemAlert["kind"], text: string, at: number) {
  const to = STAFF_ALERT_RECIPIENTS.map((r) => r.name);
  state.alerts.unshift({ at, kind, to, text, simulated: true });
  state.alerts.length = Math.min(state.alerts.length, MAX_ALERTS);
  for (const r of STAFF_ALERT_RECIPIENTS) {
    console.log(`${SIMULATED} to ${r.name} ${r.mobile} (staff, system alert): Juniper refill: ${text}`);
  }
  console.log(`System alert recorded (simulated text to ${listNames(to)}).`);
}

/** temporal.api.enums.v1.TaskQueueType (numeric, so we don't import @temporalio/proto directly). */
const TASK_QUEUE_TYPE = { WORKFLOW: 1, ACTIVITY: 2 } as const;

async function describe(client: Client, type: number): Promise<TaskQueueDescriptionLike> {
  return client.connection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () =>
    client.workflowService.describeTaskQueue({ namespace: NAMESPACE, taskQueue: { name: TASK_QUEUE }, taskQueueType: type }),
  );
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} seconds (DEADLINE_EXCEEDED)`)), ms).unref())]);

/** Ask the waitlist Workflow a question only a Worker can answer. true = answered (even with an error). */
async function probe(client: Client): Promise<void> {
  const ask = () =>
    client.connection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () => client.workflow.getHandle(WAITLIST_WORKFLOW_ID).query(getWaitlist));
  try {
    await ask();
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
    // First run (or the waitlist was reset): start it, then ask again.
    await client.connection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () => ensureWaitlist(client));
    await ask();
  }
}

async function checkNow(): Promise<SystemHealth> {
  const now = Date.now();
  let workflow: TaskQueueDescriptionLike | undefined;
  let activity: TaskQueueDescriptionLike | undefined;
  let describeError: string | undefined;
  let probeOk = false;
  try {
    const client = await withTimeout(getClientFn!(), PROBE_DEADLINE_MS, "Connecting to Temporal");
    [workflow, activity] = await Promise.all([describe(client, TASK_QUEUE_TYPE.WORKFLOW), describe(client, TASK_QUEUE_TYPE.ACTIVITY)]);
    describeFailures = 0;
    try {
      await probe(client);
      probeOk = true;
    } catch (error) {
      // Only "no answer in time" means no Worker. An error answer (e.g. the query failed) still came from a Worker.
      if (isTransientTemporalError(error)) {
        probeFailures++;
        probeError = "no answer within 4 seconds";
      } else {
        probeOk = true;
        console.warn("Health check: the waitlist answered with an error (a Worker is running):", message(error));
      }
    }
    if (probeOk) {
      probeFailures = 0;
      probeError = undefined;
    }
  } catch (error) {
    describeFailures++;
    describeError = isTransientTemporalError(error) ? `no answer from ${process.env.TEMPORAL_ADDRESS ?? "localhost:7233"} (${message(error).slice(0, 120)})` : message(error);
  }
  lastDescribeFailed = describeError !== undefined;
  const checkedAt = Date.now();
  if (!describeError) {
    workflowTrack = trackPoll(workflowTrack, newestPoll(workflow), checkedAt);
    activityTrack = trackPoll(activityTrack, newestPoll(activity), checkedAt);
  }
  const health = evaluateWorkerHealth({
    nowMs: checkedAt,
    workflow,
    activity,
    workflowTrack,
    activityTrack,
    describeError,
    describeFailures,
    probeFailures,
    probeError,
    taskQueue: TASK_QUEUE,
  });
  if (health.workerOk === false && state.checkedAt === null && checkedAt - startedAt < STARTUP_GRACE_MS) {
    // Still starting up (the Worker may be bundling): check again shortly before deciding anything.
    return snapshot();
  }
  state.checkedAt = checkedAt;
  if (health.workerOk === undefined) return snapshot(); // one failed check: not sure yet, keep what we had

  const wasOk = state.workerOk;
  goodChecks = health.workerOk ? goodChecks + 1 : 0;
  // Coming back needs GOOD_CHECKS_TO_RECOVER good checks in a row (a first check after startup counts straight away).
  const nowOk = health.workerOk && (wasOk || goodChecks >= GOOD_CHECKS_TO_RECOVER);
  state.workers = health.workers;
  state.warnings = health.warnings;
  if (health.workerOk && probeOk) state.lastSeenAt = checkedAt; // seen WORKING: pollers fresh and it answered
  else if (state.lastSeenAt === null && health.lastPollAt !== undefined && !health.workerOk) state.lastSeenAt = Math.min(health.lastPollAt, checkedAt);

  if (!health.workerOk) {
    state.problems = health.problems;
    state.temporalUnreachable = Boolean(health.temporalUnreachable);
  } else if (nowOk) {
    state.problems = [];
    state.temporalUnreachable = false;
  }
  state.workerOk = nowOk;

  if (wasOk && !nowOk) {
    // It stopped some time after it was last seen working (this API may have started mid-outage).
    state.outage = { startedAt: state.lastSeenAt ?? now, detectedAt: checkedAt };
    console.error(
      `\n*** Automatic offers have STOPPED: ${state.temporalUnreachable ? "Temporal can't be reached" : "the Worker isn't running"}. ${health.problems.join(" ")}\n`,
    );
  } else if (!wasOk && nowOk) {
    const outage = state.outage;
    if (outage) outage.endedAt = checkedAt;
    console.log("Automatic offers are running again: a Worker is polling the task queue and answering.");
    // Only follow up if Lena and Carla were told it stopped.
    if (outage?.alerted) alertStaff("worker_back", `${WORKER_BACK_NOTICE}. Openings carried on where they left off.`, checkedAt);
  }
  if (!state.workerOk && state.outage && !state.outage.alerted && checkedAt - state.outage.detectedAt >= ALERT_AFTER_MS) {
    state.outage.alerted = true;
    const seen = state.lastSeenAt ? ` Last seen working at ${clock(state.lastSeenAt)}.` : "";
    alertStaff("worker_down", `${state.temporalUnreachable ? TEMPORAL_DOWN_BANNER : WORKER_DOWN_BANNER}${seen}`, checkedAt);
  }
  return snapshot();
}

const snapshot = (): SystemHealth => ({
  ...state,
  message: state.workerOk ? undefined : state.temporalUnreachable ? TEMPORAL_DOWN_BANNER : WORKER_DOWN_BANNER,
  advice: state.workerOk ? undefined : OUTAGE_ADVICE,
  problems: [...state.problems],
  warnings: [...state.warnings],
  workers: [...state.workers],
  outage: state.outage && { ...state.outage },
  alerts: [...state.alerts],
});

/** Run a check now (shared if one is already running). */
export function checkWorkerHealth(): Promise<SystemHealth> {
  inFlight ??= checkNow().finally(() => (inFlight = undefined));
  return inFlight;
}

/** The latest health, re-checked first if it is older than maxAgeMs (or has never run). */
export async function currentHealth(maxAgeMs = CHECK_EVERY_MS * 2): Promise<SystemHealth> {
  if (state.checkedAt === null || Date.now() - state.checkedAt > maxAgeMs) return checkWorkerHealth();
  return snapshot();
}

/** Last known health without waiting (for fail-fast checks on staff actions). */
export function knownHealth(): SystemHealth {
  return snapshot();
}

/** The last quick check got no answer (the Worker may have just stopped): skip queries that would only time out. */
export function probeFailing(): boolean {
  return probeFailures > 0;
}

/** The last DescribeTaskQueue call failed: Temporal may be unreachable, so skip slow reads for now. */
export function temporalMaybeUnreachable(): boolean {
  return lastDescribeFailed;
}

/** Check every few seconds, so outages are noticed (and alerted) even when nobody has the page open. */
export function startHealthMonitor(getClient: () => Promise<Client>): void {
  getClientFn = getClient;
  const tick = () => void checkWorkerHealth().catch((error) => console.warn("Health check failed:", error));
  tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
