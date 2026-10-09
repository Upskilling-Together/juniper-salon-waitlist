// Activities: everything that talks to the outside world (the waitlist Workflow
// and the SIMULATED text-message gateway).
import { ApplicationFailure, Context, log } from "@temporalio/activity";
import { formatSlot, formatWindowSeconds } from "./format";
import { computeSuggestions, notTextableReason } from "./matching";
import {
  getWaitlist,
  markBooked,
  releaseBooking,
  releaseReservations as releaseReservationsUpdate,
  reserveForOffers as reserveForOffersUpdate,
  WAITLIST_WORKFLOW_ID,
} from "./messages";
import { ensureWaitlist, getClient, waitlistSource } from "./temporal";
import { computeTextingWindow } from "./textingHours";
import type {
  MarkBookedInput,
  MarkBookedResult,
  OpeningInput,
  ReleaseInput,
  ReserveInput,
  ReserveResult,
  Suggestion,
  TextingWindow,
} from "./types";

/** Every "text" in this prototype is only logged — this label makes that unmistakable. */
const SIMULATED = "[SIMULATED TEXT — NOT SENT]";

const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

async function waitlistHandle() {
  const client = await getClient();
  await ensureWaitlist(client);
  return client.workflow.getHandle(WAITLIST_WORKFLOW_ID);
}

/** Suggested matches from the CURRENT waitlist, skipping people currently being offered another opening. */
export async function suggestMatches(
  opening: OpeningInput,
  excludeClientIds: string[],
  /** Keep trying: texted before for this opening with no reply — listed after people never texted. */
  textedBeforeIds: string[] = [],
): Promise<Suggestion[]> {
  const waitlist = await (await waitlistHandle()).query(getWaitlist);
  const now = Date.now();
  const busy = waitlist.clients
    .filter((c) => c.reservedBy && c.reservedBy.openingId !== opening.openingId && c.reservedBy.until > now)
    .map((c) => c.id);
  return computeSuggestions(waitlist.clients, opening, { excludeClientIds, busyClientIds: busy, textedBeforeIds });
}

/**
 * Consent is re-checked right before EVERY client text (offers and follow-up notices): staff may have
 * recorded an opt-out after the client was reserved or while their offer was live.
 * Returns clientId -> reason for anyone who must not be texted now.
 */
async function notTextable(clientIds: string[]): Promise<Map<string, string>> {
  if (!clientIds.length) return new Map();
  const clients = await waitlistSource.load();
  const blocked = new Map<string, string>();
  for (const id of clientIds) {
    const reason = notTextableReason(clients, id);
    if (reason) blocked.set(id, reason);
  }
  return blocked;
}

export type TextSkip = { clientId: string; name: string; reason: string };

/**
 * Just before a round goes out: atomically reserve these clients in the waitlist Workflow.
 * Refused = booked, removed, not opted in to texts, or holding another opening's live offer.
 */
export async function reserveForOffers(input: ReserveInput): Promise<ReserveResult> {
  return (await waitlistHandle()).executeUpdate(reserveForOffersUpdate, { args: [input] });
}

/** Free reservations once those offers are no longer live (declined, timed out, told filled/cancelled). */
export async function releaseReservations(input: ReleaseInput): Promise<{ released: number }> {
  return (await waitlistHandle()).executeUpdate(releaseReservationsUpdate, { args: [input] });
}

export type OfferText = { offerId: string; clientId: string; name: string; mobile: string; token: string };

function offerLink(openingId: string, clientId: string, token: string): string {
  return `${APP_BASE_URL}/offer.html?o=${encodeURIComponent(openingId)}&c=${encodeURIComponent(clientId)}&t=${encodeURIComponent(token)}`;
}

/**
 * Salon-local texting hours check. The Workflow passes its own (deterministic) clock as nowMs;
 * only this Activity turns that into salon local time, so Workflow code never reads a timezone.
 */
export async function textingWindow(input: {
  openingId: string;
  nowMs: number;
  startsAt: string;
  fastDemo: boolean;
  cutoffAt?: number;
}): Promise<TextingWindow> {
  return computeTextingWindow(input);
}

/**
 * SIMULATED SMS — just logs. Demo options: fail the first attempt (the retry shows up in Event History),
 * or fail every attempt (Temporal keeps retrying; the dashboard warns staff and Cancel stops it).
 */
export async function sendOfferTexts(input: {
  opening: OpeningInput;
  offers: OfferText[];
  simulateFailure: boolean;
  /** Demo: fail every attempt ("Simulate texts failing (keeps retrying)"). */
  keepFailing?: boolean;
  /** This round's actual reply window (shorter than the opening's when capped by the start-time cutoff). */
  replyWindowSeconds?: number;
  /**
   * Don't send after this time (epoch ms): past it the promised reply window would run beyond the
   * start-time cutoff, or texting hours have ended. The Workflow also stops waiting at that point.
   */
  notAfter?: number;
}): Promise<{ deliveredAt: number; texts: Record<string, string>; skipped?: TextSkip[] }> {
  const { attempt } = Context.current().info;
  if (input.notAfter !== undefined && Date.now() > input.notAfter) {
    throw ApplicationFailure.nonRetryable("Too late to send these offer texts — nothing was sent.", "SendTooLate");
  }
  if (input.keepFailing) {
    log.warn(`Simulated SMS gateway outage on attempt ${attempt} — nothing was sent; Temporal will retry.`);
    throw ApplicationFailure.retryable("Simulated SMS gateway outage — the text provider isn't accepting messages", "SimulatedSmsOutage");
  }
  if (input.simulateFailure && attempt === 1) {
    throw ApplicationFailure.retryable("Simulated SMS gateway hiccup on the first attempt", "SimulatedSmsFailure");
  }
  const { opening } = input;
  const blocked = await notTextable(input.offers.map((o) => o.clientId));
  const skipped: TextSkip[] = input.offers
    .filter((o) => blocked.has(o.clientId))
    .map((o) => ({ clientId: o.clientId, name: o.name, reason: blocked.get(o.clientId)! }));
  const texts: Record<string, string> = {};
  for (const o of input.offers) {
    if (blocked.has(o.clientId)) continue;
    const text =
      `Juniper Salon: a ${opening.service} with ${opening.stylist} just opened up — ${formatSlot(opening.startsAt)} ` +
      `(${opening.durationMinutes} min). Reply within ${formatWindowSeconds(input.replyWindowSeconds ?? opening.replyWindowSeconds)} — ` +
      `late replies aren't guaranteed the appointment: ` +
      offerLink(opening.openingId, o.clientId, o.token);
    texts[o.offerId] = text;
    log.info(`${SIMULATED} to ${o.name} ${o.mobile} (attempt ${attempt}): ${text}`);
    console.log(`${SIMULATED} to ${o.name} ${o.mobile}: ${text}`);
  }
  return { deliveredAt: Date.now(), texts, skipped };
}

type Recipients = { opening: OpeningInput; recipients: { clientId: string; name: string; mobile: string }[] };
/** Follow-up notices skip anyone who opted out (or came off the list) since their offer went out. */
export type NoticeResult = { skipped: TextSkip[] };

async function sms(recipients: Recipients["recipients"], text: string): Promise<NoticeResult> {
  const blocked = await notTextable(recipients.map((r) => r.clientId));
  const skipped: TextSkip[] = [];
  for (const r of recipients) {
    const reason = blocked.get(r.clientId);
    if (reason) skipped.push({ clientId: r.clientId, name: r.name, reason });
    else console.log(`${SIMULATED} to ${r.name} ${r.mobile}: ${text}`);
  }
  return { skipped };
}

export async function notifyFilled({ opening, recipients }: Recipients): Promise<NoticeResult> {
  return sms(recipients, `Juniper Salon: the ${formatSlot(opening.startsAt)} ${opening.service} has already been filled — you're still on the waitlist.`);
}

export async function notifyCancelled({ opening, recipients }: Recipients): Promise<NoticeResult> {
  return sms(recipients, `Juniper Salon: the ${formatSlot(opening.startsAt)} ${opening.service} is no longer available — you're still on the waitlist.`);
}

export async function notifyTimedOut({ opening, recipients }: Recipients): Promise<NoticeResult> {
  return sms(recipients, `Juniper Salon: the ${formatSlot(opening.startsAt)} offer has expired — no worries, you're still on the waitlist.`);
}

export async function notifyHoldReleased({ opening, recipients }: Recipients): Promise<NoticeResult> {
  return sms(
    recipients,
    `Juniper Salon: we weren't able to confirm the ${formatSlot(opening.startsAt)} ${opening.service}, so it has been released — you're still on the waitlist.`,
  );
}

/** SIMULATED text to each staff member (Lena and Carla), so they hear about it while they're with a client. */
export async function notifyStaff({
  text,
  recipients,
}: {
  opening: OpeningInput;
  text: string;
  recipients: ReadonlyArray<{ name: string; mobile: string }>;
}): Promise<void> {
  for (const r of recipients) {
    console.log(`${SIMULATED} to ${r.name} ${r.mobile} (staff): Juniper refill: ${text} ${APP_BASE_URL}/`);
  }
}

/** Tell the waitlist Workflow this client is booked (first booking wins). */
export async function markClientBooked(input: MarkBookedInput): Promise<MarkBookedResult> {
  return (await waitlistHandle()).executeUpdate(markBooked, { args: [input] });
}

/** The hold was released: put the client back to "waiting" (they keep their place). */
export async function releaseClientBooking(input: MarkBookedInput): Promise<MarkBookedResult> {
  return (await waitlistHandle()).executeUpdate(releaseBooking, { args: [input] });
}
