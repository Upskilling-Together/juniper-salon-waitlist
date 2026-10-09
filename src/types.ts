// Shared data types for the Juniper Salon waitlist-refill prototype.
// Everything here is plain data so it can cross Workflow / Activity / API boundaries.

/** Lena: "Main services: Haircut, Color, Blowout." */
export const SERVICES = ["Haircut", "Color", "Blowout"] as const;
export type Service = (typeof SERVICES)[number];

/** Default appointment length per service (filled in on the Add-opening form; staff can change it). */
export const SERVICE_DEFAULT_DURATION_MINUTES: Record<Service, number> = { Haircut: 45, Color: 120, Blowout: 45 };
/** Lena: appointments are "about 30 minutes to 3 hours" depending on the service. */
export const DURATION_LIMITS_MINUTES = { min: 30, max: 180 } as const;

/**
 * Five stylists. Only Lena and Carla are named so far; the other three are SAMPLE names
 * (chosen not to clash with any sample client) — confirm with Lena.
 */
export const STYLISTS = ["Lena", "Carla", "Sam", "Jules", "Nico"] as const;
export type Stylist = (typeof STYLISTS)[number];
export const SAMPLE_STYLISTS: readonly Stylist[] = ["Sam", "Jules", "Nico"];
export const SAMPLE_STYLIST_NOTE = "Sample names — confirm with Lena";

/**
 * Texting consent, asked when someone joins the waitlist (Lena: "We should ask them when they
 * join and record whether they've opted in. Some people have already opted out.").
 * ONLY "opted_in" clients are ever suggested or texted.
 */
export const TEXTING_CONSENTS = ["opted_in", "opted_out", "not_asked"] as const;
export type TextingConsent = (typeof TEXTING_CONSENTS)[number];
export const CONSENT_LABELS: Record<TextingConsent, string> = {
  opted_in: "Opted in to texts",
  opted_out: "Opted out — don't text",
  not_asked: "Not asked yet — don't text",
};

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
  /** "removed" = they asked to come off the list (kept for history, never suggested or texted). */
  status: "waiting" | "booked" | "removed";
  /** Only "opted_in" clients are suggested or texted. */
  textingConsent: TextingConsent;
  /** When the texting answer was recorded (ISO); absent for "not_asked". */
  consentRecordedAt?: string;
  /** Where the answer came from, e.g. "Asked when they joined" or "Recorded by staff". */
  consentSource?: string;
  /** Set when staff removed them because they asked to come off the list. */
  removedAt?: string;
  removedReason?: string;
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

/** Staff "Add to waitlist" form. joinedAt is set by the waitlist Workflow (back of the line). */
export type AddClientInput = {
  name: string;
  mobile: string;
  service: Service;
  stylistRule: StylistRule;
  /** Free text, stored and shown verbatim. */
  availabilityNote: string;
  /** Required: "Can we text them about earlier openings?" Yes / No / Didn't ask. */
  textingConsent: TextingConsent;
};
export type RemoveClientInput = { clientId: string; reason?: string };
export type RecordConsentInput = { clientId: string; textingConsent: TextingConsent };
export type WaitlistActionResult = { ok: boolean; message: string; client: WaitlistClient };

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
  /** Stop offering this many minutes before the start (30/45/60/90/120; default 60). */
  stopOfferingMinutesBefore?: number;
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
  /** Keep trying: already texted for this opening with no reply, so listed after people never texted. */
  textedBefore?: boolean;
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
  /** Exact wording of the SIMULATED offer text (nothing is really sent). */
  smsText?: string;
  /** The reply window this offer actually got (shortened when capped by the start-time cutoff). */
  replyWindowSeconds?: number;
  /** True when the reply window was shortened so the deadline doesn't pass the cutoff. */
  windowCapped?: boolean;
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

/** Result of the textingWindow Activity (salon local time is only ever read inside the Activity). */
export type TextingWindow = {
  /** Salon-local wall clock at `nowMs`, "YYYY-MM-DDTHH:mm". */
  nowLocal: string;
  /** The opening's date is today (salon time). */
  sameDay: boolean;
  /** Inside TEXTING_HOURS right now. */
  withinHours: boolean;
  /** Offer texts may go out now. */
  canSendNow: boolean;
  /** Why texting hours don't apply. */
  bypass: "same_day" | "fast_demo" | null;
  /** When !canSendNow: the next texting-hours start (epoch ms) and how to say it ("9:00 AM", "9:00 AM tomorrow"). */
  nextAllowedAt?: number;
  nextAllowedLabel?: string;
  /** The opening's cutoff (start − stop-offering minutes) as salon-local "8:30 AM", when one was given. */
  cutoffLabel?: string;
  /**
   * When texting hours are what allow the send (not bypassed): today's texting-hours end (epoch ms).
   * A round's texts must be out by then, or they wait for the next texting-hours start.
   */
  hoursEndAt?: number;
};

export type OpeningState = {
  opening: OpeningInput;
  status: OpeningStatus;
  /** Approval cycle; "Keep trying" starts a new one. */
  cycle: number;
  suggestions: Suggestion[];
  /** Approved client ids not yet offered, earliest joiner first. */
  queue: string[];
  offers: Offer[];
  currentRound: {
    number: number;
    offerIds: string[];
    sentAt?: number;
    deadline?: number;
    /** Actual reply window for this round (may be shorter than the opening's setting). */
    replyWindowSeconds?: number;
    windowCapped?: boolean;
  } | null;
  /**
   * Set while a round is waiting for texting hours (cleared when it sends, or on cancel / fill).
   * text: "Scheduled — texts go out at 9:00 AM (outside texting hours)".
   */
  scheduled: { until: number; untilLabel: string; text: string } | null;
  /** The latest texting-hours check (shows "Same-day opening — texting hours don't apply" etc.). */
  textingCheck: (TextingWindow & { at: number }) | null;
  /** Outreach stops at this time (start − stopOfferingMinutesBefore); undefined when the start time is unknown. */
  offeringCutoffAt?: number;
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
  /** Why it is unfilled: nobody matched, everyone approved was tried, too close to the start, or the start time passed. */
  unfilledKind?: "no_matches" | "exhausted" | "too_close" | "time_passed";
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
  expired: "This offer has expired, so the appointment isn't guaranteed. You're still on the waitlist with your place.",
  no_longer_available: "This opening is no longer available. You're still on the waitlist with your place.",
  already_answered: "You've already answered this offer.",
  hold_released:
    "The salon wasn't able to confirm this time, so the spot has been released. You're still on the waitlist with your place.",
  not_ready: "This offer is still being sent — please try again in a moment.",
};

export const FILLED_NOTICE = "Already filled — you're still on the waitlist.";

/** Shown when a client taps Accept after their own reply window ended (see ACCEPT_AFTER_OWN_DEADLINE). */
export const LATE_YES_MESSAGE =
  "This offer has expired — your reply came in after the deadline, so the appointment isn't guaranteed. The salon will check whether it's still available and let you know. You're still on the waitlist with your place.";
