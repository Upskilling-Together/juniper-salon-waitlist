// What a client sees on their offer page — derived purely from the opening's state,
// so it works for running Workflows and for ones that have already closed.
import { formatSlot } from "./format";
import { ACCEPT_AFTER_OWN_DEADLINE } from "./rules";
import { CLIENT_MESSAGES, FILLED_NOTICE, LATE_YES_MESSAGE, type OpeningState, type RespondOutcome } from "./types";

export type ClientOfferView =
  | { valid: false }
  | {
      valid: true;
      firstName: string;
      service: string;
      stylist: string;
      startsAt: string;
      when: string;
      durationMinutes: number;
      deadline?: number;
      fastDemo: boolean;
      /** How many people were offered this round (the "first yes wins" line only shows when > 1). */
      roundSize: number;
      canRespond: boolean;
      outcome?: RespondOutcome | "filled_notice";
      message?: string;
    };

export function clientOfferView(state: OpeningState, clientId: string, token: string, now: number): ClientOfferView {
  // The token proves who the client is; if they were re-texted (Keep trying / a released hold),
  // any of their links shows their LATEST offer for this opening — same rule as the respond Update.
  if (!state.offers.some((o) => o.clientId === clientId && o.token === token)) return { valid: false };
  const offer = [...state.offers].reverse().find((o) => o.clientId === clientId)!;
  const base = {
    valid: true as const,
    firstName: offer.name.split(" ")[0],
    service: state.opening.service,
    stylist: state.opening.stylist,
    startsAt: state.opening.startsAt,
    when: formatSlot(state.opening.startsAt),
    durationMinutes: state.opening.durationMinutes,
    deadline: offer.deadline,
    fastDemo: state.opening.fastDemo,
    roundSize: state.offers.filter((o) => o.round === offer.round).length,
  };
  const done = (outcome: RespondOutcome | "filled_notice", message: string) => ({ ...base, canRespond: false, outcome, message });

  if (state.winner?.offerId === offer.offerId) return done("booked", CLIENT_MESSAGES.booked);
  if (state.status === "cancelled" || offer.status === "told_cancelled") {
    return done("no_longer_available", CLIENT_MESSAGES.no_longer_available);
  }
  if (offer.status === "released") return done("hold_released", CLIENT_MESSAGES.hold_released);
  if (offer.lateReply === "expired") return done("expired", LATE_YES_MESSAGE);
  if (offer.lateReply) return done(offer.lateReply, CLIENT_MESSAGES[offer.lateReply]);
  if (offer.status === "declined") return done("declined", CLIENT_MESSAGES.declined);
  if (offer.status === "told_filled" || state.status === "filled") return done("filled_notice", FILLED_NOTICE);
  if (state.status === "left_open") return done("no_longer_available", CLIENT_MESSAGES.no_longer_available);
  if (offer.status === "sending") return done("not_ready", CLIENT_MESSAGES.not_ready);
  const pastDeadline = offer.status === "timed_out" || (offer.deadline !== undefined && now >= offer.deadline);
  if (pastDeadline && !ACCEPT_AFTER_OWN_DEADLINE) return done("expired", CLIENT_MESSAGES.expired);
  return { ...base, canRespond: true };
}
