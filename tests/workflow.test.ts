import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ApplicationFailure, WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { MockActivityEnvironment, TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type * as realActivities from "../src/activities";
import { computeSuggestions } from "../src/matching";
import {
  addClient,
  approveMatches,
  cancelOpening,
  getOpening,
  getWaitlist,
  keepTrying,
  leaveOpen,
  markBooked,
  markSquareDone,
  recordConsent,
  releaseBooking,
  releaseHold,
  releaseReservations,
  removeClient,
  reserveForOffers,
  resolveLateYes,
  respond,
} from "../src/messages";
import { clientOfferView } from "../src/offerView";
import { sampleWaitlist } from "../src/sampleWaitlist";
import { waitlistSource } from "../src/temporal";
import { computeTextingWindow, fixedOffsetClock, type LocalClock } from "../src/textingHours";
import type { AddClientInput, MarkBookedInput, OpeningInput, OpeningState, RespondInput } from "../src/types";
import type { openingWorkflow } from "../src/workflows";

const TASK_QUEUE = "juniper-salon-test";

// ---- Mocked Activities (record what would have been texted / booked) ----
type Recorded = {
  sent: Array<{ openingId: string; clientIds: string[]; replyWindowSeconds?: number }>;
  booked: MarkBookedInput[];
  filledNotices: Array<{ openingId: string; names: string[] }>;
  cancelledNotices: Array<{ openingId: string; names: string[] }>;
  timedOutNotices: Array<{ openingId: string; names: string[] }>;
  releasedBookings: MarkBookedInput[];
  holdReleasedNotices: Array<{ openingId: string; names: string[] }>;
  staffAlerts: Array<{ openingId: string; text: string; recipients: string[] }>;
};
const recorded: Recorded = {
  sent: [],
  booked: [],
  filledNotices: [],
  cancelledNotices: [],
  timedOutNotices: [],
  releasedBookings: [],
  holdReleasedNotices: [],
  staffAlerts: [],
};
const waitlist = sampleWaitlist();

/**
 * Salon-local wall clock each opening's FIRST texting-hours check should see ("YYYY-MM-DDTHH:mm").
 * From then on that opening's clock moves with Workflow time. Default: Sun Oct 4, 10:00 AM —
 * inside texting hours and not the day of the default (Mon Oct 5) opening.
 */
const localNowFor = new Map<string, string>();
const salonClocks = new Map<string, LocalClock>();
function clockFor(openingId: string, nowMs: number): LocalClock {
  let clock = salonClocks.get(openingId);
  if (!clock) {
    const [y, mo, d, h, mi] = (localNowFor.get(openingId) ?? "2026-10-04T10:00").split(/[-T:]/).map(Number);
    clock = fixedOffsetClock(Date.UTC(y, mo - 1, d, h, mi) - nowMs);
    salonClocks.set(openingId, clock);
  }
  return clock;
}

/** Clients the mocked waitlist reports as holding another opening's live offer. */
const busyElsewhere = new Set<string>();
/** Clients staff recorded as opted out AFTER they were reserved (the send-time consent re-check skips them). */
const optedOutNow = new Set<string>();
/** Makes the mocked gateway refuse like the real Activity does when it runs past its notAfter time. */
const sendTooLate = { on: false };
/** Every reservation release the opening Workflows asked for. */
const releasedReservations: Array<{ openingId: string; clientId: string }> = [];
const skipOptedOut = (recipients: { clientId: string; name: string }[]) => ({
  skipped: recipients.filter((r) => optedOutNow.has(r.clientId)).map((r) => ({ ...r, reason: "opted out of texts" })),
});
const textedOnly = <T extends { clientId: string }>(recipients: T[]) => recipients.filter((r) => !optedOutNow.has(r.clientId));
/** Test hooks that hold an Activity open (a slow SMS gateway). */
const gates: { timedOut?: Promise<void>; send?: Promise<void> } = {};
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const mockActivities: typeof realActivities = {
  async suggestMatches(opening, excludeClientIds, textedBeforeIds) {
    return computeSuggestions(waitlist, opening, { excludeClientIds, textedBeforeIds });
  },
  async reserveForOffers({ clientIds }) {
    return {
      granted: clientIds.filter((id) => !busyElsewhere.has(id)),
      refused: clientIds
        .filter((id) => busyElsewhere.has(id))
        .map((clientId) => ({ clientId, reason: "holding a live offer for opening-other", retryLater: true })),
    };
  },
  async releaseReservations({ openingId, releases }) {
    for (const r of releases) releasedReservations.push({ openingId, clientId: r.clientId });
    return { released: releases.length };
  },
  async textingWindow(input) {
    return computeTextingWindow(input, clockFor(input.openingId, input.nowMs));
  },
  async sendOfferTexts({ opening, offers, replyWindowSeconds }) {
    if (gates.send) await gates.send;
    if (sendTooLate.on) {
      sendTooLate.on = false; // one-shot
      throw ApplicationFailure.nonRetryable("Too late to send", "SendTooLate");
    }
    const texted = textedOnly(offers);
    if (texted.length) recorded.sent.push({ openingId: opening.openingId, clientIds: texted.map((o) => o.clientId), replyWindowSeconds });
    return {
      deliveredAt: Date.now(),
      texts: Object.fromEntries(texted.map((o) => [o.offerId, `SIM text for ${o.name}`])),
      ...skipOptedOut(offers),
    };
  },
  async notifyFilled({ opening, recipients }) {
    recorded.filledNotices.push({ openingId: opening.openingId, names: textedOnly(recipients).map((r) => r.name) });
    return skipOptedOut(recipients);
  },
  async notifyCancelled({ opening, recipients }) {
    await new Promise((r) => setTimeout(r, 300)); // keep the Workflow open briefly so a racing accept reaches it
    recorded.cancelledNotices.push({ openingId: opening.openingId, names: textedOnly(recipients).map((r) => r.name) });
    return skipOptedOut(recipients);
  },
  async notifyTimedOut({ opening, recipients }) {
    if (gates.timedOut) await gates.timedOut;
    recorded.timedOutNotices.push({ openingId: opening.openingId, names: textedOnly(recipients).map((r) => r.name) });
    return skipOptedOut(recipients);
  },
  async notifyHoldReleased({ opening, recipients }) {
    recorded.holdReleasedNotices.push({ openingId: opening.openingId, names: textedOnly(recipients).map((r) => r.name) });
    return skipOptedOut(recipients);
  },
  async notifyStaff({ opening, text, recipients }) {
    recorded.staffAlerts.push({ openingId: opening.openingId, text, recipients: recipients.map((r) => r.name) });
  },
  async markClientBooked(input) {
    recorded.booked.push(input);
    return { applied: true };
  },
  async releaseClientBooking(input) {
    recorded.releasedBookings.push(input);
    return { applied: true };
  },
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let counter = 0;

before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities: mockActivities,
  });
  workerRun = worker.run();
});

after(async () => {
  worker?.shutdown();
  await workerRun;
  await env?.teardown();
});

// Monday 2pm Haircut with Carla => suggestions c01, c04, c05, c06, c07 (earliest joiner first)
async function startOpening(overrides: Partial<OpeningInput> = {}, options: { localNow?: string } = {}) {
  const openingId = `opening-test${++counter}`;
  if (options.localNow) localNowFor.set(openingId, options.localNow);
  const input: OpeningInput = {
    openingId,
    service: "Haircut",
    stylist: "Carla",
    startsAt: "2026-10-05T14:00",
    durationMinutes: 45,
    batchSize: 3,
    replyWindowSeconds: 15 * 60,
    fastDemo: false,
    simulateTextFailure: false,
    ...overrides,
  };
  const handle = await env.client.workflow.start<typeof openingWorkflow>("openingWorkflow", {
    workflowId: openingId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  return { handle, openingId };
}

async function waitFor(
  handle: WorkflowHandle,
  predicate: (s: OpeningState) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<OpeningState> {
  const deadline = Date.now() + timeoutMs;
  let last: OpeningState | undefined;
  while (Date.now() < deadline) {
    last = await handle.query(getOpening);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${what} (status ${last?.status})`);
}

const liveFor = (s: OpeningState, ids: string[]) =>
  ids.every((id) => s.offers.some((o) => o.clientId === id && o.status === "live"));

function offerOf(s: OpeningState, clientId: string) {
  const offer = [...s.offers].reverse().find((o) => o.clientId === clientId);
  assert.ok(offer, `offer for ${clientId}`);
  return offer;
}

function reply(handle: WorkflowHandle, s: OpeningState, clientId: string, answer: RespondInput["answer"]) {
  return handle.executeUpdate(respond, { args: [{ clientId, token: offerOf(s, clientId).token, answer }] });
}

const sentFor = (openingId: string) => recorded.sent.filter((x) => x.openingId === openingId);
const bookedFor = (openingId: string) => recorded.booked.filter((x) => x.openingId === openingId);

describe("openingWorkflow", () => {
  test("nothing is texted before staff approve the suggested list", async () => {
    const { handle, openingId } = await startOpening();
    const s = await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    assert.deepEqual(
      s.suggestions.map((m) => m.clientId),
      ["c01", "c04", "c05", "c06", "c07"],
    );
    await env.sleep("2 hours");
    assert.equal((await handle.query(getOpening)).status, "awaiting_approval");
    assert.equal(sentFor(openingId).length, 0, "no texts before approval");

    await assert.rejects(
      handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c99"] }] }),
      WorkflowUpdateFailedError,
      "approving someone not suggested is rejected",
    );
    await assert.rejects(
      handle.executeUpdate(approveMatches, { args: [{ clientIds: [] }] }),
      WorkflowUpdateFailedError,
    );

    // Staff untick c04 — the first round goes to the next three approved, earliest joiner first.
    const result = await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c05", "c06", "c07"] }] });
    assert.equal(result.ok, true);
    const live = await waitFor(handle, (x) => liveFor(x, ["c01", "c05", "c06"]), "round 1 live");
    assert.deepEqual(sentFor(openingId), [{ openingId, clientIds: ["c01", "c05", "c06"], replyWindowSeconds: 15 * 60 }]);
    assert.ok(live.currentRound?.deadline && live.currentRound.sentAt);
    assert.equal(live.currentRound.deadline - live.currentRound.sentAt, 15 * 60 * 1000, "window starts after send");
    assert.ok(!live.offers.some((o) => o.clientId === "c04"), "unticked person never offered");

    await handle.executeUpdate(cancelOpening, { args: [{ reason: "test cleanup" }] });
  });

  test("two near-simultaneous accepts: exactly one winner, the other is told it was just taken", async () => {
    const { handle, openingId } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c04", "c05"]), "round live");

    const [a, b] = await Promise.all([reply(handle, s, "c04", "accept"), reply(handle, s, "c05", "accept")]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ["already_taken", "booked"]);

    const after = await waitFor(handle, (x) => x.bookingRecorded !== null, "booking recorded");
    assert.equal(after.status, "filled");
    const winnerId = a.outcome === "booked" ? "c04" : "c05";
    const loserId = winnerId === "c04" ? "c05" : "c04";
    assert.equal(after.winner?.clientId, winnerId);
    assert.equal(offerOf(after, "c01").status, "told_filled");
    assert.equal(offerOf(after, loserId).lateReply, "already_taken");
    assert.deepEqual(bookedFor(openingId), [{ clientId: winnerId, openingId }], "only the winner is marked booked");
    assert.ok(recorded.filledNotices.some((n) => n.openingId === openingId && n.names.length >= 1));
    assert.equal(after.square.required, true);
    assert.equal(after.square.done, false);

    await handle.executeUpdate(markSquareDone);
    const final = await handle.result();
    assert.equal(final.status, "filled");
    assert.equal(final.square.done, true);
  });

  test("late accept after the slot is filled: not booked, stays on the waitlist", async () => {
    const { handle, openingId } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c04", "c05"]), "round live");

    assert.equal((await reply(handle, s, "c01", "accept")).outcome, "booked");
    const late = await reply(handle, s, "c04", "accept");
    assert.equal(late.outcome, "already_taken");
    assert.equal(late.ok, false);
    assert.match(late.message, /just taken/);

    // A decline from someone who was already told "filled" is not recorded as a decline.
    const lateDecline = await reply(handle, s, "c05", "decline");
    assert.equal(lateDecline.outcome, "already_answered");
    assert.equal(lateDecline.ok, false);

    const held = await waitFor(handle, (x) => x.bookingRecorded !== null, "booking recorded");
    assert.ok(!held.declinedClientIds.includes("c05"));
    assert.ok(!held.history.some((h) => h.kind === "declined"));
    assert.deepEqual(bookedFor(openingId), [{ clientId: "c01", openingId }]);
    await handle.executeUpdate(markSquareDone);
    await handle.result();
  });

  test("a timed-out round moves on to the next approved people automatically", async () => {
    const { handle, openingId } = await startOpening({ batchSize: 1 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    const r1 = await waitFor(handle, (x) => liveFor(x, ["c01"]), "round 1 live");
    assert.equal(sentFor(openingId).length, 1);

    await env.sleep("16 minutes");
    const r2 = await waitFor(handle, (x) => liveFor(x, ["c04"]), "round 2 live");
    assert.equal(offerOf(r2, "c01").status, "timed_out");
    assert.deepEqual(
      sentFor(openingId).map((x) => x.clientIds),
      [["c01"], ["c04"]],
    );
    assert.ok(recorded.timedOutNotices.some((n) => n.openingId === openingId && n.names.includes("Maya Thompson")));

    // c01 replies after their own deadline => expired, not booked.
    const expired = await reply(handle, r1, "c01", "accept");
    assert.equal(expired.outcome, "expired");
    assert.match(expired.message, /expired/);
    assert.equal((await handle.query(getOpening)).status, "offering");
    assert.equal(bookedFor(openingId).length, 0);

    await handle.executeUpdate(cancelOpening, { args: [{}] });
  });

  test("everyone tried with no yes => unfilled; Keep trying re-suggests (minus decliners); Leave it open closes", async () => {
    const { handle, openingId } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await assert.rejects(handle.executeUpdate(keepTrying), WorkflowUpdateFailedError, "keepTrying only when unfilled");

    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c04"]), "round live");
    assert.equal((await reply(handle, s, "c01", "decline")).outcome, "declined");
    await env.sleep("16 minutes"); // c04 never replies

    const unfilled = await waitFor(handle, (x) => x.status === "unfilled", "unfilled");
    assert.ok(unfilled.unfilledReason);
    assert.equal(offerOf(unfilled, "c04").status, "timed_out");

    await handle.executeUpdate(keepTrying);
    const again = await waitFor(handle, (x) => x.status === "awaiting_approval" && x.cycle === 2, "re-suggested");
    const ids = again.suggestions.map((m) => m.clientId);
    assert.ok(!ids.includes("c01"), "declined this opening => excluded");
    assert.ok(ids.includes("c04"), "timed out => still eligible");
    // Lena: try people never texted for this opening first; earlier non-responders go to the end, marked.
    assert.deepEqual(ids, ["c05", "c06", "c07", "c04"]);
    assert.equal(again.suggestions.find((m) => m.clientId === "c04")?.textedBefore, true);
    assert.ok(!again.suggestions.some((m) => m.clientId !== "c04" && m.textedBefore));

    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c04", "c05"] }] });
    const s2 = await waitFor(handle, (x) => liveFor(x, ["c04", "c05"]), "cycle 2 live");
    // c04's OLD (cycle 1) link now shows their newer, live offer — not "expired".
    const oldLink = offerOf(s, "c04").token;
    const oldView = clientOfferView(s2, "c04", oldLink, Date.now());
    assert.ok(oldView.valid && oldView.canRespond, "old link resolves to the latest offer");
    await reply(handle, s2, "c05", "decline");
    await handle.executeUpdate(respond, { args: [{ clientId: "c04", token: oldLink, answer: "decline" }] });
    await waitFor(handle, (x) => x.status === "unfilled", "unfilled again");

    await handle.executeUpdate(leaveOpen);
    const final = await handle.result();
    assert.equal(final.status, "left_open");
    assert.equal(final.winner, null);
    assert.equal(bookedFor(openingId).length, 0);
  });

  test("Keep trying while the expiry notice is still being sent goes back to approval (no stuck opening)", async () => {
    const slow = gate();
    gates.timedOut = slow.promise;
    try {
      const { handle, openingId } = await startOpening({ batchSize: 1 });
      await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
      await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
      await waitFor(handle, (x) => liveFor(x, ["c01"]), "round live");
      await env.sleep("901 seconds"); // just past the 15-min deadline: the held notice locks time-skipping after that
      await waitFor(handle, (x) => x.status === "unfilled", "unfilled");
      assert.equal(recorded.timedOutNotices.filter((n) => n.openingId === openingId).length, 0, "notice still in flight");

      const kept = await handle.executeUpdate(keepTrying);
      assert.equal(kept.ok, true);
      const again = await waitFor(handle, (x) => x.status === "awaiting_approval" && x.cycle === 2, "back to approval");
      assert.ok(again.suggestions.some((m) => m.clientId === "c01"), "timed out => still eligible");
      slow.open();
      await handle.executeUpdate(cancelOpening, { args: [{}] });
      const final = await handle.result();
      assert.equal(final.status, "cancelled");
      assert.ok(recorded.timedOutNotices.some((n) => n.openingId === openingId), "notice delivered before completing");
    } finally {
      slow.open();
      gates.timedOut = undefined;
    }
  });

  test("Leave it open is allowed on a Keep-trying approval list (nothing sent)", async () => {
    const { handle } = await startOpening({ batchSize: 1 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await assert.rejects(handle.executeUpdate(leaveOpen), WorkflowUpdateFailedError, "not on the first approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01"]), "round live");
    await reply(handle, s, "c01", "decline");
    await waitFor(handle, (x) => x.status === "unfilled", "unfilled");
    await handle.executeUpdate(keepTrying);
    await waitFor(handle, (x) => x.status === "awaiting_approval" && x.cycle === 2, "approval try 2");
    await handle.executeUpdate(leaveOpen);
    assert.equal((await handle.result()).status, "left_open");
  });

  test("a yes only HOLDS the slot: staff release -> next people offered and booking undone; hold auto-releases", async () => {
    const { handle, openingId } = await startOpening({ batchSize: 1 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01"]), "round 1 live");
    const yes = await reply(handle, s, "c01", "accept");
    assert.equal(yes.outcome, "booked");
    assert.match(yes.message, /holding it/);
    const held = await waitFor(handle, (x) => x.bookingRecorded !== null, "hold recorded");
    assert.equal(held.status, "filled");
    assert.ok(held.winner && held.winner.holdUntil - held.winner.acceptedAt === 15 * 60_000);
    assert.ok(recorded.staffAlerts.some((a) => a.openingId === openingId && /said yes/.test(a.text)));

    // Staff couldn't reach Maya: release the hold -> c04 is offered next.
    await handle.executeUpdate(releaseHold, { args: [{ reason: "no answer" }] });
    const next = await waitFor(handle, (x) => liveFor(x, ["c04"]), "c04 offered after release");
    assert.equal(next.winner, null);
    assert.equal(offerOf(next, "c01").status, "released");
    await waitFor(handle, () => recorded.releasedBookings.some((b) => b.openingId === openingId && b.clientId === "c01"), "booking undone");
    assert.ok(recorded.holdReleasedNotices.some((n) => n.openingId === openingId && n.names.includes("Maya Thompson")));
    const mayaView = await reply(handle, s, "c01", "accept");
    assert.equal(mayaView.outcome, "hold_released", "released client can't grab it back");

    // c04 says yes; nobody confirms for 15 minutes -> auto-release -> c05 offered.
    await reply(handle, next, "c04", "accept");
    await waitFor(handle, (x) => x.bookingRecorded !== null && x.winner?.clientId === "c04", "c04 holds");
    await env.sleep("16 minutes");
    const auto = await waitFor(handle, (x) => liveFor(x, ["c05"]), "auto-released to c05");
    assert.ok(auto.history.some((h) => h.kind === "hold_released" && /auto-released/.test(h.text)));
    await handle.executeUpdate(cancelOpening, { args: [{}] });
    await handle.result();
  });

  test("a late yes is flagged for staff; Book wins atomically (only while open), Dismiss leaves it", async () => {
    const { handle, openingId } = await startOpening({ batchSize: 1 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05"] }] });
    const r1 = await waitFor(handle, (x) => liveFor(x, ["c01"]), "round 1 live");
    await env.sleep("16 minutes");
    const r2 = await waitFor(handle, (x) => liveFor(x, ["c04"]), "round 2 live");

    const late = await reply(handle, r1, "c01", "accept");
    assert.equal(late.outcome, "expired");
    assert.match(late.message, /after the deadline/);
    const flagged = await handle.query(getOpening);
    const lateOffer = offerOf(flagged, "c01");
    assert.equal(lateOffer.lateReply, "expired");
    assert.equal(flagged.status, "offering", "outreach moves on");
    assert.ok(recorded.staffAlerts.some((a) => a.openingId === openingId && /said yes late/.test(a.text)));

    const booked = await handle.executeUpdate(resolveLateYes, { args: [{ offerId: lateOffer.offerId, action: "book" }] });
    assert.equal(booked.ok, true);
    const filled = await waitFor(handle, (x) => x.bookingRecorded !== null, "late yes booked");
    assert.equal(filled.winner?.clientId, "c01");
    assert.equal(filled.winner?.via, "late_yes");
    assert.equal(offerOf(filled, "c04").status, "told_filled", "live round told filled");
    assert.equal((await reply(handle, r2, "c04", "accept")).outcome, "already_taken");
    await assert.rejects(
      handle.executeUpdate(resolveLateYes, { args: [{ offerId: lateOffer.offerId, action: "book" }] }),
      WorkflowUpdateFailedError,
      "can't handle twice",
    );
    await handle.executeUpdate(markSquareDone);
    assert.deepEqual(bookedFor(openingId), [{ clientId: "c01", openingId }]);
    await handle.result();
  });

  test("a late yes can be dismissed; Book is refused once someone else holds it", async () => {
    const { handle } = await startOpening({ batchSize: 1 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    const r1 = await waitFor(handle, (x) => liveFor(x, ["c01"]), "round 1 live");
    await env.sleep("16 minutes");
    const r2 = await waitFor(handle, (x) => liveFor(x, ["c04"]), "round 2 live");
    await reply(handle, r1, "c01", "accept"); // late
    await reply(handle, r2, "c04", "accept"); // wins
    const s = await waitFor(handle, (x) => x.status === "filled", "filled");
    const lateOffer = offerOf(s, "c01");
    await assert.rejects(
      handle.executeUpdate(resolveLateYes, { args: [{ offerId: lateOffer.offerId, action: "book" }] }),
      WorkflowUpdateFailedError,
    );
    const dismissed = await handle.executeUpdate(resolveLateYes, { args: [{ offerId: lateOffer.offerId, action: "dismiss" }] });
    assert.equal(dismissed.ok, true);
    assert.equal(offerOf(await handle.query(getOpening), "c01").lateYesResolved, "dismissed");
    await handle.executeUpdate(markSquareDone);
    await handle.result();
  });

  test("a round is topped up when someone is busy with another opening; they keep their place", async () => {
    busyElsewhere.add("c04");
    try {
      const { handle, openingId } = await startOpening({ batchSize: 2 });
      await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
      await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05", "c06"] }] });
      const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c05"]), "round 1 topped up");
      assert.deepEqual(sentFor(openingId)[0].clientIds, ["c01", "c05"]);
      assert.equal(s.queue[0], "c04", "busy person keeps their place in line");
      busyElsewhere.delete("c04");
      await reply(handle, s, "c01", "decline");
      await reply(handle, s, "c05", "decline");
      await waitFor(handle, (x) => liveFor(x, ["c04", "c06"]), "round 2 includes c04");
      await handle.executeUpdate(cancelOpening, { args: [{}] });
      await handle.result();
    } finally {
      busyElsewhere.delete("c04");
    }
  });

  test("no suggestions are made once the start time (or the start-time cutoff) has passed", async () => {
    const t0 = await env.currentTimeMs();
    const passed = await startOpening({ startsAtMs: t0 - 60_000 });
    const p = await waitFor(passed.handle, (x) => x.status === "unfilled", "unfilled");
    assert.equal(p.unfilledKind, "time_passed");
    assert.equal(p.suggestions.length, 0, "staff aren't asked to approve");

    const close = await startOpening({ startsAtMs: t0 + 30 * 60_000, stopOfferingMinutesBefore: 60 });
    const c = await waitFor(close.handle, (x) => x.status === "unfilled", "unfilled (too close)");
    assert.equal(c.unfilledKind, "too_close");
    assert.match(c.unfilledReason ?? "", /Too close to the start time to offer it/);
    assert.ok(recorded.staffAlerts.some((a) => a.openingId === close.openingId && /too close to the start time/.test(a.text)));
    // Close both before awaiting either result: awaiting a result lets the test server skip time.
    for (const { handle, openingId } of [passed, close]) {
      assert.equal(sentFor(openingId).length, 0);
      await handle.executeUpdate(leaveOpen);
    }
    for (const { handle } of [passed, close]) assert.equal((await handle.result()).status, "left_open");
  });

  test("start-time cutoff: the reply window is shortened so it ends by the cutoff, then outreach stops", async () => {
    const t0 = await env.currentTimeMs();
    // Starts in 90 min, stop offering 60 min before => cutoff in ~30 min; the 2-hour window must shrink.
    const { handle, openingId } = await startOpening({
      batchSize: 1,
      replyWindowSeconds: 2 * 3600,
      startsAtMs: t0 + 90 * 60_000,
      stopOfferingMinutesBefore: 60,
    });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01"]), "round 1 live");
    assert.equal(s.opening.stopOfferingMinutesBefore, 60);
    assert.equal(s.offeringCutoffAt, t0 + 30 * 60_000);
    const offer = offerOf(s, "c01");
    assert.equal(offer.windowCapped, true);
    assert.ok(offer.deadline! <= s.offeringCutoffAt!, "deadline never passes the cutoff");
    assert.ok(offer.replyWindowSeconds! >= 25 * 60 && offer.replyWindowSeconds! < 30 * 60, `capped window ${offer.replyWindowSeconds}`);
    assert.equal(offer.replyWindowSeconds! % 60, 0, "whole minutes, so the text never overstates it");
    assert.equal(offer.deadline! - offer.sentAt!, offer.replyWindowSeconds! * 1000);
    assert.equal(sentFor(openingId)[0].replyWindowSeconds, offer.replyWindowSeconds, "the text states the capped window");
    assert.equal(s.currentRound?.windowCapped, true);
    const view = clientOfferView(s, "c01", offer.token, offer.sentAt!);
    assert.ok(view.valid && view.windowCapped && view.replyWindowSeconds === offer.replyWindowSeconds && view.deadline === offer.deadline);
    assert.ok(s.history.some((h) => h.kind === "sent" && /shortened from 2 hours/.test(h.text)));

    await env.sleep("31 minutes");
    const done = await waitFor(handle, (x) => x.status === "unfilled", "stopped at the cutoff");
    assert.equal(done.unfilledKind, "too_close");
    assert.match(done.unfilledReason ?? "", /Too close to the start time to offer it/);
    assert.equal(offerOf(done, "c01").status, "timed_out");
    assert.deepEqual(sentFor(openingId).map((x) => x.clientIds), [["c01"]], "c04 is never texted after the cutoff");
    await handle.executeUpdate(leaveOpen);
    await handle.result();
  });

  test("start-time cutoff: under 5 minutes left to reply counts as too close (nothing sent)", async () => {
    const t0 = await env.currentTimeMs();
    const { handle, openingId } = await startOpening({ startsAtMs: t0 + 63 * 60_000, stopOfferingMinutesBefore: 60 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
    const s = await waitFor(handle, (x) => x.status === "unfilled", "too close");
    assert.equal(s.unfilledKind, "too_close");
    assert.match(s.unfilledReason ?? "", /Too close to the start time to offer it: less than 5 minutes/);
    assert.equal(sentFor(openingId).length, 0);
    assert.equal(s.offers.length, 0);
    await handle.executeUpdate(leaveOpen);
    await handle.result();
  });

  test("texting hours: a round due at 9 PM waits durably until 9:00 AM, then sends", async () => {
    // Tue Oct 6 opening; it is Mon Oct 5, 9:00 PM salon time when staff approve.
    const { handle, openingId } = await startOpening({ startsAt: "2026-10-06T14:00" }, { localNow: "2026-10-05T21:00" });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
    const waiting = await waitFor(handle, (x) => x.scheduled !== null, "scheduled");
    assert.equal(waiting.scheduled?.text, "Scheduled — texts go out at 9:00 AM tomorrow (outside texting hours)");
    assert.equal(waiting.status, "offering");
    assert.equal(waiting.textingCheck?.withinHours, false);
    assert.equal(waiting.textingCheck?.bypass, null);
    assert.ok(waiting.history.some((h) => h.kind === "scheduled" && /Scheduled — texts go out at 9:00 AM tomorrow/.test(h.text)));
    assert.equal(waiting.offers.length, 0);

    await env.sleep("11 hours"); // 8:00 AM: still outside texting hours
    const early = await handle.query(getOpening);
    assert.equal(sentFor(openingId).length, 0, "nothing texted overnight");
    assert.notEqual(early.scheduled, null);

    await env.sleep("1 hour"); // 9:00 AM
    const live = await waitFor(handle, (x) => liveFor(x, ["c01"]), "sent at 9:00 AM");
    assert.equal(live.scheduled, null);
    assert.equal(live.textingCheck?.withinHours, true);
    assert.ok(live.history.some((h) => h.kind === "texting_hours"));
    assert.equal(sentFor(openingId).length, 1);
    await handle.executeUpdate(cancelOpening, { args: [{}] });
    await handle.result();
  });

  test("texting hours: Cancel works while a round is waiting for texting hours", async () => {
    const { handle, openingId } = await startOpening({ startsAt: "2026-10-06T14:00" }, { localNow: "2026-10-05T22:15" });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    await waitFor(handle, (x) => x.scheduled !== null, "scheduled");
    const cancelled = await handle.executeUpdate(cancelOpening, { args: [{ reason: "client rebooked" }] });
    assert.equal(cancelled.ok, true);
    const final = await handle.result();
    assert.equal(final.status, "cancelled");
    assert.equal(final.scheduled, null);
    assert.equal(final.offers.length, 0);
    assert.equal(sentFor(openingId).length, 0, "nobody is texted");
  });

  test("texting hours: same-day openings and Fast demo send at any time of day", async () => {
    // Same-day: 10:30 PM on the opening's own date.
    const same = await startOpening({ startsAt: "2026-10-05T23:30" }, { localNow: "2026-10-05T22:30" });
    await waitFor(same.handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await same.handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c04"] }] });
    const s1 = await waitFor(same.handle, (x) => liveFor(x, ["c04"]), "same-day sent at 10:30 PM");
    assert.equal(s1.textingCheck?.bypass, "same_day");
    assert.equal(s1.textingCheck?.withinHours, false);
    assert.equal(s1.scheduled, null);

    // Fast demo: 11 PM the night before — still sends straight away.
    const demo = await startOpening({ fastDemo: true, replyWindowSeconds: 30 }, { localNow: "2026-10-04T23:00" });
    await waitFor(demo.handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await demo.handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
    const s2 = await waitFor(demo.handle, (x) => liveFor(x, ["c01"]), "fast demo sent at 11 PM");
    assert.equal(s2.textingCheck?.bypass, "fast_demo");
    assert.equal(s2.scheduled, null);
    for (const { handle } of [same, demo]) await handle.executeUpdate(cancelOpening, { args: [{}] });
    for (const { handle } of [same, demo]) assert.equal((await handle.result()).status, "cancelled");
  });

  test("staff alerts go to both Lena and Carla", async () => {
    const { handle, openingId } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await waitFor(handle, () => recorded.staffAlerts.some((a) => a.openingId === openingId), "staff alert sent");
    const alert = recorded.staffAlerts.find((a) => a.openingId === openingId)!;
    assert.deepEqual(alert.recipients, ["Lena", "Carla"]);
    const entry = (await handle.query(getOpening)).history.find((h) => h.kind === "staff_alert");
    assert.match(entry?.text ?? "", /^Simulated text to Lena and Carla: "5 matches for the Haircut with Carla/);
    await handle.executeUpdate(cancelOpening, { args: [{}] });
    await handle.result();
  });

  test("cancel blocks any later accept", async () => {
    const { handle, openingId } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c04", "c05"]), "round live");

    const cancelled = await handle.executeUpdate(cancelOpening, { args: [{ reason: "Carla is sick" }] });
    assert.equal(cancelled.ok, true);
    try {
      const late = await reply(handle, s, "c01", "accept");
      assert.equal(late.outcome, "no_longer_available");
      assert.match(late.message, /no longer available/);
    } catch (error) {
      // If the Workflow had already closed, the Update is rejected outright — also not booked.
      assert.ok(error instanceof Error);
    }
    const final = await handle.result();
    assert.equal(final.status, "cancelled");
    assert.equal(final.winner, null);
    assert.ok(final.offers.every((o) => o.status === "told_cancelled"));
    assert.equal(bookedFor(openingId).length, 0);
    assert.deepEqual(recorded.cancelledNotices.find((n) => n.openingId === openingId)?.names.length, 3);
    await assert.rejects(handle.executeUpdate(cancelOpening, { args: [{}] }));
  });

  test("a wrong token is rejected and changes nothing", async () => {
    const { handle } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c04"]), "round live");

    await assert.rejects(
      handle.executeUpdate(respond, { args: [{ clientId: "c01", token: "not-the-token", answer: "accept" }] }),
      (error: unknown) => error instanceof WorkflowUpdateFailedError && /isn't valid/.test(String(error.cause?.message)),
    );
    // Someone else's token doesn't work either.
    await assert.rejects(
      handle.executeUpdate(respond, {
        args: [{ clientId: "c01", token: offerOf(s, "c04").token, answer: "accept" }],
      }),
      WorkflowUpdateFailedError,
    );
    const after = await handle.query(getOpening);
    assert.equal(after.status, "offering");
    assert.equal(after.winner, null);
    assert.equal(after.history.length, s.history.length, "rejected updates leave no trace in state");
    await handle.executeUpdate(cancelOpening, { args: [{}] });
  });
});

describe("openingWorkflow: review fixes (cutoff while waiting, consent at send time, slow sends)", () => {
  const nameOf = (id: string) => waitlist.find((c) => c.id === id)!.name;

  test("an approval list left past the cutoff stops on its own; Keep trying is refused when it's too close", async () => {
    const t0 = await env.currentTimeMs();
    const { handle, openingId } = await startOpening({ startsAtMs: t0 + 70 * 60_000, stopOfferingMinutesBefore: 60 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await env.sleep("11 minutes"); // past the cutoff, nobody approved
    const s = await waitFor(handle, (x) => x.status === "unfilled", "stopped at the cutoff");
    assert.equal(s.unfilledKind, "too_close");
    assert.match(s.unfilledReason ?? "", /Too close to the start time to offer it: offers stop 1 hour before it starts/);
    await assert.rejects(handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] }), WorkflowUpdateFailedError);
    await assert.rejects(
      handle.executeUpdate(keepTrying),
      (error: unknown) => error instanceof WorkflowUpdateFailedError && /only Leave it open/.test(String(error.cause?.message)),
    );
    const alerts = recorded.staffAlerts.filter((a) => a.openingId === openingId && /Stopped offering/.test(a.text));
    assert.equal(alerts.length, 1, "one alert, not a repeat per click");
    assert.match(alerts[0].text, /Haircut with Carla \(Mon Oct 5, 2:00 PM\)/, "alerts use a readable date");
    assert.equal(sentFor(openingId).length, 0);
    await handle.executeUpdate(leaveOpen);
    await handle.result();
  });

  test("a decline frees that client's waitlist reservation straight away (not at the end of the round)", async () => {
    const { handle, openingId } = await startOpening();
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04"] }] });
    const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c04"]), "round live");
    await reply(handle, s, "c01", "decline");
    await waitFor(handle, () => releasedReservations.some((r) => r.openingId === openingId && r.clientId === "c01"), "c01 released");
    assert.ok(!releasedReservations.some((r) => r.openingId === openingId && r.clientId === "c04"), "c04's offer is still live");
    await handle.executeUpdate(cancelOpening, { args: [{}] });
    await handle.result();
  });

  test("opted out after being picked: not texted; opted out mid-offer: no more texts about it", async () => {
    const slow = gate();
    gates.send = slow.promise;
    try {
      const { handle, openingId } = await startOpening({ batchSize: 3 });
      await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
      await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01", "c04", "c05"] }] });
      await waitFor(handle, (x) => x.offers.some((o) => o.status === "sending"), "sending");
      optedOutNow.add("c04"); // staff record "opted out" while the text is still going out
      slow.open();
      const s = await waitFor(handle, (x) => liveFor(x, ["c01", "c05"]), "round live without c04");
      assert.ok(!s.offers.some((o) => o.clientId === "c04"), "no offer for the opted-out client");
      assert.deepEqual(sentFor(openingId).map((x) => x.clientIds), [["c01", "c05"]]);
      assert.ok(s.history.some((h) => h.kind === "skipped" && h.text.includes(nameOf("c04")) && /opted out of texts — not texted/.test(h.text)));
      assert.equal(s.roundsSent, 1);
      await waitFor(handle, () => releasedReservations.some((r) => r.openingId === openingId && r.clientId === "c04"), "c04 released");

      optedOutNow.add("c01"); // and c01 opts out while their offer is live
      await env.sleep("16 minutes");
      const done = await waitFor(handle, (x) => x.status === "unfilled", "nobody replied");
      await waitFor(handle, () => recorded.timedOutNotices.some((n) => n.openingId === openingId), "expiry notice");
      const notice = recorded.timedOutNotices.find((n) => n.openingId === openingId)!;
      assert.deepEqual(notice.names, [nameOf("c05")], "the opted-out client gets no 'offer expired' text");
      const after = await waitFor(handle, (x) => x.history.some((h) => h.kind === "not_texted"), "logged");
      assert.ok(after.history.some((h) => h.kind === "not_texted" && h.text.includes(nameOf("c01"))));
      assert.equal(done.unfilledKind, "exhausted");
      await handle.executeUpdate(leaveOpen);
      await handle.result();
    } finally {
      slow.open();
      gates.send = undefined;
      optedOutNow.clear();
    }
  });

  test("a send that comes back too late is abandoned: nobody texted, back in line, round re-planned", async () => {
    sendTooLate.on = true;
    try {
      const { handle, openingId } = await startOpening({ startsAt: "2026-10-06T14:00" }, { localNow: "2026-10-05T19:58" });
      await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
      await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
      const late = await waitFor(handle, (x) => x.history.some((h) => h.kind === "send_late"), "abandoned");
      assert.ok(late.history.some((h) => h.kind === "send_late" && /texting hours ended\), so nobody was texted/.test(h.text)));
      // Re-planned: still inside texting hours (Workflow time hasn't moved), so the round goes out again as round 1.
      const s = await waitFor(handle, (x) => liveFor(x, ["c01"]), "re-sent");
      assert.equal(s.offers.length, 1, "the abandoned attempt isn't shown as an offer");
      assert.equal(s.roundsSent, 1);
      assert.equal(sentFor(openingId).length, 1);
      await waitFor(handle, () => releasedReservations.some((r) => r.openingId === openingId && r.clientId === "c01"), "released");
      await handle.executeUpdate(cancelOpening, { args: [{}] });
      await handle.result();
    } finally {
      sendTooLate.on = false;
    }
  });
});

describe("waitlistWorkflow", () => {
  test("markBooked: first booking wins; booked clients drop out of suggestions", async () => {
    const handle = await env.client.workflow.start("waitlistWorkflow", {
      workflowId: "juniper-waitlist-test",
      taskQueue: TASK_QUEUE,
      args: [],
    });
    const first = await handle.executeUpdate(markBooked, { args: [{ clientId: "c01", openingId: "opening-a" }] });
    const second = await handle.executeUpdate(markBooked, { args: [{ clientId: "c01", openingId: "opening-b" }] });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    const state = await handle.query(getWaitlist);
    assert.equal(state.clients.length, 24);
    assert.match(state.source, /Sample data/);
    const c01 = state.clients.find((c) => c.id === "c01");
    assert.equal(c01?.status, "booked");
    assert.equal(c01?.bookedOpeningId, "opening-a");
    const s = computeSuggestions(state.clients, { service: "Haircut", stylist: "Carla", startsAt: "2026-10-05T14:00" });
    assert.ok(!s.some((m) => m.clientId === "c01"));
    await handle.terminate("test done");
  });

  test("reservations: one live offer per client across openings; opted-out never reserved; release by ref", async () => {
    const handle = await env.client.workflow.start("waitlistWorkflow", {
      workflowId: "juniper-waitlist-test-2",
      taskQueue: TASK_QUEUE,
      args: [],
    });
    const until = Number.MAX_SAFE_INTEGER; // the time-skipping server's clock runs ahead of this process's clock
    const [a, b] = await Promise.all([
      handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-a", ref: "ra", clientIds: ["c01", "c04"], until }] }),
      handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-b", ref: "rb", clientIds: ["c04", "c18"], until }] }),
    ]);
    const c04Grants = [a, b].filter((r) => r.granted.includes("c04")).length;
    assert.equal(c04Grants, 1, "exactly one opening gets c04");
    assert.ok(b.refused.some((r) => r.clientId === "c18" && /opted out/.test(r.reason) && !r.retryLater));
    // Not asked yet => never texted, until staff record an opt-in.
    const notAsked = await handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-c", ref: "rc", clientIds: ["c09"], until }] });
    assert.deepEqual(notAsked.granted, []);
    assert.match(notAsked.refused[0].reason, /hasn't been asked/);
    const optIn = await handle.executeUpdate(recordConsent, { args: [{ clientId: "c09", textingConsent: "opted_in" }] });
    assert.equal(optIn.client.textingConsent, "opted_in");
    assert.equal(optIn.client.consentSource, "Recorded by staff");
    assert.deepEqual(
      (await handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-c", ref: "rc2", clientIds: ["c09"], until }] })).granted,
      ["c09"],
    );
    await assert.rejects(
      handle.executeUpdate(recordConsent, { args: [{ clientId: "c09", textingConsent: "not_asked" }] }),
      WorkflowUpdateFailedError,
    );
    const holder = a.granted.includes("c04") ? "opening-a" : "opening-b";
    const holderRef = holder === "opening-a" ? "ra" : "rb";
    // A stale release (wrong ref) does nothing; the right one frees c04.
    assert.equal((await handle.executeUpdate(releaseReservations, { args: [{ openingId: holder, releases: [{ clientId: "c04", ref: "old" }] }] })).released, 0);
    assert.equal((await handle.executeUpdate(releaseReservations, { args: [{ openingId: holder, releases: [{ clientId: "c04", ref: holderRef }] }] })).released, 1);
    const other = holder === "opening-a" ? "opening-b" : "opening-a";
    assert.deepEqual((await handle.executeUpdate(reserveForOffers, { args: [{ openingId: other, ref: "r2", clientIds: ["c04"], until }] })).granted, ["c04"]);

    // Booking then releasing the hold: back to waiting with the same place.
    await handle.executeUpdate(markBooked, { args: [{ clientId: "c01", openingId: "opening-a" }] });
    assert.equal((await handle.executeUpdate(releaseBooking, { args: [{ clientId: "c01", openingId: "opening-b" }] })).applied, false);
    assert.equal((await handle.executeUpdate(releaseBooking, { args: [{ clientId: "c01", openingId: "opening-a" }] })).applied, true);
    const c01 = (await handle.query(getWaitlist)).clients.find((c) => c.id === "c01");
    assert.equal(c01?.status, "waiting");
    assert.equal(c01?.joinedAt, "2026-08-04T10:15:00.000Z");
    await handle.terminate("test done");
  });
});

describe("waitlistWorkflow: consent, Add to waitlist, Remove from waitlist", () => {
  const rejectsWith = (p: Promise<unknown>, re: RegExp) =>
    assert.rejects(p, (error: unknown) => error instanceof WorkflowUpdateFailedError && re.test(String(error.cause?.message)));
  const valid: AddClientInput = {
    name: "  Ava   Reyes ",
    mobile: "555-010-0125",
    service: "Haircut",
    stylistRule: { kind: "any", preferred: "Nico" },
    availabilityNote: "weekday afternoons, not too late",
    textingConsent: "opted_in",
  };

  test("sample consent: most opted in, two opted out, three not asked — only opted-in are suggested", async () => {
    const counts = { opted_in: 0, opted_out: 0, not_asked: 0 };
    for (const c of waitlist) counts[c.textingConsent]++;
    assert.deepEqual(counts, { opted_in: 19, opted_out: 2, not_asked: 3 });
    for (const c of waitlist.filter((x) => x.textingConsent !== "opted_in")) {
      const stylist = c.stylistRule.kind === "required" ? c.stylistRule.stylist : "Lena";
      for (const startsAt of ["2026-10-05T10:00", "2026-10-05T14:00", "2026-10-08T18:00", "2026-10-10T10:00"]) {
        const s = computeSuggestions(waitlist, { service: c.service, stylist, startsAt });
        assert.ok(!s.some((m) => m.clientId === c.id), `${c.id} (${c.textingConsent}) is never suggested`);
      }
    }
  });

  test("addClient: validated, tidied, and added at the back of the line", async () => {
    const handle = await env.client.workflow.start("waitlistWorkflow", { workflowId: "juniper-waitlist-test-3", taskQueue: TASK_QUEUE, args: [] });
    await rejectsWith(handle.executeUpdate(addClient, { args: [{ ...valid, name: "  " }] }), /Enter their name/);
    await rejectsWith(handle.executeUpdate(addClient, { args: [{ ...valid, mobile: "" }] }), /Enter their mobile number/);
    await rejectsWith(handle.executeUpdate(addClient, { args: [{ ...valid, mobile: "12345" }] }), /valid mobile/);
    await rejectsWith(handle.executeUpdate(addClient, { args: [{ ...valid, service: "Trim" as never }] }), /Choose a service/);
    await rejectsWith(
      handle.executeUpdate(addClient, { args: [{ ...valid, stylistRule: { kind: "required", stylist: "Bob" as never } }] }),
      /Choose which stylist/,
    );
    await rejectsWith(handle.executeUpdate(addClient, { args: [{ ...valid, textingConsent: undefined as never }] }), /Can we text them/);
    await rejectsWith(
      handle.executeUpdate(addClient, { args: [{ ...valid, mobile: "(555) 010-0101" }] }),
      /Maya Thompson .* is already on the waitlist for Haircut/,
    );
    assert.equal((await handle.query(getWaitlist)).clients.length, 24, "rejected adds change nothing");

    const added = await handle.executeUpdate(addClient, { args: [valid] });
    assert.equal(added.ok, true);
    const ava = added.client;
    assert.equal(ava.id, "c25");
    assert.equal(ava.name, "Ava Reyes");
    assert.equal(ava.mobile, "(555) 010-0125");
    assert.equal(ava.availabilityNote, "weekday afternoons, not too late", "note kept as typed");
    assert.deepEqual(ava.availabilityTags.parts, ["afternoon"]);
    assert.equal(ava.status, "waiting");
    assert.equal(ava.textingConsent, "opted_in");
    assert.equal(ava.consentSource, "Asked when they joined");

    const notAsked = await handle.executeUpdate(addClient, {
      args: [{ ...valid, name: "Ben Ito", mobile: "(555) 010-0126", textingConsent: "not_asked" }],
    });
    assert.equal(notAsked.client.id, "c26");
    assert.equal(notAsked.client.consentRecordedAt, undefined);

    const state = await handle.query(getWaitlist);
    assert.equal(state.clients.length, 26);
    assert.ok(state.clients.every((c) => c.id === "c25" || c.id === "c26" || c.joinedAt < ava.joinedAt), "joinedAt = now");
    const s = computeSuggestions(state.clients, { service: "Haircut", stylist: "Carla", startsAt: "2026-10-05T14:00" });
    assert.deepEqual(
      s.map((m) => m.clientId),
      ["c01", "c04", "c05", "c06", "c07", "c25"],
      "new client is suggested last (back of the line); the not-asked one isn't suggested",
    );
    await handle.terminate("test done");
  });

  test("removeClient: refused while holding an offer or a held slot; removed clients are never suggested or reserved", async () => {
    const handle = await env.client.workflow.start("waitlistWorkflow", { workflowId: "juniper-waitlist-test-4", taskQueue: TASK_QUEUE, args: [] });
    const until = Number.MAX_SAFE_INTEGER;
    await handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-a", ref: "ra", clientIds: ["c01"], until }] });
    await rejectsWith(handle.executeUpdate(removeClient, { args: [{ clientId: "c01" }] }), /live offer.*Cancel or finish their current offer first/);
    await handle.executeUpdate(markBooked, { args: [{ clientId: "c05", openingId: "opening-b" }] });
    await rejectsWith(handle.executeUpdate(removeClient, { args: [{ clientId: "c05" }] }), /booked from an opening, so they're already off the waiting list/);
    await rejectsWith(handle.executeUpdate(removeClient, { args: [{ clientId: "c99" }] }), /isn't on the waitlist/);

    const removed = await handle.executeUpdate(removeClient, { args: [{ clientId: "c04", reason: "Found another salon" }] });
    assert.equal(removed.ok, true);
    assert.equal(removed.client.status, "removed");
    assert.equal(removed.client.removedReason, "Found another salon");
    assert.ok(removed.client.removedAt);
    await rejectsWith(handle.executeUpdate(removeClient, { args: [{ clientId: "c04" }] }), /already removed/);
    await rejectsWith(handle.executeUpdate(recordConsent, { args: [{ clientId: "c04", textingConsent: "opted_in" }] }), /removed/);

    const state = await handle.query(getWaitlist);
    assert.equal(state.clients.length, 24, "kept for history");
    const s = computeSuggestions(state.clients, { service: "Haircut", stylist: "Carla", startsAt: "2026-10-05T14:00" });
    assert.ok(!s.some((m) => m.clientId === "c04"), "removed => never suggested");
    const r = await handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-c", ref: "rc", clientIds: ["c04"], until }] });
    assert.deepEqual(r.granted, []);
    assert.match(r.refused[0].reason, /removed from the waitlist/);
    assert.equal((await handle.executeUpdate(markBooked, { args: [{ clientId: "c04", openingId: "opening-c" }] })).applied, false);

    // Once their offer is over, they can be removed.
    await handle.executeUpdate(releaseReservations, { args: [{ openingId: "opening-a", releases: [{ clientId: "c01", ref: "ra" }] }] });
    assert.equal((await handle.executeUpdate(removeClient, { args: [{ clientId: "c01" }] })).client.status, "removed");
    await handle.terminate("test done");
  });

  test("texting consent belongs to the phone number, not one waitlist entry", async () => {
    const handle = await env.client.workflow.start("waitlistWorkflow", { workflowId: "juniper-waitlist-test-6", taskQueue: TASK_QUEUE, args: [] });
    const until = Number.MAX_SAFE_INTEGER;
    // Maya (c01, opted in, Haircut) is added again for a Blowout and says No this time: applies to both entries.
    const no = await handle.executeUpdate(addClient, {
      args: [{ ...valid, name: "Maya Thompson", mobile: "555.010.0101", service: "Blowout", textingConsent: "opted_out" }],
    });
    assert.equal(no.client.textingConsent, "opted_out");
    assert.match(no.message, /Also updated the texting answer on 1 other waitlist entry with this number/);
    let state = await handle.query(getWaitlist);
    assert.equal(state.clients.find((c) => c.id === "c01")?.textingConsent, "opted_out");
    const r = await handle.executeUpdate(reserveForOffers, { args: [{ openingId: "opening-a", ref: "ra", clientIds: ["c01"], until }] });
    assert.deepEqual(r.granted, [], "an opted-out number is never texted");

    // "Didn't ask" on a third entry keeps the number's answer.
    const kept = await handle.executeUpdate(addClient, {
      args: [{ ...valid, name: "Maya Thompson", mobile: "(555) 010-0101", service: "Color", textingConsent: "not_asked" }],
    });
    assert.equal(kept.client.textingConsent, "opted_out");
    assert.match(kept.message, /already had an answer/);

    // Recording an answer on one entry updates them all.
    const yes = await handle.executeUpdate(recordConsent, { args: [{ clientId: "c01", textingConsent: "opted_in" }] });
    assert.match(yes.message, /Also updated 2 other waitlist entries with this number/);
    state = await handle.query(getWaitlist);
    assert.deepEqual(
      state.clients.filter((c) => c.mobile === "(555) 010-0101").map((c) => c.textingConsent),
      ["opted_in", "opted_in", "opted_in"],
    );
    await assert.rejects(
      handle.executeUpdate(recordConsent, { args: [{ clientId: "c99", textingConsent: "opted_in" }] }),
      (error: unknown) => error instanceof WorkflowUpdateFailedError && (error.cause as { type?: string })?.type === "WaitlistClientNotFound",
    );
    await handle.terminate("test done");
  });

  test("an old waitlist carried over by continue-as-new is upgraded (optedOut -> consent, Highlights/Trim)", async () => {
    // Shape of a waitlist saved by the previous version: no textingConsent, an optedOut flag, old service names.
    const old = sampleWaitlist().map((c) => {
      const legacy: Record<string, unknown> = { ...c };
      for (const key of ["textingConsent", "consentRecordedAt", "consentSource"]) delete legacy[key];
      if (c.id === "c18") legacy.optedOut = true;
      if (c.id === "c22") legacy.service = "Trim";
      return legacy;
    });
    const handle = await env.client.workflow.start("waitlistWorkflow", {
      workflowId: "juniper-waitlist-test-5",
      taskQueue: TASK_QUEUE,
      args: [{ source: "Someone's sheet", clients: old as never }],
    });
    const state = await handle.query(getWaitlist);
    const by = (id: string) => state.clients.find((c) => c.id === id)!;
    assert.equal(by("c18").textingConsent, "opted_out");
    assert.equal(by("c01").textingConsent, "not_asked", "unknown consent is never assumed");
    assert.equal(by("c22").service, "Haircut");
    assert.ok(!state.clients.some((c) => "optedOut" in c));
    await handle.terminate("test done");
  });
});

describe("sendOfferTexts activity (simulated SMS)", () => {
  before(() => {
    // The consent re-check reads the waitlist; give it the sample sheet instead of a Temporal server.
    waitlistSource.load = async () => sampleWaitlist();
  });
  const offer = { offerId: "o1", clientId: "c01", name: "Maya Thompson", mobile: "(555) 010-0101", token: "t" };
  const opening: OpeningInput = {
    openingId: "opening-x",
    service: "Haircut",
    stylist: "Carla",
    startsAt: "2026-10-05T14:00",
    durationMinutes: 45,
    batchSize: 3,
    replyWindowSeconds: 900,
    fastDemo: false,
    simulateTextFailure: true,
  };
  test("'Simulate first text attempt failing' throws on attempt 1 and succeeds on the retry", async () => {
    const { sendOfferTexts } = await import("../src/activities");
    const attempt1 = new MockActivityEnvironment({ attempt: 1 });
    await assert.rejects(attempt1.run(sendOfferTexts, { opening, offers: [offer], simulateFailure: true }), /Simulated SMS/);
    const attempt2 = new MockActivityEnvironment({ attempt: 2 });
    const ok: { deliveredAt: number; texts: Record<string, string> } = await attempt2.run(sendOfferTexts, { opening, offers: [offer], simulateFailure: true });
    assert.match(ok.texts[offer.offerId], /late replies aren't guaranteed/);
    assert.match(ok.texts[offer.offerId], /Reply within 15 min/);
    assert.equal(typeof ok.deliveredAt, "number");
  });

  test("the text states the round's actual (capped) reply window", async () => {
    const { sendOfferTexts } = await import("../src/activities");
    const env1 = new MockActivityEnvironment({ attempt: 1 });
    const res: { texts: Record<string, string> } = await env1.run(sendOfferTexts, {
      opening: { ...opening, replyWindowSeconds: 7200 },
      offers: [offer],
      simulateFailure: false,
      replyWindowSeconds: 22 * 60,
    });
    assert.match(res.texts[offer.offerId], /Reply within 22 min/);
  });

  test("consent is re-checked at send time: opted-out people aren't texted, by offer or by follow-up notice", async () => {
    const { sendOfferTexts, notifyTimedOut } = await import("../src/activities");
    const isaac = { offerId: "o2", clientId: "c18", name: "Isaac Cohen", mobile: "(555) 010-0118", token: "t2" };
    const res: { texts: Record<string, string>; skipped?: { clientId: string; reason: string }[] } = await new MockActivityEnvironment({
      attempt: 1,
    }).run(sendOfferTexts, { opening, offers: [offer, isaac], simulateFailure: false });
    assert.ok(res.texts[offer.offerId]);
    assert.equal(res.texts[isaac.offerId], undefined);
    assert.deepEqual(res.skipped?.map((x) => [x.clientId, x.reason]), [["c18", "opted out of texts"]]);
    const notice: { skipped: { clientId: string }[] } = await new MockActivityEnvironment().run(notifyTimedOut, {
      opening,
      recipients: [
        { clientId: "c01", name: "Maya Thompson", mobile: "(555) 010-0101" },
        { clientId: "c18", name: "Isaac Cohen", mobile: "(555) 010-0118" },
      ],
    });
    assert.deepEqual(notice.skipped.map((x) => x.clientId), ["c18"]);
  });

  test("a send that runs past its deadline refuses (nothing sent) instead of texting late", async () => {
    const { sendOfferTexts } = await import("../src/activities");
    await assert.rejects(
      new MockActivityEnvironment({ attempt: 3 }).run(sendOfferTexts, { opening, offers: [offer], simulateFailure: false, notAfter: Date.now() - 1 }),
      /Too late to send/,
    );
  });
});

// Last on purpose: this holds a (mocked) SMS send open while the Workflow gives up on it. The
// time-skipping test server can stay locked for a while afterwards, which would slow any later env.sleep.
describe("slow SMS gateway", () => {
  test("cancel stops a text that is still being sent", async () => {
    const slow = gate();
    gates.send = slow.promise;
    try {
      const { handle, openingId } = await startOpening();
      await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
      await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
      await waitFor(handle, (x) => x.offers.some((o) => o.status === "sending"), "sending");
      await handle.executeUpdate(cancelOpening, { args: [{ reason: "stylist sick" }] });
      const final = await handle.result(); // completes without waiting for the stuck SMS gateway
      assert.equal(final.status, "cancelled");
      assert.ok(final.offers.every((o) => o.status === "told_cancelled" && o.deadline === undefined));
      assert.ok(final.history.some((h) => h.kind === "send_stopped"));
      assert.equal(sentFor(openingId).length, 0);
    } finally {
      slow.open();
      gates.send = undefined;
    }
  });
});
