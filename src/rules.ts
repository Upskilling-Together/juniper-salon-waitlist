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
