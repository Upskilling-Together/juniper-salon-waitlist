// Shared data types for the Juniper Salon waitlist-refill prototype.
// Everything here is plain data so it can cross Workflow / Activity / API boundaries.

export const SERVICES = ["Haircut", "Color", "Highlights", "Blowout", "Trim"] as const;
export type Service = (typeof SERVICES)[number];

export const STYLISTS = ["Lena", "Carla", "Sam"] as const;
export type Stylist = (typeof STYLISTS)[number];

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Day = (typeof DAYS)[number];

export const PARTS_OF_DAY = ["morning", "afternoon", "evening"] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

/** A client either REQUIRES one stylist, or takes ANY stylist (optionally preferring one). */
export type StylistRule =
  | { kind: "required"; stylist: Stylist }
  | { kind: "any"; preferred?: Stylist };

/** Rough tags parsed from the free-text note. Empty arrays mean "not stated". */
export type AvailabilityTags = {
  days: Day[];
  parts: PartOfDay[];
};

export type WaitlistClient = {
  id: string;
  name: string;
  mobile: string;
  service: Service;
  stylistRule: StylistRule;
  /** Exactly as staff wrote it in the Google Sheet. */
  availabilityNote: string;
  /** Parsed from the note; used ONLY for rough matching. */
  availabilityTags: AvailabilityTags;
  /** ISO timestamp — earliest joiner is offered first. */
  joinedAt: string;
  status: "waiting" | "booked";
  /** Client asked not to be texted: never suggested, never offered (shown as opted out). */
  optedOut?: boolean;
  bookedOpeningId?: string;
  bookedAt?: number;
  /**
   * Set atomically by the waitlist Workflow when an opening is about to text this client,
   * so two openings can never offer the same person at once. Expires as a safety net.
   */
  reservedBy?: { openingId: string; ref: string; until: number };
};

export type WaitlistState = {
  source: string;
  clients: WaitlistClient[];
};

export type MarkBookedInput = { clientId: string; openingId: string };
export type MarkBookedResult = { applied: boolean; reason?: string };

export type ReserveInput = { openingId: string; ref: string; clientIds: string[]; until: number };
export type ReserveResult = {
  granted: string[];
  /** retryLater: busy with another opening's offer right now (may free up); otherwise permanent for this opening. */
  refused: { clientId: string; reason: string; retryLater: boolean }[];
};
export type ReleaseInput = { openingId: string; releases: { clientId: string; ref: string }[] };

/** What staff typed when creating an opening. */
export type OpeningInput = {
  openingId: string;
  service: Service;
  stylist: Stylist;
  /** Salon-local wall-clock time "YYYY-MM-DDTHH:mm" (no timezone). */
  startsAt: string;
  /** Absolute start time (epoch ms) computed by the API in the salon's timezone; outreach stops once it passes. */
  startsAtMs?: number;
  durationMinutes: number;
  batchSize: number;
  replyWindowSeconds: number;
  fastDemo: boolean;
  simulateTextFailure: boolean;
  createdBy?: string;
};

export type Suggestion = {
  clientId: string;
  name: string;
  mobile: string;
  joinedAt: string;
  availabilityNote: string;
  availabilityTags: AvailabilityTags;
  stylistRule: StylistRule;
  /** True when the note had no parsable tags — staff should read it before approving. */
  checkNote: boolean;
  /** ANY-stylist client whose preferred stylist is this opening's stylist. */
  prefersThisStylist: boolean;
};

export type OfferStatus =
  | "sending" // text being sent (Activity running)
  | "live" // text delivered, reply window open
  | "accepted" // this client won the opening
  | "declined"
  | "timed_out" // no reply before their own deadline
  | "told_filled" // someone else said yes first
  | "told_cancelled" // staff cancelled the opening
  | "released"; // this client's yes was held, then released (staff couldn't confirm / auto-release)

export type LateReply = "already_taken" | "expired" | "no_longer_available";

export type Offer = {
  offerId: string;
  clientId: string;
  name: string;
  mobile: string;
  /** Unguessable link token generated inside the Workflow (uuid4). */
  token: string;
  round: number;
  cycle: number;
  status: OfferStatus;
  createdAt: number;
  deliveredAt?: number;
  sentAt?: number;
  deadline?: number;
  respondedAt?: number;
  lateReply?: LateReply;
  /** When lateReply === "expired": the late yes is flagged to staff until they Book or Dismiss it. */
  lateYesAt?: number;
  lateYesResolved?: "booked" | "dismissed";
  notifiedAt?: number;
  /** Waitlist reservation made for this offer (released once the offer is no longer live). */
  reservationRef?: string;
  reservationReleased?: boolean;
};

export type OpeningStatus =
  | "finding_matches"
  | "awaiting_approval"
  | "offering"
  | "unfilled"
  | "filled"
  | "cancelled"
  | "left_open";

export type HistoryEntry = { at: number; kind: string; text: string };

export type OpeningState = {
  opening: OpeningInput;
  status: OpeningStatus;
  /** Approval cycle; "Keep trying" starts a new one. */
  cycle: number;
  suggestions: Suggestion[];
  /** Approved client ids not yet offered, earliest joiner first. */
  queue: string[];
  offers: Offer[];
  currentRound: { number: number; offerIds: string[]; sentAt?: number; deadline?: number } | null;
  roundsSent: number;
  declinedClientIds: string[];
  /** The client whose yes HOLDS the slot (status "filled"); staff confirm it and update Square. */
  winner: {
    clientId: string;
    name: string;
    mobile: string;
    offerId: string;
    acceptedAt: number;
    /** The hold auto-releases at this time unless staff mark Square done. */
    holdUntil: number;
    via: "reply" | "late_yes";
  } | null;
  bookingRecorded: MarkBookedResult | null;
  square: { required: boolean; done: boolean; doneAt?: number };
  unfilledReason?: string;
  /** Why it is unfilled: nobody matched, everyone approved was tried, or the start time passed. */
  unfilledKind?: "no_matches" | "exhausted" | "time_passed";
  cancelReason?: string;
  closedAt?: number;
  history: HistoryEntry[];
};

export type RespondInput = { clientId: string; token: string; answer: "accept" | "decline" };

export type RespondOutcome =
  | "booked"
  | "declined"
  | "already_taken"
  | "expired"
  | "no_longer_available"
  | "already_answered"
  | "hold_released"
  | "not_ready";

export type RespondResult = { ok: boolean; outcome: RespondOutcome; message: string };

export type StaffActionResult = { ok: boolean; message: string };

export type ApproveInput = {
  clientIds: string[];
  batchSize?: number;
  replyWindowSeconds?: number;
};

/** Client-facing words, kept in one place so the Workflow and the API say the same thing. */
export const CLIENT_MESSAGES: Record<RespondOutcome, string> = {
  booked: "It's yours — we're holding it for you. The salon will text you shortly to confirm.",
  declined: "No problem — thanks for letting us know. You're still on the waitlist with your place.",
  already_taken: "Sorry, this time was just taken. You're still on the waitlist with your place.",
  expired: "This offer has expired. You're still on the waitlist with your place.",
  no_longer_available: "This opening is no longer available. You're still on the waitlist with your place.",
  already_answered: "You've already answered this offer.",
  hold_released:
    "The salon wasn't able to confirm this time, so the spot has been released. You're still on the waitlist with your place.",
  not_ready: "This offer is still being sent — please try again in a moment.",
};

export const FILLED_NOTICE = "Already filled — you're still on the waitlist.";

/** Shown when a client taps Accept after their own reply window ended (see ACCEPT_AFTER_OWN_DEADLINE). */
export const LATE_YES_MESSAGE =
  "This offer has expired — your reply came in after the deadline. The salon will check and get back to you. You're still on the waitlist with your place.";
