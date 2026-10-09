// Message definitions (Queries / Updates / Signals) shared by the Workflows,
// the API's Temporal Client, Activities and tests.
import { defineQuery, defineSignal, defineUpdate } from "@temporalio/workflow";
import type {
  AddClientInput,
  ApproveInput,
  MarkBookedInput,
  MarkBookedResult,
  OpeningState,
  RecordConsentInput,
  ReleaseInput,
  RemoveClientInput,
  ReserveInput,
  ReserveResult,
  RespondInput,
  RespondResult,
  StaffActionResult,
  WaitlistActionResult,
  WaitlistState,
} from "./types";

export const TASK_QUEUE = "juniper-salon";
export const WAITLIST_WORKFLOW_ID = "juniper-waitlist";

// Opening Workflow
export const getOpening = defineQuery<OpeningState>("getOpening");
export const approveMatches = defineUpdate<StaffActionResult, [ApproveInput]>("approveMatches");
export const respond = defineUpdate<RespondResult, [RespondInput]>("respond");
export const cancelOpening = defineUpdate<StaffActionResult, [{ reason?: string }]>("cancelOpening");
export const keepTrying = defineUpdate<StaffActionResult, []>("keepTrying");
export const leaveOpen = defineUpdate<StaffActionResult, []>("leaveOpen");
export const markSquareDone = defineUpdate<StaffActionResult, []>("markSquareDone");
/** Staff couldn't confirm the held client: release the hold and offer it to the next person. */
export const releaseHold = defineUpdate<StaffActionResult, [{ reason?: string }]>("releaseHold");
/** Staff decision on a late yes flagged on the card: book them (only if still open) or dismiss. */
export const resolveLateYes = defineUpdate<StaffActionResult, [{ offerId: string; action: "book" | "dismiss" }]>(
  "resolveLateYes",
);

// Waitlist Workflow
export const getWaitlist = defineQuery<WaitlistState>("getWaitlist");
export const markBooked = defineUpdate<MarkBookedResult, [MarkBookedInput]>("markBooked");
/** Fire-and-forget variant of markBooked (same rule: first booking wins). */
export const markBookedSignal = defineSignal<[MarkBookedInput]>("markBookedSignal");
/** Undo a booking made by this opening (its hold was released) — the client keeps their place. */
export const releaseBooking = defineUpdate<MarkBookedResult, [MarkBookedInput]>("releaseBooking");
/** Atomically reserve clients for an opening's round: one live offer per client across all openings. */
export const reserveForOffers = defineUpdate<ReserveResult, [ReserveInput]>("reserveForOffers");
export const releaseReservations = defineUpdate<{ released: number }, [ReleaseInput]>("releaseReservations");

/** Staff "Add to waitlist": validated; the new client joins at the back of the line (joinedAt = now). */
export const addClient = defineUpdate<WaitlistActionResult, [AddClientInput]>("addClient");
/** Only when the client asked to come off the list. Refused while they hold a live offer or a held slot. */
export const removeClient = defineUpdate<WaitlistActionResult, [RemoveClientInput]>("removeClient");
/** Record a client's answer to "Can we text you about earlier openings?". */
export const recordConsent = defineUpdate<WaitlistActionResult, [RecordConsentInput]>("recordConsent");
