// Activities: everything that talks to the outside world (the waitlist Workflow
// and the SIMULATED text-message gateway).
import { ApplicationFailure, Context, log } from "@temporalio/activity";
import { formatSlot, formatWindowSeconds } from "./format";
import { computeSuggestions } from "./matching";
import {
  getWaitlist,
  markBooked,
  releaseBooking,
  releaseReservations as releaseReservationsUpdate,
  reserveForOffers as reserveForOffersUpdate,
  WAITLIST_WORKFLOW_ID,
} from "./messages";
import { ensureWaitlist, getClient } from "./temporal";
import type {
  MarkBookedInput,
  MarkBookedResult,
  OpeningInput,
  ReleaseInput,
  ReserveInput,
  ReserveResult,
  Suggestion,
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
export async function suggestMatches(opening: OpeningInput, excludeClientIds: string[]): Promise<Suggestion[]> {
  const waitlist = await (await waitlistHandle()).query(getWaitlist);
  const now = Date.now();
  const busy = waitlist.clients
    .filter((c) => c.reservedBy && c.reservedBy.openingId !== opening.openingId && c.reservedBy.until > now)
    .map((c) => c.id);
  return computeSuggestions(waitlist.clients, opening, { excludeClientIds, busyClientIds: busy });
}

/**
 * Just before a round goes out: atomically reserve these clients in the waitlist Workflow.
 * Refused = booked, opted out, or holding another opening's live offer.
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

/** SIMULATED SMS — just logs. Optionally fails the first attempt so the retry shows up in Event History. */
export async function sendOfferTexts(input: {
  opening: OpeningInput;
  offers: OfferText[];
  simulateFailure: boolean;
}): Promise<{ deliveredAt: number; texts: Record<string, string> }> {
  const { attempt } = Context.current().info;
  if (input.simulateFailure && attempt === 1) {
    throw ApplicationFailure.retryable("Simulated SMS gateway hiccup on the first attempt", "SimulatedSmsFailure");
  }
  const { opening } = input;
  const texts: Record<string, string> = {};
  for (const o of input.offers) {
    const text =
      `Juniper Salon: a ${opening.service} with ${opening.stylist} just opened up — ${formatSlot(opening.startsAt)} ` +
      `(${opening.durationMinutes} min). Reply within ${formatWindowSeconds(opening.replyWindowSeconds)} — ` +
      `late replies aren't guaranteed the appointment: ` +
      offerLink(opening.openingId, o.clientId, o.token);
    texts[o.offerId] = text;
    log.info(`${SIMULATED} to ${o.name} ${o.mobile} (attempt ${attempt}): ${text}`);
    console.log(`${SIMULATED} to ${o.name} ${o.mobile}: ${text}`);
  }
  return { deliveredAt: Date.now(), texts };
}

type Recipients = { opening: OpeningInput; recipients: { name: string; mobile: string }[] };

function sms(recipients: Recipients["recipients"], text: string) {
  for (const r of recipients) console.log(`${SIMULATED} to ${r.name} ${r.mobile}: ${text}`);
}

export async function notifyFilled({ opening, recipients }: Recipients): Promise<void> {
  sms(recipients, `Juniper Salon: the ${formatSlot(opening.startsAt)} ${opening.service} has already been filled — you're still on the waitlist.`);
}

export async function notifyCancelled({ opening, recipients }: Recipients): Promise<void> {
  sms(recipients, `Juniper Salon: the ${formatSlot(opening.startsAt)} ${opening.service} is no longer available — you're still on the waitlist.`);
}

export async function notifyTimedOut({ opening, recipients }: Recipients): Promise<void> {
  sms(recipients, `Juniper Salon: the ${formatSlot(opening.startsAt)} offer has expired — no worries, you're still on the waitlist.`);
}

export async function notifyHoldReleased({ opening, recipients }: Recipients): Promise<void> {
  sms(
    recipients,
    `Juniper Salon: we weren't able to confirm the ${formatSlot(opening.startsAt)} ${opening.service}, so it has been released — you're still on the waitlist.`,
  );
}

/** SIMULATED text to the salon phone, so Lena/Carla hear about it while they're with a client. */
export async function notifyStaff({ text }: { opening: OpeningInput; text: string }): Promise<void> {
  console.log(`${SIMULATED} to salon phone (staff): Juniper refill: ${text} ${APP_BASE_URL}/`);
}

/** Tell the waitlist Workflow this client is booked (first booking wins). */
export async function markClientBooked(input: MarkBookedInput): Promise<MarkBookedResult> {
  return (await waitlistHandle()).executeUpdate(markBooked, { args: [input] });
}

/** The hold was released: put the client back to "waiting" (they keep their place). */
export async function releaseClientBooking(input: MarkBookedInput): Promise<MarkBookedResult> {
  return (await waitlistHandle()).executeUpdate(releaseBooking, { args: [input] });
}
