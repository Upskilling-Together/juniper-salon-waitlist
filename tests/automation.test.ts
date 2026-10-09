// "Is the automatic process still working on this?" — the status line, Worker health and failing texts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ServiceError, WorkflowNotFoundError } from "@temporalio/client";
import {
  automationStatus,
  evaluateWorkerHealth,
  isTransientTemporalError,
  textFailureFromPending,
  timestampMs,
  trackPoll,
  UNEXPECTED_STOP_TEXT,
  WORKER_STALE_AFTER_MS,
  type AutomationInput,
} from "../src/automation";
import type { Offer, OpeningState } from "../src/types";

const T0 = Date.UTC(2026, 9, 9, 17, 0); // fixed clock for every case
const formatTime = (ms: number) => `T+${Math.round((ms - T0) / 60_000)}m`;

function opening(overrides: Partial<OpeningState> = {}): OpeningState {
  return {
    opening: {
      openingId: "opening-a",
      service: "Haircut",
      stylist: "Lena",
      startsAt: "2026-10-09T15:00",
      durationMinutes: 45,
      batchSize: 3,
      replyWindowSeconds: 900,
      fastDemo: false,
      simulateTextFailure: false,
    },
    status: "offering",
    cycle: 1,
    suggestions: [],
    queue: [],
    offers: [],
    currentRound: null,
    scheduled: null,
    textingCheck: null,
    roundsSent: 0,
    declinedClientIds: [],
    winner: null,
    bookingRecorded: null,
    square: { required: false, done: false },
    history: [],
    ...overrides,
  };
}
const offer = (offerId: string, status: Offer["status"]): Offer => ({
  offerId,
  clientId: `c-${offerId}`,
  name: `Client ${offerId}`,
  mobile: "(555) 010-0100",
  token: "t",
  round: 1,
  cycle: 1,
  status,
  createdAt: T0,
});
const status = (state: OpeningState | undefined, more: Partial<AutomationInput> = {}) =>
  automationStatus({ state, executionStatus: "RUNNING", workerOk: true, formatTime, ...more });

describe("automation status line (one per opening card)", () => {
  test("running: waiting for replies until the round's deadline", () => {
    const a = status(
      opening({ offers: [offer("o1", "live")], currentRound: { number: 1, offerIds: ["o1"], sentAt: T0, deadline: T0 + 15 * 60_000 } }),
    );
    assert.equal(a.kind, "running");
    assert.equal(a.text, "Automatic offers: running — waiting for replies until T+15m");
    assert.equal(a.icon, "play");
    assert.equal(a.needsYou, false);
    assert.equal(a.active, true);
  });

  test("running: sending texts, finding matches, getting the next round ready", () => {
    assert.equal(
      status(opening({ offers: [offer("o1", "sending")], currentRound: { number: 1, offerIds: ["o1"] } })).text,
      "Automatic offers: running — sending texts",
    );
    assert.equal(status(opening({ status: "finding_matches" })).text, "Automatic offers: running — checking the waitlist for matches");
    assert.equal(status(opening()).text, "Automatic offers: running — getting the next round ready");
  });

  test("scheduled outside texting hours: says when texts go out (not 'Paused', which means an outage)", () => {
    const a = status(
      opening({ scheduled: { until: T0 + 3_600_000, untilLabel: "9:00 AM", text: "Scheduled — texts go out at 9:00 AM (outside texting hours)" } }),
    );
    assert.equal(a.kind, "scheduled");
    assert.equal(a.text, "Scheduled — texts go out at 9:00 AM (outside texting hours)");
    assert.equal(a.icon, "clock");
    assert.equal(a.active, true);
  });

  test("waiting for you: approval, and a held yes to confirm in Square", () => {
    const approve = status(opening({ status: "awaiting_approval" }));
    assert.equal(approve.kind, "waiting_for_you");
    assert.match(approve.text, /^Waiting for you — approve who gets texted/);
    const held = status(
      opening({
        status: "filled",
        winner: { clientId: "c1", name: "Maya", mobile: "x", offerId: "o1", acceptedAt: T0, holdUntil: T0 + 15 * 60_000, via: "reply" },
      }),
    );
    assert.equal(held.kind, "waiting_for_you");
    assert.match(held.text, /^Waiting for you — confirm in Square/);
    assert.match(held.text, /released automatically at T\+15m/);
  });

  test("stopped: nobody took it / too close / cancelled — and finished in Square", () => {
    const nobody = status(opening({ status: "unfilled", unfilledKind: "exhausted" }));
    assert.equal(nobody.kind, "stopped");
    assert.equal(nobody.text, "Stopped — nobody took it. Nothing more will happen until you choose.");
    assert.equal(nobody.icon, "stop");
    assert.match(status(opening({ status: "unfilled", unfilledKind: "too_close" })).text, /^Stopped — too close to the start time/);
    assert.equal(status(opening({ status: "cancelled" }), { executionStatus: "COMPLETED" }).text, "Stopped — cancelled");
    const done = status(opening({ status: "filled", square: { required: true, done: true } }), { executionStatus: "COMPLETED" });
    assert.equal(done.kind, "finished");
    assert.equal(done.text, "Finished — confirmed in Square");
  });

  test("Worker down: every running opening says Paused — background service not running", () => {
    for (const s of [
      opening({ offers: [offer("o1", "live")], currentRound: { number: 1, offerIds: ["o1"], deadline: T0 + 60_000 } }),
      opening({ scheduled: { until: T0, untilLabel: "9:00 AM", text: "" } }),
      opening({ status: "finding_matches" }),
      opening({
        status: "filled",
        winner: { clientId: "c1", name: "Maya", mobile: "x", offerId: "o1", acceptedAt: T0, holdUntil: T0 + 60_000, via: "reply" },
      }),
    ]) {
      const a = status(s, { workerOk: false });
      assert.equal(a.kind, "paused");
      assert.equal(a.icon, "pause");
      assert.equal(a.tone, "warn", "quieter than a single opening's failure: the banner explains it");
      assert.match(a.text, /^Paused — background service not running/);
    }
    // Temporal itself unreachable: the same pause, with the real reason.
    assert.match(
      status(opening({ status: "finding_matches" }), { workerOk: false, temporalUnreachable: true }).text,
      /^Paused — can't reach Temporal \(see the banner at the top\)/,
    );
    // Openings already waiting on staff, or stopped, keep their own line (nothing can be saved meanwhile).
    const approve = status(opening({ status: "awaiting_approval" }), { workerOk: false });
    assert.equal(approve.kind, "waiting_for_you");
    assert.match(approve.text, /^Waiting for you — approve who gets texted.*\(can't be changed until the background service is back\)$/);
    const tooClose = status(opening({ status: "unfilled", unfilledKind: "too_close" }), { workerOk: false });
    assert.equal(tooClose.kind, "stopped");
    assert.match(tooClose.text, /^Stopped — too close to the start time.*can't be changed until the background service is back/);
    // Openings that already finished are unaffected.
    assert.equal(status(opening({ status: "cancelled" }), { workerOk: false, executionStatus: "COMPLETED" }).text, "Stopped — cancelled");
    // An opening that can't be read while the Worker is down is paused, not "broken".
    assert.equal(status(undefined, { workerOk: false, queryError: "deadline exceeded" }).kind, "paused");
  });

  test("texts keep failing: a warning with what to do, the last error as a technical detail, counted in Needs you", () => {
    const s = opening({ offers: [offer("o1", "sending")], currentRound: { number: 1, offerIds: ["o1"] } });
    const a = status(s, { textFailure: { attempt: 4, lastError: "Simulated SMS gateway outage." } });
    assert.equal(a.kind, "texts_failing");
    assert.equal(
      a.text,
      "Texts aren't going out — nobody in this round has been texted yet. It keeps retrying (failed 3 times so far). Text them yourself or cancel the opening.",
    );
    assert.equal(a.technical, "Last error: Simulated SMS gateway outage.");
    assert.equal(a.needsYou, true);
    assert.equal(a.tone, "danger");
    // Two attempts isn't a pattern yet.
    assert.equal(status(s, { textFailure: { attempt: 2, lastError: "x" } }).kind, "running");
    // The Worker being down explains it better than the retry count.
    assert.equal(status(s, { workerOk: false, textFailure: { attempt: 5 } }).kind, "paused");
  });

  test("another step it waits on keeps failing: its own words, also in Needs you", () => {
    const a = status(opening({ status: "finding_matches" }), { textFailure: { attempt: 6, lastError: "sheet unavailable", activity: "suggestMatches" } });
    assert.equal(a.kind, "step_failing");
    assert.match(a.text, /^Can't check the waitlist for matches — it keeps retrying \(failed 5 times so far\)/);
    assert.equal(a.needsYou, true);
  });

  test("didn't answer in time (Worker fine): Unknown, never 'Stopped unexpectedly' and never 'running'", () => {
    const live = opening({ offers: [offer("o1", "live")], currentRound: { number: 1, offerIds: ["o1"], deadline: T0 + 60_000 } });
    const stale = status(live, { queryTransient: true });
    assert.equal(stale.kind, "unknown");
    assert.match(stale.text, /^Unknown — /);
    assert.equal(stale.needsYou, false);
    assert.equal(status(undefined, { queryTransient: true }).kind, "unknown");
  });

  test("an unexpected stop marked as handled leaves Needs you but still says it isn't running", () => {
    const a = status(opening(), { executionStatus: "TERMINATED", handledAt: T0 + 5 * 60_000 });
    assert.equal(a.kind, "stopped_unexpectedly");
    assert.equal(a.needsYou, false);
    assert.match(a.text, /marked as handled at T\+5m\. Automatic offers aren't running/);
  });

  test("ended unexpectedly: terminated / failed / timed out, or unreadable while the Worker is up", () => {
    for (const executionStatus of ["TERMINATED", "FAILED", "TIMED_OUT", "CANCELLED"]) {
      const a = status(opening(), { executionStatus });
      assert.equal(a.kind, "stopped_unexpectedly", executionStatus);
      assert.equal(a.text, UNEXPECTED_STOP_TEXT);
      assert.equal(a.needsYou, true);
      // Even when the Worker is also down, a terminated opening is not "paused".
      assert.equal(status(opening(), { executionStatus, workerOk: false }).kind, "stopped_unexpectedly");
      assert.equal(status(undefined, { executionStatus, workerOk: false }).kind, "stopped_unexpectedly");
    }
    assert.equal(status(undefined, { queryError: "nondeterminism error" }).kind, "stopped_unexpectedly");
    // A closed opening from an older build that can't be replayed is just finished.
    assert.equal(status(undefined, { executionStatus: "COMPLETED", queryError: "nondeterminism" }).kind, "finished");
    // A finished opening that can't be read only because the Worker is down is still just finished.
    assert.match(status(undefined, { executionStatus: "COMPLETED", workerOk: false }).text, /^Finished — details can't be read/);
  });
});

describe("Worker health from DescribeTaskQueue", () => {
  const poller = (agoMs: number) => ({ identity: "1@mac", lastAccessTime: { seconds: Math.floor((T0 - agoMs) / 1000), nanos: 0 } });

  test("a Worker polling both task-queue types recently is OK", () => {
    const h = evaluateWorkerHealth({ nowMs: T0, workflow: { pollers: [poller(40_000)] }, activity: { pollers: [poller(5_000)] } });
    assert.deepEqual(h.problems, []);
    assert.equal(h.workerOk, true);
    assert.equal(h.lastPollAt, T0 - 5_000);
  });

  test("no pollers, or only stale ones, means the background service is down", () => {
    const none = evaluateWorkerHealth({ nowMs: T0, workflow: { pollers: [] }, activity: {} });
    assert.equal(none.workerOk, false);
    assert.equal(none.problems.length, 2);
    assert.match(none.problems[0], /workflow tasks.*never seen/);
    assert.match(none.problems[1], /no texts can be sent/);
    const stale = evaluateWorkerHealth({
      nowMs: T0,
      workflow: { pollers: [poller(WORKER_STALE_AFTER_MS + 1_000)] },
      activity: { pollers: [poller(WORKER_STALE_AFTER_MS + 1_000)] },
    });
    assert.equal(stale.workerOk, false);
    assert.match(stale.problems[0], /last seen 91 s ago/);
  });

  test("staleness is measured on the API's own clock, so server clock skew doesn't matter", () => {
    // The server's clock is 2 minutes behind ours: its lastAccessTime looks old, but it keeps changing.
    const skewed = (n: number) => ({ pollers: [{ identity: "1@mac", lastAccessTime: { seconds: Math.floor((T0 - 120_000 + n * 1000) / 1000) } }] });
    let wfTrack = trackPoll(undefined, T0 - 120_000, T0 - 10_000);
    wfTrack = trackPoll(wfTrack, T0 - 119_000, T0 - 5_000); // it changed 5 s ago (our clock)
    const h = evaluateWorkerHealth({ nowMs: T0, workflow: skewed(1), activity: skewed(1), workflowTrack: wfTrack, activityTrack: wfTrack });
    assert.equal(h.workerOk, true);
    // Unchanged for longer than the limit (our clock): stale, whatever the server's timestamps say.
    const stuck = trackPoll(wfTrack, T0 - 119_000, T0 + WORKER_STALE_AFTER_MS);
    assert.equal(stuck.changedAt, T0 - 5_000);
    const later = evaluateWorkerHealth({ nowMs: T0 + WORKER_STALE_AFTER_MS, workflowTrack: stuck, activityTrack: stuck });
    assert.equal(later.workerOk, false);
  });

  test("more than one Worker polling is a warning (a forgotten old copy keeps the banner green)", () => {
    const two = { pollers: [poller(1_000), { identity: "2@old-mac", lastAccessTime: { seconds: Math.floor((T0 - 3_000) / 1000) } }] };
    const h = evaluateWorkerHealth({ nowMs: T0, workflow: two, activity: two });
    assert.equal(h.workerOk, true);
    assert.deepEqual(h.workers, ["1@mac", "2@old-mac"]);
    assert.match(h.warnings[0], /^2 Workers are polling/);
    assert.deepEqual(evaluateWorkerHealth({ nowMs: T0, workflow: { pollers: [poller(1_000)] }, activity: { pollers: [poller(1_000)] } }).warnings, []);
  });

  test("the quick query check must fail twice in a row before it counts", () => {
    const fresh = { nowMs: T0, workflow: { pollers: [poller(1_000)] }, activity: { pollers: [poller(1_000)] } };
    assert.equal(evaluateWorkerHealth({ ...fresh, probeFailures: 1 }).workerOk, true);
    const down = evaluateWorkerHealth({ ...fresh, probeFailures: 2, probeError: "no answer within 4 seconds" });
    assert.equal(down.workerOk, false);
    assert.match(down.problems[0], /didn't answer 2 checks in a row \(no answer within 4 seconds\)/);
  });

  test("Temporal unreachable: not sure after one failed check, reported after two in a row", () => {
    const once = evaluateWorkerHealth({ nowMs: T0, describeError: "14 UNAVAILABLE: No connection established" });
    assert.equal(once.workerOk, undefined, "one failed check: keep showing what we showed before");
    const h = evaluateWorkerHealth({ nowMs: T0, describeError: "14 UNAVAILABLE: No connection established", describeFailures: 2 });
    assert.equal(h.workerOk, false);
    assert.equal(h.temporalUnreachable, true);
    assert.match(h.problems[0], /Can't reach Temporal/);
  });

  test("protobuf timestamps: numbers, strings and Long-like seconds", () => {
    assert.equal(timestampMs({ seconds: 10, nanos: 500_000_000 }), 10_500);
    assert.equal(timestampMs({ seconds: "10" }), 10_000);
    assert.equal(timestampMs({ seconds: { toNumber: () => 10 }, nanos: 0 }), 10_000);
    assert.equal(timestampMs(null), undefined);
  });
});

describe("steps that keep failing, from the workflow's pending Activities", () => {
  test("flags sendOfferTexts on attempt ≥ 3 with its last error (texts first)", () => {
    const pending = [
      { activityType: { name: "notifyStaff" }, attempt: 9, lastFailure: { message: "other" } },
      { activityType: { name: "reserveForOffers" }, attempt: 8, lastFailure: { message: "busy" } },
      { activityType: { name: "sendOfferTexts" }, attempt: 4, lastFailure: { message: "Simulated SMS gateway outage" } },
    ];
    assert.deepEqual(textFailureFromPending(pending), { attempt: 4, lastError: "Simulated SMS gateway outage", activity: "sendOfferTexts" });
  });
  test("flags other steps the opening waits on; ignores early attempts and background notices", () => {
    assert.equal(textFailureFromPending([{ activityType: { name: "sendOfferTexts" }, attempt: 2 }]), undefined);
    assert.deepEqual(textFailureFromPending([{ activityType: { name: "suggestMatches" }, attempt: 7 }]), {
      attempt: 7,
      lastError: undefined,
      activity: "suggestMatches",
    });
    assert.equal(textFailureFromPending([{ activityType: { name: "notifyTimedOut" }, attempt: 7 }]), undefined);
    assert.equal(textFailureFromPending(undefined), undefined);
  });
});

describe("'no answer in time' vs a real failure (Temporal SDK errors)", () => {
  // What the SDK really throws when a query gets no answer: ServiceError with the gRPC error as its cause.
  const grpc = (code: number, details: string) =>
    Object.assign(new Error(`${code} ${details}`), { code, details, metadata: { get: () => [] } });

  test("a query timeout (ServiceError caused by DEADLINE_EXCEEDED) is transient", () => {
    const timeout = new ServiceError("Failed to query Workflow", { cause: grpc(4, "DEADLINE_EXCEEDED: Deadline exceeded") });
    assert.equal(timeout.message, "Failed to query Workflow", "the outer message alone says nothing about a timeout");
    assert.equal(isTransientTemporalError(timeout), true);
    // …so the card says Unknown (or Paused), never "Stopped unexpectedly".
    const a = automationStatus({ state: undefined, executionStatus: "RUNNING", workerOk: true, queryTransient: isTransientTemporalError(timeout), formatTime });
    assert.equal(a.kind, "unknown");
  });

  test("UNAVAILABLE and CANCELLED are transient; a real failure is not", () => {
    assert.equal(isTransientTemporalError(new ServiceError("Failed to list workflows", { cause: grpc(14, "UNAVAILABLE: No connection established") })), true);
    assert.equal(isTransientTemporalError(grpc(1, "CANCELLED")), true);
    // What Temporal answers once it has noticed no Worker is polling (seen live with the Worker stopped).
    const noPoller = new ServiceError("Failed to query Workflow", {
      cause: grpc(9, "FAILED_PRECONDITION: no poller seen for task queue recently, worker may be down"),
    });
    assert.equal(isTransientTemporalError(noPoller), true);
    assert.equal(isTransientTemporalError(new ServiceError("Failed to query Workflow", { cause: grpc(3, "INVALID_ARGUMENT: bad") })), false);
    assert.equal(isTransientTemporalError(new WorkflowNotFoundError("not found", "opening-x", undefined)), false);
    assert.equal(isTransientTemporalError(Object.assign(new Error("Nondeterminism error: …"), { name: "QueryFailedError" })), false);
    assert.equal(isTransientTemporalError(undefined), false);
  });
});
