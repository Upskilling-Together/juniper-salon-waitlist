/**
 * Lena's rule — the one place it lives.
 *
 * If a client taps "Accept" after THEIR OWN reply window has ended but the
 * chair is still empty (nobody else said yes, not cancelled), do they get it?
 *   false (Lena: "No, not automatically") => "This offer has expired" — not booked,
 *         stays on the waitlist, and staff see the late yes to Book or Dismiss.
 *   true  => they win the opening.
 *
 * Used by the opening Workflow (src/workflows.ts) and the client offer page view (src/offerView.ts).
 */
export const ACCEPT_AFTER_OWN_DEADLINE = false;

/**
 * A client's yes only HOLDS the slot (Lena: staff confirm and update Square themselves).
 * If staff haven't marked it done in Square within this many minutes, the hold is
 * released automatically and outreach moves on to the next approved person.
 */
export const HOLD_AUTO_RELEASE_MINUTES = 15;

// ---------------------------------------------------------------------------
// Pilot-readiness rules from Lena (2026-10-08)
// ---------------------------------------------------------------------------

/**
 * TEXTING HOURS (salon local time). Client OFFER texts only go out inside this window,
 * unless the opening is same-day (its date is today, salon time, at the moment of sending).
 * Fast-demo openings ignore texting hours so a demo works at any time of day.
 * Staff alerts (to Lena and Carla) are not restricted.
 *
 * CONFIRMED by Lena (2026-10-08): 9:00 AM–8:00 PM "sounds about right" (same-day openings stay exempt).
 * `end` is exclusive: a round due at exactly 8:00 PM waits until 9:00 AM.
 */
export const TEXTING_HOURS = { start: "09:00", end: "20:00", label: "9:00 AM–8:00 PM" } as const;

/**
 * START-TIME CUTOFF. Lena: "I'd still try if there's enough time for the client to get here.
 * Thirty minutes might be too short, depending on the service and the person."
 * Per opening: stop offering this many minutes before it starts. A round's reply window is
 * shortened so its deadline never passes the cutoff.
 */
export const STOP_OFFERING_OPTIONS_MINUTES = [30, 45, 60, 90, 120] as const;
export const DEFAULT_STOP_OFFERING_MINUTES = 60;
/** If the shortened (capped) reply window would be shorter than this, it's too close to offer. */
export const MIN_CAPPED_REPLY_WINDOW_MINUTES = 5;
export const TOO_CLOSE_REASON = "Too close to the start time to offer it";

/** Default reply window (Lena: ~10–15 min same-day; "closer to 2 hours" for later openings). */
export const DEFAULT_REPLY_WINDOW_MINUTES = { sameDay: 15, later: 120 } as const;

/**
 * Staff alerts go to BOTH Lena and Carla for now (Lena: may revisit if it gets noisy).
 * Fictional numbers in the reserved 555-01xx range.
 */
export const STAFF_ALERT_RECIPIENTS: ReadonlyArray<{ name: string; mobile: string }> = [
  { name: "Lena", mobile: "(555) 010-0190" },
  { name: "Carla", mobile: "(555) 010-0191" },
];

/**
 * "Last-minute" (Lena's 3-in-10 baseline and 50% goal) = cancellations WITHIN 48 HOURS of the
 * appointment. Only openings that start within this many hours of being added count toward the refill rate.
 */
export const LAST_MINUTE_HOURS = 48;
