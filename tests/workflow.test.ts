import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { MockActivityEnvironment, TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type * as realActivities from "../src/activities";
import { computeSuggestions } from "../src/matching";
import {
  approveMatches,
  cancelOpening,
  getOpening,
  getWaitlist,
  keepTrying,
  leaveOpen,
  markBooked,
  markSquareDone,
  releaseBooking,
  releaseHold,
  releaseReservations,
  reserveForOffers,
  resolveLateYes,
  respond,
} from "../src/messages";
import { clientOfferView } from "../src/offerView";
import { sampleWaitlist } from "../src/sampleWaitlist";
import type { MarkBookedInput, OpeningInput, OpeningState, RespondInput } from "../src/types";
import type { openingWorkflow } from "../src/workflows";

const TASK_QUEUE = "juniper-salon-test";

// ---- Mocked Activities (record what would have been texted / booked) ----
type Recorded = {
  sent: Array<{ openingId: string; clientIds: string[] }>;
  booked: MarkBookedInput[];
  filledNotices: Array<{ openingId: string; names: string[] }>;
  cancelledNotices: Array<{ openingId: string; names: string[] }>;
  timedOutNotices: Array<{ openingId: string; names: string[] }>;
  releasedBookings: MarkBookedInput[];
  holdReleasedNotices: Array<{ openingId: string; names: string[] }>;
  staffAlerts: Array<{ openingId: string; text: string }>;
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

/** Clients the mocked waitlist reports as holding another opening's live offer. */
const busyElsewhere = new Set<string>();
/** Test hooks that hold an Activity open (a slow SMS gateway). */
const gates: { timedOut?: Promise<void>; send?: Promise<void> } = {};
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const mockActivities: typeof realActivities = {
  async suggestMatches(opening, excludeClientIds) {
    return computeSuggestions(waitlist, opening, { excludeClientIds });
  },
  async reserveForOffers({ clientIds }) {
    return {
      granted: clientIds.filter((id) => !busyElsewhere.has(id)),
      refused: clientIds
        .filter((id) => busyElsewhere.has(id))
        .map((clientId) => ({ clientId, reason: "holding a live offer for opening-other", retryLater: true })),
    };
  },
  async releaseReservations({ releases }) {
    return { released: releases.length };
  },
  async sendOfferTexts({ opening, offers }) {
    if (gates.send) await gates.send;
    recorded.sent.push({ openingId: opening.openingId, clientIds: offers.map((o) => o.clientId) });
    return { deliveredAt: Date.now(), texts: Object.fromEntries(offers.map((o) => [o.offerId, `SIM text for ${o.name}`])) };
  },
  async notifyFilled({ opening, recipients }) {
    recorded.filledNotices.push({ openingId: opening.openingId, names: recipients.map((r) => r.name) });
  },
  async notifyCancelled({ opening, recipients }) {
    await new Promise((r) => setTimeout(r, 300)); // keep the Workflow open briefly so a racing accept reaches it
    recorded.cancelledNotices.push({ openingId: opening.openingId, names: recipients.map((r) => r.name) });
  },
  async notifyTimedOut({ opening, recipients }) {
    if (gates.timedOut) await gates.timedOut;
    recorded.timedOutNotices.push({ openingId: opening.openingId, names: recipients.map((r) => r.name) });
  },
  async notifyHoldReleased({ opening, recipients }) {
    recorded.holdReleasedNotices.push({ openingId: opening.openingId, names: recipients.map((r) => r.name) });
  },
  async notifyStaff({ opening, text }) {
    recorded.staffAlerts.push({ openingId: opening.openingId, text });
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
async function startOpening(overrides: Partial<OpeningInput> = {}) {
  const openingId = `opening-test${++counter}`;
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
    assert.deepEqual(sentFor(openingId), [{ openingId, clientIds: ["c01", "c05", "c06"] }]);
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
    assert.deepEqual(ids, ["c04", "c05", "c06", "c07"]);

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
      await env.sleep("16 minutes");
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

  test("outreach stops once the appointment time has passed", async () => {
    const { handle, openingId } = await startOpening({ startsAtMs: Date.now() - 60_000 });
    await waitFor(handle, (x) => x.status === "awaiting_approval", "awaiting approval");
    await handle.executeUpdate(approveMatches, { args: [{ clientIds: ["c01"] }] });
    const s = await waitFor(handle, (x) => x.status === "unfilled", "unfilled");
    assert.equal(s.unfilledKind, "time_passed");
    assert.equal(sentFor(openingId).length, 0);
    await handle.executeUpdate(leaveOpen);
    await handle.result();
  });

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

describe("sendOfferTexts activity (simulated SMS)", () => {
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
    assert.equal(typeof ok.deliveredAt, "number");
  });
});
