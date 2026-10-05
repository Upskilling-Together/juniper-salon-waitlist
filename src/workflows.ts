import {
  allHandlersFinished,
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  isCancellation,
  proxyActivities,
  setHandler,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import {
  approveMatches,
  cancelOpening,
  getOpening,
  getWaitlist,
  keepTrying,
  leaveOpen,
  markBooked,
  markBookedSignal,
  markSquareDone,
  releaseBooking,
  releaseHold,
  releaseReservations,
  reserveForOffers,
  resolveLateYes,
  respond,
} from "./messages";
import { ACCEPT_AFTER_OWN_DEADLINE, HOLD_AUTO_RELEASE_MINUTES } from "./rules";
import { SAMPLE_SOURCE, sampleWaitlist } from "./sampleWaitlist";
import {
  CLIENT_MESSAGES,
  FILLED_NOTICE,
  LATE_YES_MESSAGE,
  type MarkBookedInput,
  type MarkBookedResult,
  type Offer,
  type OpeningInput,
  type OpeningState,
  type ReleaseInput,
  type ReserveInput,
  type ReserveResult,
  type RespondOutcome,
  type RespondResult,
  type WaitlistState,
} from "./types";

// The "accept after your own deadline" rule lives in src/rules.ts (ACCEPT_AFTER_OWN_DEADLINE).

const quick = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "30 seconds" },
});

// Texts: retried durably until the (simulated) SMS gateway accepts them.
// The send runs in a CancellationScope so cancelling the opening stops further attempts.
const texts = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 seconds",
  retry: { initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "30 seconds" },
});

/** Safety net on waitlist reservations beyond the reply window (covers slow text retries). */
const RESERVATION_BUFFER_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// One Workflow per opening (Workflow ID "opening-<shortid>").
// ---------------------------------------------------------------------------
export async function openingWorkflow(input: OpeningInput): Promise<OpeningState> {
  const s: OpeningState = {
    opening: { ...input },
    status: "finding_matches",
    cycle: 1,
    suggestions: [],
    queue: [],
    offers: [],
    currentRound: null,
    roundsSent: 0,
    declinedClientIds: [],
    winner: null,
    bookingRecorded: null,
    square: { required: false, done: false },
    history: [],
  };
  const openingId = input.openingId;
  const log = (kind: string, text: string) => s.history.push({ at: Date.now(), kind, text });
  const names = (offers: { name: string }[]) => offers.map((o) => o.name).join(", ");
  const isLive = (o: Offer) => o.status === "live" || o.status === "sending";
  const reply = (outcome: RespondOutcome, message = CLIENT_MESSAGES[outcome]): RespondResult => ({
    ok: outcome === "booked" || outcome === "declined",
    outcome,
    message,
  });

  /**
   * A client's link token proves who they are; they may have more than one offer for this
   * opening (Keep trying re-texts people), so every link acts on their LATEST offer.
   */
  const resolveOffer = (clientId: string, token: string): Offer | undefined => {
    if (!s.offers.some((o) => o.clientId === clientId && o.token === token)) return undefined;
    return [...s.offers].reverse().find((o) => o.clientId === clientId);
  };

  // Side effects started from handlers or mid-flow without blocking the main state machine
  // (simulated notices, reservation releases). Awaited before the Workflow completes.
  const pending: Promise<unknown>[] = [];
  const background = (p: Promise<unknown>) => void pending.push(p.catch(() => undefined));
  const staffAlert = (text: string) => {
    log("staff_alert", `Simulated text to the salon phone: "${text}"`);
    background(quick.notifyStaff({ opening: s.opening, text }));
  };
  let sendScope: CancellationScope | undefined;

  log("created", `Opening created: ${input.service} with ${input.stylist}, ${input.durationMinutes} min.`);

  // ----- Query -----
  setHandler(getOpening, () => s);

  // ----- Staff approves the suggested list (nothing is texted before this) -----
  setHandler(
    approveMatches,
    ({ clientIds, batchSize, replyWindowSeconds }) => {
      const approved = s.suggestions.filter((m) => clientIds.includes(m.clientId));
      const skipped = s.suggestions.filter((m) => !clientIds.includes(m.clientId));
      if (batchSize !== undefined) s.opening.batchSize = batchSize;
      if (replyWindowSeconds !== undefined) {
        s.opening.replyWindowSeconds = replyWindowSeconds;
        s.opening.fastDemo = replyWindowSeconds === 30;
      }
      s.queue = approved.map((m) => m.clientId);
      s.status = "offering";
      log(
        "approved",
        `Staff approved ${approved.length} ${approved.length === 1 ? "person" : "people"} (${names(approved)})` +
          `${skipped.length ? `; unticked: ${names(skipped)}` : ""}. ` +
          `Batches of ${s.opening.batchSize}, ${formatWindow(s.opening.replyWindowSeconds)} reply window.`,
      );
      return { ok: true, message: `Approved — offers are going out to ${Math.min(approved.length, s.opening.batchSize)} now.` };
    },
    {
      validator: ({ clientIds, batchSize, replyWindowSeconds }) => {
        if (s.status !== "awaiting_approval") {
          throw new Error(`This opening isn't waiting for approval (it is ${s.status.replace("_", " ")}).`);
        }
        if (!Array.isArray(clientIds) || clientIds.length === 0) {
          throw new Error("Tick at least one person to offer it to.");
        }
        const known = new Set(s.suggestions.map((m) => m.clientId));
        if (clientIds.some((id) => !known.has(id))) {
          throw new Error("Some selected people aren't in the suggested list — refresh and try again.");
        }
        if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5)) {
          throw new Error("Batch size must be between 1 and 5.");
        }
        if (
          replyWindowSeconds !== undefined &&
          (!Number.isFinite(replyWindowSeconds) || replyWindowSeconds < 10 || replyWindowSeconds > 24 * 3600)
        ) {
          throw new Error("Reply window must be between 10 seconds and 24 hours.");
        }
      },
    },
  );

  // ----- Client replies from their offer link. FIRST YES WINS. -----
  // The handler is synchronous: there is no await between checking who holds
  // the opening and recording the winner, so two racing accepts cannot both win.
  setHandler(
    respond,
    ({ clientId, token, answer }) => {
      const offer = resolveOffer(clientId, token)!;
      const now = Date.now();
      if (s.winner?.offerId === offer.offerId) return reply("booked");
      if (s.status === "cancelled" || offer.status === "told_cancelled") {
        if (answer === "accept" && !offer.lateReply) {
          offer.lateReply = "no_longer_available";
          log("late_reply", `${offer.name} tapped Accept after the opening was cancelled — not booked.`);
        }
        return reply("no_longer_available");
      }
      if (offer.status === "released") return reply("hold_released");
      if (offer.status === "declined") {
        return reply("already_answered", "You already declined this offer. You're still on the waitlist with your place.");
      }
      if (offer.status === "sending") return reply("not_ready");

      // Already filled: a late Accept is told "just taken"; a late Decline is NOT recorded as a decline.
      if (s.status === "filled" || offer.status === "told_filled") {
        if (answer === "decline") return reply("already_answered", FILLED_NOTICE);
        if (!offer.lateReply) {
          offer.lateReply = "already_taken";
          log("late_reply", `${offer.name} tapped Accept after it was filled — told "just taken", still on the waitlist.`);
        }
        return reply("already_taken");
      }
      if (s.status === "left_open") {
        if (answer === "accept" && !offer.lateReply) {
          offer.lateReply = "no_longer_available";
          log("late_reply", `${offer.name} tapped Accept after outreach was closed — not booked.`);
        }
        return reply("no_longer_available");
      }

      const pastOwnDeadline =
        offer.status === "timed_out" || (offer.status === "live" && offer.deadline !== undefined && now >= offer.deadline);

      if (answer === "decline") {
        if (!s.declinedClientIds.includes(clientId)) s.declinedClientIds.push(clientId);
        offer.status = "declined";
        offer.respondedAt = now;
        log("declined", `${offer.name} declined. Stays on the waitlist with their place.`);
        return reply("declined");
      }

      // answer === "accept"
      if (pastOwnDeadline && !ACCEPT_AFTER_OWN_DEADLINE) {
        if (offer.status === "live") offer.status = "timed_out";
        if (offer.lateReply !== "expired") {
          offer.lateReply = "expired";
          offer.lateYesAt = now;
          log("late_yes", `${offer.name} said yes late (after their reply window) — not booked. Flagged for staff: Book or Dismiss.`);
          staffAlert(`${offer.name} said yes late to the ${s.opening.service} with ${s.opening.stylist}. Open the dashboard to Book or Dismiss.`);
        }
        return reply("expired", LATE_YES_MESSAGE);
      }

      win(offer, now, "reply");
      return reply("booked");
    },
    {
      validator: ({ clientId, token, answer }) => {
        if (answer !== "accept" && answer !== "decline") throw new Error("Answer must be accept or decline.");
        if (typeof clientId !== "string" || typeof token !== "string" || !resolveOffer(clientId, token)) {
          throw ApplicationFailure.nonRetryable("This offer link isn't valid.", "InvalidOfferLink");
        }
      },
    },
  );

  // ----- Staff cancels (stylist sick, original client rebooked, ...) -----
  // Allowed any time before it's confirmed in Square — including while a yes is being held.
  setHandler(
    cancelOpening,
    (args: { reason?: string }) => {
      const told = s.offers.filter((o) => isLive(o) || o.offerId === s.winner?.offerId);
      told.forEach((o) => (o.status = "told_cancelled"));
      const heldFor = s.winner?.name;
      s.winner = null;
      s.bookingRecorded = null;
      s.square = { required: false, done: false };
      s.status = "cancelled";
      s.cancelReason = args?.reason?.trim() || undefined;
      s.queue = [];
      s.currentRound = null;
      s.closedAt = Date.now();
      sendScope?.cancel(); // stop any text still being sent / retried
      log("cancelled", `Staff cancelled the opening${s.cancelReason ? ` (${s.cancelReason})` : ""}${heldFor ? ` — hold for ${heldFor} released` : ""}.`);
      if (told.length) log("told_cancelled", `Told ${names(told)}: no longer available.`);
      return { ok: true, message: "Opening cancelled. Anyone holding an offer is told it's no longer available." };
    },
    {
      validator: (_args: { reason?: string }) => {
        if (s.status === "filled" && s.square.done) throw new Error("It's already confirmed in Square — it can't be cancelled here.");
        if (s.status === "cancelled") throw new Error("It's already cancelled.");
        if (s.status === "left_open") throw new Error("Outreach was already closed (left open).");
      },
    },
  );

  // ----- Nobody took it: staff decide -----
  setHandler(
    keepTrying,
    () => {
      s.cycle += 1;
      s.status = "finding_matches";
      s.unfilledReason = undefined;
      s.unfilledKind = undefined;
      log("keep_trying", "Staff chose Keep trying — re-checking the current waitlist (skipping anyone who declined this opening).");
      return { ok: true, message: "Looking for matches again — you'll be asked to approve them." };
    },
    {
      validator: () => {
        if (s.status !== "unfilled") throw new Error(`"Keep trying" is only available when nobody took it (it is ${s.status.replace("_", " ")}).`);
      },
    },
  );

  setHandler(
    leaveOpen,
    () => {
      s.status = "left_open";
      s.closedAt = Date.now();
      log("left_open", "Staff chose Leave it open — outreach closed, counted as unfilled.");
      return { ok: true, message: "Outreach closed. The opening is left open." };
    },
    {
      validator: () => {
        // Also allowed on a Keep-trying approval list: nothing has been sent in that state.
        if (s.status === "unfilled" || (s.status === "awaiting_approval" && s.cycle > 1)) return;
        throw new Error(`"Leave it open" is only available when nobody took it (it is ${s.status.replace("_", " ")}).`);
      },
    },
  );

  // ----- Held yes: staff confirm (Square) or release -----
  setHandler(
    markSquareDone,
    () => {
      s.square.done = true;
      s.square.doneAt = Date.now();
      log("square_done", `Staff confirmed ${s.winner?.name} and marked the Square appointment as updated.`);
      return { ok: true, message: "Confirmed — Square to-do done." };
    },
    {
      validator: () => {
        if (s.status !== "filled" || !s.winner) throw new Error("There's nothing to confirm in Square — nobody is holding this opening.");
        if (s.square.done) throw new Error("Already marked done.");
      },
    },
  );

  setHandler(
    releaseHold,
    (args: { reason?: string }) => {
      const name = s.winner!.name;
      releaseHoldNow("staff", args?.reason?.trim() || undefined);
      return {
        ok: true,
        message: s.status === "offering" ? `Hold for ${name} released — offering it to the next people.` : `Hold for ${name} released.`,
      };
    },
    {
      validator: (_args: { reason?: string }) => {
        if (s.status !== "filled" || !s.winner) throw new Error("Nobody is holding this opening.");
        if (s.square.done) throw new Error("It's already confirmed in Square.");
      },
    },
  );

  // ----- Late yes flagged on the card: Book (atomic, only if still open) or Dismiss -----
  setHandler(
    resolveLateYes,
    ({ offerId, action }) => {
      const offer = s.offers.find((o) => o.offerId === offerId)!;
      offer.lateYesResolved = action === "book" ? "booked" : "dismissed";
      if (action === "dismiss") {
        log("late_yes_dismissed", `Staff dismissed ${offer.name}'s late yes. They stay on the waitlist.`);
        return { ok: true, message: `Dismissed. ${offer.name} stays on the waitlist.` };
      }
      win(offer, Date.now(), "late_yes");
      return { ok: true, message: `${offer.name} is holding the slot — confirm with them and update Square.` };
    },
    {
      validator: ({ offerId, action }) => {
        const offer = s.offers.find((o) => o.offerId === offerId);
        if (!offer || offer.lateReply !== "expired") throw new Error("There's no late yes to handle for that offer.");
        if (offer.lateYesResolved) throw new Error("That late yes was already handled.");
        if (action !== "book" && action !== "dismiss") throw new Error("Choose Book or Dismiss.");
        if (action === "book" && (s.status === "filled" || s.status === "cancelled" || s.status === "left_open")) {
          throw new Error(`Too late to book — the opening is ${s.status === "filled" ? "already held for someone" : s.status.replace("_", " ")}.`);
        }
        if (action === "book" && s.offers.some((o) => o.clientId === offer.clientId && o !== offer && isLive(o))) {
          throw new Error(`${offer.name} already has a newer offer out for this opening.`);
        }
      },
    },
  );

  // ----- Main flow: a state machine driven by s.status -----
  // Every step re-reads s.status after each await, because Update handlers can change it
  // at any await point. No status is decided before an await a staff action could interleave with.
  for (;;) {
    const st = s.status;
    if (st === "cancelled" || st === "left_open") break;
    if (st === "filled") {
      if (s.square.done) break;
      await holdPhase();
    } else if (st === "finding_matches") await findMatches();
    else if (st === "awaiting_approval") await condition(() => s.status !== "awaiting_approval");
    else if (st === "offering") await runRound();
    else if (st === "unfilled") await condition(() => s.status !== "unfilled");
  }

  if (s.status === "cancelled") sendNotices("told_cancelled", quick.notifyCancelled);
  sendNotices("told_filled", quick.notifyFilled);
  releaseFinishedReservations();
  while (pending.length) await Promise.all(pending.splice(0));
  await condition(allHandlersFinished);
  return s;

  // ----- steps -----
  async function findMatches(): Promise<void> {
    const suggestions = await quick.suggestMatches(s.opening, [...s.declinedClientIds]);
    if (s.status !== "finding_matches") return;
    s.suggestions = suggestions;
    if (suggestions.length === 0) {
      markUnfilled("no_matches", "No one on the waitlist matches this opening right now.");
      return;
    }
    s.status = "awaiting_approval";
    const checkNotes = suggestions.filter((m) => m.checkNote).length;
    log(
      "suggested",
      `Suggested ${suggestions.length} match${suggestions.length === 1 ? "" : "es"} (earliest joiner first)` +
        `${checkNotes ? `; ${checkNotes} need a note check` : ""}. Waiting for staff approval — nothing sent yet.`,
    );
    staffAlert(`${suggestions.length} match${suggestions.length === 1 ? "" : "es"} for the ${describe()} — approve who gets texted.`);
  }

  async function runRound(): Promise<void> {
    if (s.opening.startsAtMs !== undefined && Date.now() >= s.opening.startsAtMs) {
      markUnfilled("time_passed", "The appointment time has passed, so outreach stopped.");
      return;
    }
    const windowMs = s.opening.replyWindowSeconds * 1000;
    const want = s.opening.batchSize;

    // Fill the batch: keep pulling approved people (earliest joiner first) until `want` are
    // reserved or the queue is empty. Reservations are atomic in the waitlist Workflow.
    const picked: { clientId: string; ref: string }[] = [];
    const busyNow: string[] = [];
    let skipped = 0;
    while (picked.length < want && s.queue.length) {
      const ids = s.queue.splice(0, want - picked.length);
      const ref = uuid4();
      const res = await quick.reserveForOffers({ openingId, ref, clientIds: ids, until: Date.now() + windowMs + RESERVATION_BUFFER_MS });
      const granted = res.granted.map((clientId) => ({ clientId, ref }));
      if (s.status !== "offering") {
        // Cancelled / booked from a late yes meanwhile: undo and put everyone back in line.
        background(quick.releaseReservations({ openingId, releases: [...picked, ...granted] }));
        requeueFront([...picked.map((p) => p.clientId), ...ids]);
        return;
      }
      for (const r of res.refused) {
        const name = s.suggestions.find((m) => m.clientId === r.clientId)?.name ?? r.clientId;
        log("skipped", `Skipped ${name}: ${r.reason}.`);
        if (r.retryLater) busyNow.push(r.clientId);
        else skipped++;
      }
      picked.push(...granted);
    }

    if (picked.length === 0) {
      const busyNames = busyNow.map((id) => s.suggestions.find((m) => m.clientId === id)?.name ?? id);
      markUnfilled(
        "exhausted",
        busyNow.length
          ? `Nobody left to text right now — ${busyNames.join(", ")} ${busyNow.length === 1 ? "is" : "are"} holding another opening's offer. Keep trying to check again.`
          : skipped
            ? "Everyone approved was offered it or is no longer available (booked or opted out), and nobody said yes."
            : "Everyone approved was offered it and nobody said yes.",
      );
      return;
    }
    // Busy people (holding another opening's offer) keep their place for the next round.
    if (busyNow.length) requeueFront(busyNow);

    s.roundsSent += 1;
    const roundNo = s.roundsSent;
    const now = Date.now();
    const offers: Offer[] = picked.map(({ clientId, ref }) => {
      const m = s.suggestions.find((x) => x.clientId === clientId)!;
      return {
        offerId: uuid4(),
        clientId,
        name: m.name,
        mobile: m.mobile,
        token: uuid4(),
        round: roundNo,
        cycle: s.cycle,
        status: "sending",
        createdAt: now,
        reservationRef: ref,
      };
    });
    s.offers.push(...offers);
    s.currentRound = { number: roundNo, offerIds: offers.map((o) => o.offerId) };
    log("sending", `Round ${roundNo}: sending simulated texts to ${names(offers)}.`);

    let sent: { deliveredAt: number };
    const scope = new CancellationScope();
    sendScope = scope;
    try {
      sent = await scope.run(() =>
        texts.sendOfferTexts({
          opening: s.opening,
          offers: offers.map(({ offerId, clientId, name, mobile, token }) => ({ offerId, clientId, name, mobile, token })),
          simulateFailure: s.opening.simulateTextFailure,
        }),
      );
    } catch (error) {
      if (isCancellation(error)) {
        log("send_stopped", `Round ${roundNo}: stopped sending texts (the opening changed).`);
        return;
      }
      throw error;
    } finally {
      if (sendScope === scope) sendScope = undefined;
    }
    if (s.status !== "offering") return;

    // The reply window starts only once the texts are actually out.
    const sentAt = Date.now();
    const deadline = sentAt + windowMs;
    for (const o of offers) {
      if (o.status !== "sending") continue;
      o.status = "live";
      o.sentAt = sentAt;
      o.deliveredAt = sent.deliveredAt;
      o.deadline = deadline;
    }
    s.currentRound = { number: roundNo, offerIds: offers.map((o) => o.offerId), sentAt, deadline };
    log("sent", `Round ${roundNo}: simulated texts sent to ${names(offers)} — ${formatWindow(s.opening.replyWindowSeconds)} reply window starts now.`);

    await condition(() => s.status !== "offering" || offers.every((o) => o.status !== "live"), windowMs);
    if (s.status !== "offering") return;

    const noReply = offers.filter((o) => o.status === "live");
    if (noReply.length) {
      noReply.forEach((o) => (o.status = "timed_out"));
      log("timed_out", `No reply (timed out): ${names(noReply)}. They stay on the waitlist.`);
      // Not awaited: the next round must not wait on (or race with) the expiry notice.
      background(quick.notifyTimedOut({ opening: s.opening, recipients: noReply.map(({ name, mobile }) => ({ name, mobile })) }));
    } else {
      log("round_done", `Round ${roundNo}: everyone declined.`);
    }
    releaseFinishedReservations();
    s.currentRound = null;
    if (s.queue.length === 0) markUnfilled("exhausted", "Everyone approved was offered it and nobody said yes.");
    else log("next_round", "Moving on to the next approved people.");
  }

  /** Someone's yes holds the slot until staff confirm (Square done), release it, cancel, or it auto-releases. */
  async function holdPhase(): Promise<void> {
    const w = s.winner!;
    sendNotices("told_filled", quick.notifyFilled);
    releaseFinishedReservations();
    let booking = s.bookingRecorded;
    if (!booking) {
      booking = await quick.markClientBooked({ clientId: w.clientId, openingId });
      if (s.winner?.offerId === w.offerId) {
        s.bookingRecorded = booking;
        if (booking.applied) log("waitlist", `${w.name} marked booked on the waitlist (won't be suggested again).`);
        else {
          log("waitlist", `Waitlist NOT updated: ${booking.reason ?? "unknown reason"} — check before confirming.`);
          staffAlert(`Check ${w.name}: the waitlist says ${booking.reason ?? "they can't be booked"}.`);
        }
        log("square_todo", `To-do: confirm with ${w.name} and update the appointment in Square (hold auto-releases after ${HOLD_AUTO_RELEASE_MINUTES} min).`);
        staffAlert(`${w.name} said yes to the ${describe()}. Confirm with them and update Square.`);
      }
    }
    if (s.status === "filled" && s.winner?.offerId === w.offerId && !s.square.done) {
      const settled = await condition(
        () => s.square.done || s.winner?.offerId !== w.offerId,
        Math.max(1, w.holdUntil - Date.now()),
      );
      if (!settled) releaseHoldNow("auto");
    }
    if (s.winner?.offerId !== w.offerId && booking.applied) {
      await quick.releaseClientBooking({ clientId: w.clientId, openingId });
      log("waitlist", `${w.name} is back on the waitlist with their place.`);
    }
  }

  // ----- synchronous state changes (safe to call from Update handlers) -----
  function win(offer: Offer, now: number, via: "reply" | "late_yes") {
    offer.status = "accepted";
    offer.respondedAt = now;
    s.winner = {
      clientId: offer.clientId,
      name: offer.name,
      mobile: offer.mobile,
      offerId: offer.offerId,
      acceptedAt: now,
      holdUntil: now + HOLD_AUTO_RELEASE_MINUTES * 60_000,
      via,
    };
    s.status = "filled";
    s.square = { required: true, done: false };
    s.bookingRecorded = null;
    s.currentRound = null;
    s.unfilledKind = undefined;
    s.unfilledReason = undefined;
    s.closedAt = now;
    const others = s.offers.filter((o) => o !== offer && isLive(o));
    others.forEach((o) => (o.status = "told_filled"));
    sendScope?.cancel();
    log(
      "filled",
      via === "late_yes"
        ? `Staff booked ${offer.name} from their late yes — slot held for them.`
        : `${offer.name} said YES — slot held for them. Staff to confirm and update Square.`,
    );
    if (others.length) log("told_filled", `Told ${names(others)}: already filled, still on the waitlist.`);
  }

  function releaseHoldNow(by: "staff" | "auto", reason?: string) {
    const w = s.winner!;
    const offer = s.offers.find((o) => o.offerId === w.offerId)!;
    offer.status = "released";
    // Don't offer THIS opening to them again; they keep their place for future openings.
    if (!s.declinedClientIds.includes(w.clientId)) s.declinedClientIds.push(w.clientId);
    s.winner = null;
    s.bookingRecorded = null;
    s.square = { required: false, done: false };
    s.closedAt = undefined;
    log(
      "hold_released",
      by === "auto"
        ? `Hold for ${w.name} auto-released after ${HOLD_AUTO_RELEASE_MINUTES} min without staff confirming.`
        : `Staff released the hold for ${w.name}${reason ? ` (${reason})` : ""}.`,
    );
    background(quick.notifyHoldReleased({ opening: s.opening, recipients: [{ name: w.name, mobile: w.mobile }] }));
    if (by === "auto") staffAlert(`The hold for ${w.name} on the ${describe()} expired — offering it to the next person.`);
    // People told "already filled" in this try never got a fair chance: they go back in line first.
    const latest = new Map<string, Offer>();
    for (const o of s.offers) if (o.cycle === s.cycle) latest.set(o.clientId, o);
    const retry = [...latest.values()]
      .filter((o) => o.status === "told_filled" && !s.declinedClientIds.includes(o.clientId))
      .map((o) => o.clientId);
    requeueFront(retry);
    if (s.queue.length) {
      s.status = "offering";
      log("next_round", "Offering it to the next approved people.");
    } else {
      markUnfilled("exhausted", "The hold was released and nobody else approved is left to text.");
    }
  }

  function markUnfilled(kind: NonNullable<OpeningState["unfilledKind"]>, reason: string) {
    s.status = "unfilled";
    s.unfilledKind = kind;
    s.currentRound = null;
    s.unfilledReason = reason;
    log("unfilled", `${kind === "no_matches" ? "No matches" : "Nobody took it"} — ${reason} Keep trying or leave it open?`);
    staffAlert(
      kind === "no_matches"
        ? `No one on the waitlist matches the ${describe()}. Check again or leave it open.`
        : `Nobody took the ${describe()}. Keep trying or leave it open?`,
    );
  }

  /** Put client ids back at the front of the queue, keeping earliest-joiner order. */
  function requeueFront(ids: string[]) {
    const want = new Set([...ids, ...s.queue]);
    s.queue = s.suggestions.map((m) => m.clientId).filter((id) => want.has(id));
  }

  /** Free waitlist reservations for offers that are no longer live (non-blocking). */
  function releaseFinishedReservations() {
    const done = s.offers.filter(
      (o) => o.reservationRef && !o.reservationReleased && !isLive(o) && o.offerId !== s.winner?.offerId,
    );
    if (!done.length) return;
    done.forEach((o) => (o.reservationReleased = true));
    const releases: ReleaseInput["releases"] = done.map((o) => ({ clientId: o.clientId, ref: o.reservationRef! }));
    background(quick.releaseReservations({ openingId, releases }));
  }

  function sendNotices(
    status: "told_filled" | "told_cancelled",
    send: (args: { opening: OpeningInput; recipients: { name: string; mobile: string }[] }) => Promise<unknown>,
  ) {
    const todo = s.offers.filter((o) => o.status === status && !o.notifiedAt);
    if (!todo.length) return;
    const at = Date.now();
    todo.forEach((o) => (o.notifiedAt = at));
    background(send({ opening: s.opening, recipients: todo.map(({ name, mobile }) => ({ name, mobile })) }));
  }

  function describe() {
    return `${s.opening.service} with ${s.opening.stylist} (${s.opening.startsAt.replace("T", " ")})`;
  }
}

function formatWindow(seconds: number): string {
  if (seconds < 60) return `${seconds}-second`;
  const min = Math.round(seconds / 60);
  return min % 60 === 0 && min >= 60 ? `${min / 60}-hour` : `${min}-minute`;
}

// ---------------------------------------------------------------------------
// Long-running waitlist Workflow (Workflow ID "juniper-waitlist").
// The single atomic owner of who is booked and who is currently being offered something.
// ---------------------------------------------------------------------------
export async function waitlistWorkflow(initial?: WaitlistState): Promise<void> {
  const state: WaitlistState = initial ?? { source: SAMPLE_SOURCE, clients: sampleWaitlist() };
  const find = (id: string) => state.clients.find((c) => c.id === id);

  const apply = ({ clientId, openingId }: MarkBookedInput): MarkBookedResult => {
    const client = find(clientId);
    if (!client) return { applied: false, reason: "client not on the waitlist" };
    if (client.status === "booked") {
      return client.bookedOpeningId === openingId
        ? { applied: true, reason: "already recorded for this opening" }
        : { applied: false, reason: `already booked via ${client.bookedOpeningId}` };
    }
    client.status = "booked";
    client.bookedOpeningId = openingId;
    client.bookedAt = Date.now();
    client.reservedBy = undefined;
    return { applied: true };
  };

  setHandler(getWaitlist, () => state);
  setHandler(markBooked, apply);
  setHandler(markBookedSignal, (i) => void apply(i));

  setHandler(releaseBooking, ({ clientId, openingId }: MarkBookedInput): MarkBookedResult => {
    const client = find(clientId);
    if (!client || client.status !== "booked" || client.bookedOpeningId !== openingId) {
      return { applied: false, reason: "not booked by this opening" };
    }
    client.status = "waiting"; // joinedAt is unchanged, so they keep their place
    client.bookedOpeningId = undefined;
    client.bookedAt = undefined;
    return { applied: true };
  });

  // Synchronous: check-and-reserve has no await, so concurrent openings are serialized here.
  setHandler(reserveForOffers, ({ openingId, ref, clientIds, until }: ReserveInput): ReserveResult => {
    const now = Date.now();
    const result: ReserveResult = { granted: [], refused: [] };
    for (const id of clientIds) {
      const c = find(id);
      if (!c) result.refused.push({ clientId: id, reason: "no longer on the waitlist", retryLater: false });
      else if (c.optedOut) result.refused.push({ clientId: id, reason: "opted out of texts", retryLater: false });
      else if (c.status === "booked") {
        result.refused.push({ clientId: id, reason: `already booked (${c.bookedOpeningId})`, retryLater: false });
      } else if (c.reservedBy && c.reservedBy.openingId !== openingId && c.reservedBy.until > now) {
        result.refused.push({ clientId: id, reason: `holding a live offer for ${c.reservedBy.openingId}`, retryLater: true });
      } else {
        c.reservedBy = { openingId, ref, until };
        result.granted.push(id);
      }
    }
    return result;
  });

  setHandler(releaseReservations, ({ openingId, releases }: ReleaseInput) => {
    let released = 0;
    for (const { clientId, ref } of releases) {
      const c = find(clientId);
      if (c?.reservedBy?.openingId === openingId && c.reservedBy.ref === ref) {
        c.reservedBy = undefined;
        released++;
      }
    }
    return { released };
  });

  await condition(() => workflowInfo().continueAsNewSuggested);
  await condition(allHandlersFinished);
  await continueAsNew<typeof waitlistWorkflow>(state);
}
