import {
  ActivityFailure,
  allHandlersFinished,
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type { NoticeResult } from "./activities";
import { formatSlot, formatWindowSeconds, listNames, minutesText } from "./format";
import { optedOutNumbers, parseAvailability } from "./matching";
import {
  addClient,
  approveMatches,
  cancelOpening,
  getOpening,
  getWaitlist,
  keepTrying,
  leaveOpen,
  markBooked,
  markBookedSignal,
  markSquareDone,
  recordConsent,
  releaseBooking,
  releaseHold,
  releaseReservations,
  removeClient,
  reserveForOffers,
  resolveLateYes,
  respond,
} from "./messages";
import {
  ACCEPT_AFTER_OWN_DEADLINE,
  DEFAULT_STOP_OFFERING_MINUTES,
  HOLD_AUTO_RELEASE_MINUTES,
  MIN_CAPPED_REPLY_WINDOW_MINUTES,
  STAFF_ALERT_RECIPIENTS,
  TEXTING_HOURS,
  TOO_CLOSE_REASON,
} from "./rules";
import { SAMPLE_SOURCE, sampleWaitlist } from "./sampleWaitlist";
import {
  CONSENT_LABELS,
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
  type Service,
  type WaitlistActionResult,
  type WaitlistClient,
  type WaitlistState,
} from "./types";
import { checkAddClientInput, mobileDigits } from "./waitlistInput";

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
/**
 * When a reply window is shortened to fit the start-time cutoff, leave this much slack for the send
 * itself, so the window promised in the text still ends by the cutoff. A send that takes longer is
 * abandoned (nothing goes out) and the round is re-planned.
 */
const SEND_MARGIN_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// One Workflow per opening (Workflow ID "opening-<shortid>").
// ---------------------------------------------------------------------------
export async function openingWorkflow(input: OpeningInput): Promise<OpeningState> {
  const stopMinutes = input.stopOfferingMinutesBefore ?? DEFAULT_STOP_OFFERING_MINUTES;
  const s: OpeningState = {
    opening: { ...input, stopOfferingMinutesBefore: stopMinutes },
    status: "finding_matches",
    cycle: 1,
    suggestions: [],
    queue: [],
    offers: [],
    currentRound: null,
    scheduled: null,
    textingCheck: null,
    offeringCutoffAt: input.startsAtMs !== undefined ? input.startsAtMs - stopMinutes * 60_000 : undefined,
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
  const recipient = ({ clientId, name, mobile }: { clientId: string; name: string; mobile: string }) => ({ clientId, name, mobile });
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
  const staffNames = listNames(STAFF_ALERT_RECIPIENTS.map((r) => r.name));
  const staffAlert = (text: string) => {
    log("staff_alert", `Simulated text to ${staffNames}: "${text}"`);
    background(quick.notifyStaff({ opening: s.opening, text, recipients: [...STAFF_ALERT_RECIPIENTS] }));
  };
  let sendScope: CancellationScope | undefined;

  log(
    "created",
    `Opening created: ${input.service} with ${input.stylist}, ${input.durationMinutes} min. ` +
      `Offers stop ${minutesText(stopMinutes)} before it starts.`,
  );

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
      // Don't promise "texts are going out": texting hours or the cutoff may still hold the round back.
      // The card (and the dashboard's toast) show what actually happens next.
      return { ok: true, message: `Approved ${approved.length} ${approved.length === 1 ? "person" : "people"}.` };
    },
    {
      validator: ({ clientIds, batchSize, replyWindowSeconds }) => {
        if (s.status !== "awaiting_approval") {
          throw new Error(`This opening isn't waiting for approval (it is ${s.status.replace("_", " ")}).`);
        }
        if (s.offeringCutoffAt !== undefined && Date.now() >= s.offeringCutoffAt) {
          throw new Error(`${TOO_CLOSE_REASON} — offers stop ${minutesText(stopMinutes)} before it starts.`);
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
        // Free their waitlist reservation now (not at round end), so staff can e.g. remove them if they ask.
        releaseFinishedReservations();
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
      s.scheduled = null;
      s.closedAt = Date.now();
      sendScope?.cancel(); // stop any text still being sent / retried
      log("cancelled", `Staff cancelled the opening${s.cancelReason ? ` (${s.cancelReason})` : ""}${heldFor ? ` — hold for ${heldFor} released` : ""}.`);
      if (told.length) log("told_cancelled", `Simulated text to ${names(told)}: no longer available.`);
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
        if (s.unfilledKind === "too_close" || s.unfilledKind === "time_passed") {
          throw new Error("It's too close to the start time to offer it — only Leave it open is available.");
        }
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
    else if (st === "awaiting_approval") {
      // Waiting for staff, but never past the start-time cutoff: then outreach stops on its own.
      if (s.offeringCutoffAt === undefined) await condition(() => s.status !== "awaiting_approval");
      else {
        const decided = await condition(() => s.status !== "awaiting_approval", Math.max(1, s.offeringCutoffAt - Date.now()));
        if (!decided && s.status === "awaiting_approval") tooLateToOffer();
      }
    }
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
    if (tooLateToOffer()) return;
    // Keep trying: people already texted for this opening with no reply go to the END (Lena: try others first).
    const textedBefore = [...new Set(s.offers.filter((o) => o.status === "timed_out").map((o) => o.clientId))].filter(
      (id) => !s.declinedClientIds.includes(id),
    );
    const suggestions = await quick.suggestMatches(s.opening, [...s.declinedClientIds], textedBefore);
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
    if (tooLateToOffer()) return;

    // Texting hours (salon local time is only read inside the Activity; we pass our own clock).
    const tw = await quick.textingWindow({
      openingId,
      nowMs: Date.now(),
      startsAt: s.opening.startsAt,
      fastDemo: s.opening.fastDemo,
      cutoffAt: s.offeringCutoffAt,
    });
    if (s.status !== "offering") return;
    s.textingCheck = { ...tw, at: Date.now() };
    if (!tw.canSendNow && tw.nextAllowedAt !== undefined) {
      const until = tw.nextAllowedAt;
      if (!roundWindowAt(until)) {
        markUnfilled(
          "too_close",
          `${TOO_CLOSE_REASON}: texting hours start at ${tw.nextAllowedLabel}, too close to the ${tw.cutoffLabel} cutoff ` +
            `(offers stop ${minutesText(stopMinutes)} before it starts).`,
        );
        return;
      }
      const text = `Scheduled — texts go out at ${tw.nextAllowedLabel} (outside texting hours)`;
      if (s.scheduled?.until !== until) {
        s.scheduled = { until, untilLabel: tw.nextAllowedLabel ?? "", text };
        log("scheduled", `${text}. Texting hours are ${TEXTING_HOURS.label}; round ${s.roundsSent + 1} waits until then.`);
      }
      // Durable timer: survives Worker restarts. Cancel (or a late-yes Book) ends the wait early.
      await condition(() => s.status !== "offering", Math.max(1, until - Date.now()));
      s.scheduled = null;
      if (s.status === "offering") log("texting_hours", "Texting hours have started — sending the next round.");
      return; // the main loop calls runRound again, re-checking the cutoff and texting hours
    }
    s.scheduled = null;

    const roundWindow = roundWindowAt(Date.now());
    if (!roundWindow) {
      markUnfilled(
        "too_close",
        `${TOO_CLOSE_REASON}: less than ${MIN_CAPPED_REPLY_WINDOW_MINUTES} minutes would be left to reply before the ` +
          `${tw.cutoffLabel ?? "cutoff"} cutoff (offers stop ${minutesText(stopMinutes)} before it starts).`,
      );
      return;
    }
    const windowMs = roundWindow.ms;
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
            ? "Everyone approved was offered it or can't be texted now (booked, removed, or not opted in to texts), and nobody said yes."
            : "Everyone approved was offered it and nobody said yes.",
      );
      return;
    }
    // Busy people (holding another opening's offer) keep their place for the next round.
    if (busyNow.length) requeueFront(busyNow);

    s.roundsSent += 1;
    const roundNo = s.roundsSent;
    const now = Date.now();
    let offers: Offer[] = picked.map(({ clientId, ref }) => {
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

    // The texts must be out in time for the window they promise: by (cutoff − window), so the deadline
    // never passes the cutoff, and before texting hours end (unless same-day / Fast demo). A slow send
    // (gateway retries, Worker down) past that point is abandoned and the round is re-planned.
    const sendByCutoff = s.offeringCutoffAt !== undefined ? s.offeringCutoffAt - windowMs : Infinity;
    const sendBy = Math.min(sendByCutoff, tw.hoursEndAt ?? Infinity);
    let sent: { deliveredAt: number; texts?: Record<string, string>; skipped?: { clientId: string; name: string; reason: string }[] } | "late";
    const scope = new CancellationScope();
    sendScope = scope;
    try {
      sent = await scope.run(() => {
        const send = texts.sendOfferTexts({
          opening: s.opening,
          offers: offers.map(({ offerId, clientId, name, mobile, token }) => ({ offerId, clientId, name, mobile, token })),
          simulateFailure: s.opening.simulateTextFailure,
          replyWindowSeconds: windowMs / 1000,
          ...(Number.isFinite(sendBy) ? { notAfter: sendBy } : {}),
        });
        if (!Number.isFinite(sendBy)) return send;
        const late = sleep(Math.max(1, sendBy - Date.now())).then(() => "late" as const);
        return Promise.race([send, late]);
      });
      if (Number.isFinite(sendBy)) scope.cancel(); // stop the losing timer / the abandoned send
    } catch (error) {
      if (isCancellation(error)) {
        log("send_stopped", `Round ${roundNo}: stopped sending texts (the opening changed).`);
        return;
      }
      // The Activity itself refused because it ran too late (e.g. after retries): same as the timer winning.
      if (!(error instanceof ActivityFailure && error.cause instanceof ApplicationFailure && error.cause.type === "SendTooLate")) {
        throw error;
      }
      sent = "late";
    } finally {
      if (sendScope === scope) sendScope = undefined;
    }
    if (s.status !== "offering") return;

    // Nobody was texted: put this round's people back in line and re-plan (cutoff and texting hours are re-checked).
    const unsend = (dropped: Offer[]) => {
      const ids = new Set(dropped.map((o) => o.offerId));
      s.offers = s.offers.filter((o) => !ids.has(o.offerId));
      background(
        quick.releaseReservations({ openingId, releases: dropped.map((o) => ({ clientId: o.clientId, ref: o.reservationRef! })) }),
      );
    };
    if (sent === "late") {
      unsend(offers);
      requeueFront(offers.map((o) => o.clientId));
      s.roundsSent -= 1;
      s.currentRound = null;
      log(
        "send_late",
        `Round ${roundNo}: the texts couldn't be sent in time (${
          sendBy === sendByCutoff ? `replies would have run past the ${tw.cutoffLabel ?? "start-time"} cutoff` : "texting hours ended"
        }), so nobody was texted. Checking again.`,
      );
      return;
    }

    // Consent is re-checked at send time: anyone recorded as opted out since they were picked isn't texted.
    if (sent.skipped?.length) {
      const skippedIds = new Set(sent.skipped.map((x) => x.clientId));
      unsend(offers.filter((o) => skippedIds.has(o.clientId)));
      offers = offers.filter((o) => !skippedIds.has(o.clientId));
      for (const x of sent.skipped) log("skipped", `Skipped ${x.name}: ${x.reason} — not texted.`);
      if (!offers.length) {
        s.roundsSent -= 1;
        s.currentRound = null;
        if (s.queue.length === 0) markUnfilled("exhausted", "Everyone approved was offered it or can't be texted now, and nobody said yes.");
        return;
      }
    }

    // The reply window starts only once the texts are actually out — and never runs past the cutoff.
    const sentAt = Date.now();
    const deadline = Math.min(sentAt + windowMs, s.offeringCutoffAt ?? Infinity);
    const capped = roundWindow.capped || deadline < sentAt + windowMs;
    const actualWindowSeconds = Math.round((deadline - sentAt) / 1000); // what the client really gets
    for (const o of offers) {
      if (o.status !== "sending") continue;
      o.status = "live";
      o.sentAt = sentAt;
      o.deliveredAt = sent.deliveredAt;
      o.smsText = sent.texts?.[o.offerId];
      o.deadline = deadline;
      o.replyWindowSeconds = actualWindowSeconds;
      o.windowCapped = capped;
    }
    s.currentRound = {
      number: roundNo,
      offerIds: offers.map((o) => o.offerId),
      sentAt,
      deadline,
      replyWindowSeconds: actualWindowSeconds,
      windowCapped: capped,
    };
    log(
      "sent",
      `Round ${roundNo}: simulated texts sent to ${names(offers)} — ${formatWindow(actualWindowSeconds)} reply window starts now` +
        (capped
          ? ` (shortened from ${formatWindowSeconds(s.opening.replyWindowSeconds)} so replies close by the ${tw.cutoffLabel ?? "start-time"} cutoff).`
          : "."),
    );

    await condition(() => s.status !== "offering" || offers.every((o) => o.status !== "live"), Math.max(1, deadline - Date.now()));
    if (s.status !== "offering") return;

    const noReply = offers.filter((o) => o.status === "live");
    if (noReply.length) {
      noReply.forEach((o) => (o.status = "timed_out"));
      log("timed_out", `No reply (timed out): ${names(noReply)}. Simulated "offer expired" text sent; they stay on the waitlist.`);
      // Not awaited: the next round must not wait on (or race with) the expiry notice.
      notice(quick.notifyTimedOut({ opening: s.opening, recipients: noReply.map(recipient) }));
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
    s.scheduled = null;
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
    if (others.length) log("told_filled", `Simulated text to ${names(others)}: already filled, still on the waitlist.`);
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
    notice(quick.notifyHoldReleased({ opening: s.opening, recipients: [recipient(w)] }));
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
    s.scheduled = null;
    s.unfilledReason = reason;
    const stopped = kind === "too_close" || kind === "time_passed";
    log(
      "unfilled",
      `${kind === "no_matches" ? "No matches" : stopped ? "Stopped offering" : "Nobody took it"} — ${reason} ` +
        (stopped ? "Leave it open?" : "Keep trying or leave it open?"),
    );
    staffAlert(
      kind === "no_matches"
        ? `No one on the waitlist matches the ${describe()}. Check again or leave it open.`
        : kind === "too_close"
          ? `Stopped offering the ${describe()}: too close to the start time to offer it.`
          : kind === "time_passed"
            ? `Stopped offering the ${describe()}: the appointment time has passed.`
            : `Nobody took the ${describe()}. Keep trying or leave it open?`,
    );
  }

  /** Start-time cutoff (Lena: enough time for the client to get here). Marks it unfilled when outreach must stop. */
  function tooLateToOffer(): boolean {
    const now = Date.now();
    if (s.opening.startsAtMs !== undefined && now >= s.opening.startsAtMs) {
      markUnfilled("time_passed", "The appointment time has passed, so outreach stopped.");
      return true;
    }
    if (s.offeringCutoffAt !== undefined && now >= s.offeringCutoffAt) {
      markUnfilled("too_close", `${TOO_CLOSE_REASON}: offers stop ${minutesText(stopMinutes)} before it starts, and that time has passed.`);
      return true;
    }
    return false;
  }

  /**
   * The reply window a round starting at `at` gets: the opening's setting, shortened (to whole minutes)
   * so its deadline never passes the cutoff. null = too close (under MIN_CAPPED_REPLY_WINDOW_MINUTES left).
   */
  function roundWindowAt(at: number): { ms: number; capped: boolean } | null {
    const full = s.opening.replyWindowSeconds * 1000;
    if (s.offeringCutoffAt === undefined) return { ms: full, capped: false };
    const left = s.offeringCutoffAt - at - SEND_MARGIN_MS;
    if (left >= full) return { ms: full, capped: false };
    const ms = Math.floor(left / 60_000) * 60_000;
    if (ms < MIN_CAPPED_REPLY_WINDOW_MINUTES * 60_000) return null;
    return { ms, capped: true };
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
    send: (args: { opening: OpeningInput; recipients: { clientId: string; name: string; mobile: string }[] }) => Promise<NoticeResult>,
  ) {
    const todo = s.offers.filter((o) => o.status === status && !o.notifiedAt);
    if (!todo.length) return;
    const at = Date.now();
    todo.forEach((o) => (o.notifiedAt = at));
    notice(send({ opening: s.opening, recipients: todo.map(recipient) }));
  }

  /** A follow-up client text; the Activity skips anyone who opted out (or came off the list) since — logged here. */
  function notice(p: Promise<NoticeResult>) {
    background(
      p.then((r) => {
        for (const x of r?.skipped ?? []) log("not_texted", `Didn't text ${x.name} about this opening any more: ${x.reason}.`);
      }),
    );
  }

  function describe() {
    return `${s.opening.service} with ${s.opening.stylist} (${formatSlot(s.opening.startsAt)})`;
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
  const state: WaitlistState = initial ? upgradeWaitlistState(initial) : { source: SAMPLE_SOURCE, clients: sampleWaitlist() };
  const find = (id: string) => state.clients.find((c) => c.id === id);
  const nowIso = () => new Date(Date.now()).toISOString(); // Workflow clock: deterministic
  const fail = (message: string, type = "WaitlistRefused") => ApplicationFailure.nonRetryable(message, type);
  const result = (client: WaitlistClient, message: string): WaitlistActionResult => ({ ok: true, message, client });
  const notFound = () => fail("That person isn't on the waitlist.", "WaitlistClientNotFound");
  /** Texting consent belongs to the phone number: every entry with the same number shares one answer. */
  const sameNumber = (mobile: string) => state.clients.filter((c) => mobileDigits(c.mobile) === mobileDigits(mobile));
  const setConsent = (c: WaitlistClient, consent: WaitlistClient["textingConsent"], at: string, source: string) => {
    c.textingConsent = consent;
    c.consentRecordedAt = consent === "not_asked" ? undefined : at;
    c.consentSource = consent === "not_asked" ? undefined : source;
  };
  const others = (n: number) => `${n} other waitlist entr${n === 1 ? "y" : "ies"} with this number`;

  const apply = ({ clientId, openingId }: MarkBookedInput): MarkBookedResult => {
    const client = find(clientId);
    if (!client) return { applied: false, reason: "client not on the waitlist" };
    if (client.status === "removed") return { applied: false, reason: "removed from the waitlist (asked to come off)" };
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
    const blockedNumbers = optedOutNumbers(state.clients);
    for (const id of clientIds) {
      const c = find(id);
      if (!c) result.refused.push({ clientId: id, reason: "no longer on the waitlist", retryLater: false });
      else if (c.status === "removed") {
        result.refused.push({ clientId: id, reason: "removed from the waitlist (asked to come off)", retryLater: false });
      } else if (c.status === "booked") {
        result.refused.push({ clientId: id, reason: `already booked (${c.bookedOpeningId})`, retryLater: false });
      } else if (c.textingConsent !== "opted_in") {
        // Only opted-in clients are ever texted.
        result.refused.push({
          clientId: id,
          reason: c.textingConsent === "opted_out" ? "opted out of texts" : "hasn't been asked about texts yet",
          retryLater: false,
        });
      } else if (blockedNumbers.has(mobileDigits(c.mobile))) {
        result.refused.push({ clientId: id, reason: "opted out of texts (on another waitlist entry with the same number)", retryLater: false });
      } else if (c.reservedBy && c.reservedBy.openingId !== openingId && c.reservedBy.until > now) {
        result.refused.push({ clientId: id, reason: `holding a live offer for ${c.reservedBy.openingId}`, retryLater: true });
      } else {
        c.reservedBy = { openingId, ref, until };
        result.granted.push(id);
      }
    }
    return result;
  });

  // ----- Staff: Add to waitlist (back of the line) -----
  setHandler(
    addClient,
    (raw): WaitlistActionResult => {
      const checked = checkAddClientInput(raw);
      if (!checked.ok) throw fail(checked.errors[0].message, "InvalidWaitlistInput"); // validator already ran
      const v = checked.value;
      const maxNo = state.clients.reduce((m, c) => Math.max(m, Number(/^c(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
      const at = nowIso();
      // One answer per phone number. "Didn't ask" keeps the number's existing answer (newest wins);
      // a Yes / No given now is applied to every entry with this number.
      const siblings = sameNumber(v.mobile);
      const known = siblings
        .filter((c) => c.textingConsent !== "not_asked")
        .sort((a, b) => ((a.consentRecordedAt ?? "") < (b.consentRecordedAt ?? "") ? 1 : -1))[0];
      const inherited = v.textingConsent === "not_asked" && known ? known : undefined;
      const consent = inherited ? inherited.textingConsent : v.textingConsent;
      let changed = 0;
      if (!inherited && consent !== "not_asked") {
        for (const c of siblings) {
          if (c.textingConsent === consent) continue;
          setConsent(c, consent, at, "Updated when this number was added again");
          changed++;
        }
      }
      const client: WaitlistClient = {
        id: `c${String(maxNo + 1).padStart(2, "0")}`,
        name: v.name,
        mobile: v.mobile,
        service: v.service,
        stylistRule: v.stylistRule,
        availabilityNote: v.availabilityNote,
        availabilityTags: parseAvailability(v.availabilityNote),
        joinedAt: at, // now => back of the line
        status: "waiting",
        textingConsent: consent,
        ...(inherited
          ? { consentRecordedAt: inherited.consentRecordedAt, consentSource: `Same number as ${inherited.name}'s entry` }
          : consent === "not_asked"
            ? {}
            : { consentRecordedAt: at, consentSource: "Asked when they joined" }),
      };
      state.clients.push(client);
      const note = inherited
        ? ` This number already had an answer, so it was kept.`
        : changed
          ? ` Also updated the texting answer on ${others(changed)}.`
          : "";
      return result(
        client,
        `${client.name} added to the waitlist for ${client.service} (back of the line). ${CONSENT_LABELS[client.textingConsent]}.${note}`,
      );
    },
    {
      validator: (raw) => {
        const checked = checkAddClientInput(raw);
        if (!checked.ok) throw fail(checked.errors.map((e) => e.message).join(" "), "InvalidWaitlistInput");
        const v = checked.value;
        const dup = state.clients.find(
          (c) => c.status !== "removed" && c.service === v.service && mobileDigits(c.mobile) === mobileDigits(v.mobile),
        );
        if (dup) throw fail(`${dup.name} (${dup.mobile}) is already on the waitlist for ${dup.service}.`, "DuplicateWaitlistEntry");
      },
    },
  );

  // ----- Staff: Remove from waitlist (only when the client asked) -----
  setHandler(
    removeClient,
    ({ clientId, reason }): WaitlistActionResult => {
      const c = find(clientId)!;
      c.status = "removed";
      c.removedAt = nowIso();
      c.removedReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : undefined;
      c.reservedBy = undefined;
      return result(c, `${c.name} was removed from the waitlist. They won't be offered openings.`);
    },
    {
      validator: ({ clientId }) => {
        const c = typeof clientId === "string" ? find(clientId) : undefined;
        if (!c) throw notFound();
        if (c.status === "removed") throw fail(`${c.name} was already removed from the waitlist.`);
        if (c.status === "booked") {
          throw fail(
            `${c.name} was booked from an opening, so they're already off the waiting list. ` +
              `If that hold is released before it's confirmed, they come back with their place and can be removed then.`,
          );
        }
        if (c.reservedBy && c.reservedBy.until > Date.now()) {
          throw fail(`${c.name} has a live offer right now. Cancel or finish their current offer first.`);
        }
      },
    },
  );

  // ----- Staff: record the answer to "Can we text you about earlier openings?" -----
  setHandler(
    recordConsent,
    ({ clientId, textingConsent }): WaitlistActionResult => {
      const c = find(clientId)!;
      const at = nowIso();
      // Consent belongs to the phone number: the answer applies to every entry with it.
      const siblings = sameNumber(c.mobile).filter((x) => x !== c && x.textingConsent !== textingConsent);
      setConsent(c, textingConsent, at, "Recorded by staff");
      for (const x of siblings) setConsent(x, textingConsent, at, `Recorded by staff (same number as ${c.name})`);
      // An opt-out takes effect at once: the opening Workflows re-check consent before every client text.
      return result(
        c,
        (textingConsent === "opted_in"
          ? `${c.name} opted in — they can be offered openings by text.`
          : `${c.name} opted out — they won't get any more texts.`) + (siblings.length ? ` Also updated ${others(siblings.length)}.` : ""),
      );
    },
    {
      validator: ({ clientId, textingConsent }) => {
        const c = typeof clientId === "string" ? find(clientId) : undefined;
        if (!c) throw notFound();
        if (c.status === "removed") throw fail(`${c.name} was removed from the waitlist.`);
        if (textingConsent !== "opted_in" && textingConsent !== "opted_out") {
          throw fail("Choose Opted in or Opted out.", "InvalidWaitlistInput");
        }
      },
    },
  );

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

/** Old service names from earlier versions of the sample sheet. */
const LEGACY_SERVICES: Record<string, Service> = { Highlights: "Color", Trim: "Haircut" };

/**
 * Bring a waitlist carried over by continue-as-new from an earlier version up to date:
 * the old optedOut flag becomes textingConsent (unknown => "not_asked", never texted), and
 * Highlights / Trim become Color / Haircut. Pure, so it is deterministic on replay.
 */
function upgradeWaitlistState(st: WaitlistState): WaitlistState {
  const sample = new Map(st.source === SAMPLE_SOURCE ? sampleWaitlist().map((c) => [c.id, c] as const) : []);
  return {
    ...st,
    clients: st.clients.map((raw) => {
      const { optedOut, ...c } = raw as WaitlistClient & { optedOut?: boolean };
      const service = LEGACY_SERVICES[c.service] ?? c.service;
      if (c.textingConsent) return { ...c, service };
      const fromSheet = sample.get(c.id);
      const textingConsent = optedOut ? "opted_out" : (fromSheet?.textingConsent ?? "not_asked");
      return {
        ...c,
        service,
        textingConsent,
        ...(textingConsent !== "not_asked" ? { consentRecordedAt: c.joinedAt, consentSource: "Asked when they joined" } : {}),
      };
    }),
  };
}
