import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApplicationFailure, WorkflowNotFoundError, WorkflowUpdateFailedError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { describeStylistRule } from "./matching";
import {
  approveMatches,
  cancelOpening,
  getOpening,
  getWaitlist,
  keepTrying,
  leaveOpen,
  markSquareDone,
  releaseHold,
  resolveLateYes,
  respond,
  TASK_QUEUE,
  WAITLIST_WORKFLOW_ID,
} from "./messages";
import { clientOfferView } from "./offerView";
import { ensureWaitlist, getClient, listOpenings, NAMESPACE, type OpeningListing } from "./temporal";
import {
  CLIENT_MESSAGES,
  SERVICES,
  STYLISTS,
  type OpeningInput,
  type OpeningState,
  type RespondResult,
  type Service,
  type Stylist,
} from "./types";
import type { openingWorkflow } from "./workflows";

const TEMPORAL_UI = process.env.TEMPORAL_UI ?? "http://localhost:8233";
const REFILL_GOAL = 0.5;
const REFILL_BASELINE = 0.3;
const FAST_DEMO_SECONDS = 30;

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Openings created by this process, merged into the list in case Visibility lags a moment. */
const recentOpeningIds = new Set<string>();

const temporalLink = (workflowId: string) =>
  `${TEMPORAL_UI}/namespaces/${NAMESPACE}/workflows/${encodeURIComponent(workflowId)}`;

function localDateString(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Parse a salon-local "YYYY-MM-DDTHH:mm" (this server runs in the salon's timezone) and reject
 * impossible values like "2026-13-45T25:99". Returns epoch ms, or undefined if invalid.
 */
function parseLocalDateTime(startsAt: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(startsAt);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return undefined;
  const date = new Date(y, mo - 1, d, h, mi);
  const roundTrips =
    date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi;
  return roundTrips ? date.getTime() : undefined;
}
const PAST_GRACE_MS = 5 * 60 * 1000;

/** Default reply window: 15 min for a same-day opening, 60 min for later. */
function defaultReplyWindowMinutes(startsAt: string): number {
  return startsAt.slice(0, 10) === localDateString() ? 15 : 60;
}

function readableUpdateError(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof WorkflowUpdateFailedError) {
    const cause = error.cause;
    const message = cause?.message || error.message;
    if (cause instanceof ApplicationFailure && cause.type === "InvalidOfferLink") return { status: 403, message };
    return { status: 409, message };
  }
  if (error instanceof WorkflowNotFoundError) {
    return { status: 409, message: "This opening has already closed." };
  }
  if (error instanceof Error && /already completed|not found/i.test(error.message)) {
    return { status: 409, message: "This opening has already closed." };
  }
  return undefined;
}

async function openingHandle(id: string) {
  if (!/^opening-[a-z0-9-]+$/i.test(id)) throw new HttpError(404, "Unknown opening.");
  const client = await getClient();
  return client.workflow.getHandle(id);
}

async function queryOpening(id: string): Promise<OpeningState> {
  const handle = await openingHandle(id);
  try {
    return await handle.query(getOpening);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) throw new HttpError(404, "Unknown opening.");
    if (error instanceof Error && /nondeterminism/i.test(error.message)) {
      throw new HttpError(410, "This opening was made by an earlier version of the prototype and can't be shown here.");
    }
    throw error;
  }
}

/** Run a staff Update and turn validator rejections into readable 4xx responses. */
function staffAction(run: (id: string, body: any) => Promise<{ ok: boolean; message: string }>) {
  return async (request: Request, response: Response) => {
    const id = String(request.params.id);
    try {
      const result = await run(id, request.body ?? {});
      response.json({ ...result, opening: await queryOpening(id).catch(() => undefined) });
    } catch (error) {
      const readable = readableUpdateError(error);
      if (readable) {
        response.status(readable.status).json({ ok: false, error: readable.message });
        return;
      }
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Meta + dashboard
// ---------------------------------------------------------------------------
app.get("/api/meta", (_request, response) => {
  response.json({
    services: SERVICES,
    stylists: STYLISTS,
    today: localDateString(),
    fastDemoSeconds: FAST_DEMO_SECONDS,
    temporalUi: TEMPORAL_UI,
    refillGoal: REFILL_GOAL,
    refillBaseline: REFILL_BASELINE,
  });
});

const STATUS_PRIORITY: Record<string, number> = {
  unfilled: 0,
  awaiting_approval: 1,
  filled_todo: 2,
  offering: 3,
  finding_matches: 4,
  filled: 5,
  left_open: 6,
  cancelled: 7,
};

function summarise(listing: OpeningListing) {
  const s = listing.state;
  const key = s ? (s.status === "filled" && !s.square.done ? "filled_todo" : s.status) : "unknown";
  return { ...listing, temporalUrl: temporalLink(listing.workflowId), sortKey: STATUS_PRIORITY[key] ?? 9 };
}

app.get("/api/dashboard", async (_request, response) => {
  const client = await getClient();
  const [listings, waitlist] = await Promise.all([
    listOpenings(client, { extraIds: [...recentOpeningIds] }),
    (async () => {
      await ensureWaitlist(client);
      return client.workflow.getHandle(WAITLIST_WORKFLOW_ID).query(getWaitlist);
    })().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
  ]);
  for (const l of listings) if (l.state) recentOpeningIds.delete(l.workflowId);

  const openings = listings
    .map(summarise)
    .sort((a, b) => a.sortKey - b.sortKey || b.startTime.getTime() - a.startTime.getTime());

  // Refill rate: confirmed (Square done) ÷ (confirmed + unfilled + left open).
  // Cancelled and still-held openings are excluded: a hold can still be released.
  const counts = { filled: 0, held: 0, unfilled: 0, leftOpen: 0, cancelled: 0 };
  const holding = new Map<string, { openingId: string; deadline?: number; held?: boolean }>();
  for (const o of listings) {
    if (!o.state) continue;
    if (o.state.status === "filled") o.state.square.done ? counts.filled++ : counts.held++;
    else if (o.state.status === "unfilled") counts.unfilled++;
    else if (o.state.status === "left_open") counts.leftOpen++;
    else if (o.state.status === "cancelled") counts.cancelled++;
    for (const offer of o.state.offers) {
      if (offer.status === "live" || offer.status === "sending") {
        holding.set(offer.clientId, { openingId: o.workflowId, deadline: offer.deadline });
      }
    }
    const w = o.state.winner;
    if (o.state.status === "filled" && w && !o.state.square.done) {
      holding.set(w.clientId, { openingId: o.workflowId, deadline: w.holdUntil, held: true });
    }
  }
  const denominator = counts.filled + counts.unfilled + counts.leftOpen;

  response.json({
    now: Date.now(),
    openings,
    refill: {
      ...counts,
      rate: denominator ? counts.filled / denominator : null,
      goal: REFILL_GOAL,
      baseline: REFILL_BASELINE,
      label: "Prototype data — not proof of the business goal",
    },
    waitlist:
      "clients" in waitlist
        ? {
            source: waitlist.source,
            workflowId: WAITLIST_WORKFLOW_ID,
            temporalUrl: temporalLink(WAITLIST_WORKFLOW_ID),
            clients: waitlist.clients.map((c) => ({
              ...c,
              stylistRuleText: describeStylistRule(c.stylistRule),
              holding: holding.get(c.id),
            })),
          }
        : { error: waitlist.error },
  });
});

app.get("/api/waitlist", async (_request, response) => {
  const client = await getClient();
  await ensureWaitlist(client);
  response.json(await client.workflow.getHandle(WAITLIST_WORKFLOW_ID).query(getWaitlist));
});

// ---------------------------------------------------------------------------
// Openings (staff)
// ---------------------------------------------------------------------------
app.post("/api/openings", async (request, response) => {
  const body = request.body ?? {};
  const service = body.service as Service;
  const stylist = body.stylist as Stylist;
  const startsAt = String(body.startsAt ?? "").slice(0, 16);
  const durationMinutes = Number(body.durationMinutes ?? 60);
  const batchSize = Number(body.batchSize ?? 3);
  const fastDemo = Boolean(body.fastDemo);
  const simulateTextFailure = Boolean(body.simulateTextFailure);

  if (!SERVICES.includes(service)) throw new HttpError(400, `Pick a service (${SERVICES.join(", ")}).`);
  if (!STYLISTS.includes(stylist)) throw new HttpError(400, `Pick a stylist (${STYLISTS.join(", ")}).`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsAt)) throw new HttpError(400, "Pick a date and time.");
  const startsAtMs = parseLocalDateTime(startsAt);
  if (startsAtMs === undefined) throw new HttpError(400, "Pick a valid date and time.");
  if (startsAtMs < Date.now() - PAST_GRACE_MS) throw new HttpError(400, "That time has already passed.");
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
    throw new HttpError(400, "Duration must be between 15 and 480 minutes.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5) {
    throw new HttpError(400, "Texts per round must be between 1 and 5.");
  }
  let replyWindowSeconds: number;
  if (fastDemo) replyWindowSeconds = FAST_DEMO_SECONDS;
  else {
    const minutes = body.replyWindowMinutes == null || body.replyWindowMinutes === "" ? defaultReplyWindowMinutes(startsAt) : Number(body.replyWindowMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      throw new HttpError(400, "Reply window must be between 1 minute and 24 hours.");
    }
    replyWindowSeconds = Math.round(minutes * 60);
  }

  const openingId = `opening-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const input: OpeningInput = {
    openingId,
    service,
    stylist,
    startsAt,
    startsAtMs,
    durationMinutes,
    batchSize,
    replyWindowSeconds,
    fastDemo,
    simulateTextFailure,
  };
  const client = await getClient();
  await ensureWaitlist(client);
  await client.workflow.start<typeof openingWorkflow>("openingWorkflow", {
    workflowId: openingId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  recentOpeningIds.add(openingId);
  response.status(201).json({ openingId, workflowId: openingId, temporalUrl: temporalLink(openingId), input });
});

app.get("/api/openings/:id", async (request, response) => {
  const id = String(request.params.id);
  response.json({ workflowId: id, temporalUrl: temporalLink(id), state: await queryOpening(id) });
});

app.post(
  "/api/openings/:id/approve",
  staffAction(async (id, body) => {
    const clientIds = Array.isArray(body.clientIds) ? body.clientIds.map(String) : [];
    const args: { clientIds: string[]; batchSize?: number; replyWindowSeconds?: number } = { clientIds };
    if (body.batchSize != null && body.batchSize !== "") args.batchSize = Number(body.batchSize);
    if (body.fastDemo === true) args.replyWindowSeconds = FAST_DEMO_SECONDS;
    else if (body.replyWindowMinutes != null && body.replyWindowMinutes !== "") {
      args.replyWindowSeconds = Math.round(Number(body.replyWindowMinutes) * 60);
    }
    return (await openingHandle(id)).executeUpdate(approveMatches, { args: [args] });
  }),
);

app.post(
  "/api/openings/:id/cancel",
  staffAction(async (id, body) =>
    (await openingHandle(id)).executeUpdate(cancelOpening, {
      args: [{ reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined }],
    }),
  ),
);

app.post("/api/openings/:id/keep-trying", staffAction(async (id) => (await openingHandle(id)).executeUpdate(keepTrying)));
app.post("/api/openings/:id/leave-open", staffAction(async (id) => (await openingHandle(id)).executeUpdate(leaveOpen)));
app.post("/api/openings/:id/square-done", staffAction(async (id) => (await openingHandle(id)).executeUpdate(markSquareDone)));
app.post(
  "/api/openings/:id/release-hold",
  staffAction(async (id, body) =>
    (await openingHandle(id)).executeUpdate(releaseHold, {
      args: [{ reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined }],
    }),
  ),
);
app.post(
  "/api/openings/:id/late-yes",
  staffAction(async (id, body) => {
    const action = body.action === "book" ? "book" : body.action === "dismiss" ? "dismiss" : undefined;
    if (!action) throw new HttpError(400, "Choose Book or Dismiss.");
    return (await openingHandle(id)).executeUpdate(resolveLateYes, { args: [{ offerId: String(body.offerId ?? ""), action }] });
  }),
);

// ---------------------------------------------------------------------------
// Client offer page
// ---------------------------------------------------------------------------
app.get("/api/offers/:id", async (request, response) => {
  const clientId = String(request.query.c ?? "");
  const token = String(request.query.t ?? "");
  const state = await queryOpening(String(request.params.id)).catch((error) => {
    if (error instanceof HttpError && error.status === 404) throw new HttpError(403, "This offer link isn't valid.");
    throw error;
  });
  const view = clientOfferView(state, clientId, token, Date.now());
  if (!view.valid) throw new HttpError(403, "This offer link isn't valid.");
  response.json({ ...view, now: Date.now() });
});

app.post("/api/offers/:id/respond", async (request, response) => {
  const id = String(request.params.id);
  const clientId = String(request.body?.clientId ?? "");
  const token = String(request.body?.token ?? "");
  const answer = request.body?.answer;
  if (answer !== "accept" && answer !== "decline") throw new HttpError(400, "Answer must be accept or decline.");
  const handle = await openingHandle(id);
  let result: RespondResult;
  try {
    result = await handle.executeUpdate(respond, { args: [{ clientId, token, answer }] });
  } catch (error) {
    const readable = readableUpdateError(error);
    if (!readable) throw error;
    if (readable.status === 403) throw new HttpError(403, readable.message);
    // The Workflow has closed (e.g. cancelled, or filled and booked in Square): answer from its final state.
    const state = await queryOpening(id).catch(() => undefined);
    const view = state ? clientOfferView(state, clientId, token, Date.now()) : { valid: false as const };
    if (!view.valid) throw new HttpError(403, "This offer link isn't valid.");
    const outcome = view.outcome === "filled_notice" ? "already_taken" : (view.outcome ?? "no_longer_available");
    result = { ok: outcome === "booked", outcome, message: CLIENT_MESSAGES[outcome] };
  }
  const state = await queryOpening(id).catch(() => undefined);
  const view = state ? clientOfferView(state, clientId, token, Date.now()) : undefined;
  response.json({ ...result, view });
});

// ---------------------------------------------------------------------------
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ ok: false, error: error.message });
    return;
  }
  const bodyError = error as { type?: string; status?: number };
  if (bodyError?.type === "entity.parse.failed" || bodyError?.status === 400) {
    response.status(400).json({ ok: false, error: "The request wasn't valid JSON." });
    return;
  }
  console.error(error);
  const message = error instanceof Error ? error.message : "Unexpected error";
  response.status(500).json({
    ok: false,
    error: /connect|UNAVAILABLE|ECONNREFUSED/i.test(message)
      ? "Can't reach Temporal. Is the dev server running (npm run start:temporal)?"
      : message,
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Juniper Salon refill prototype: http://localhost:${port}`);
  getClient()
    .then(ensureWaitlist)
    .catch((error) => console.warn("Waitlist workflow not started yet:", error instanceof Error ? error.message : error));
});
