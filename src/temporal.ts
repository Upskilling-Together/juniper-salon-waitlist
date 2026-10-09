// Temporal Client helpers used by the API process and by Activities in the Worker process.
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getOpening, getWaitlist, TASK_QUEUE, WAITLIST_WORKFLOW_ID } from "./messages";
import type { OpeningState, WaitlistClient } from "./types";
import { isTransientTemporalError } from "./automation";
import type { waitlistWorkflow } from "./workflows";

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
export const NAMESPACE = "default";

let clientPromise: Promise<Client> | undefined;
export function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({ address: TEMPORAL_ADDRESS })
    .then((connection) => new Client({ connection, namespace: NAMESPACE }))
    .catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

/** Start the long-running waitlist Workflow if it isn't already running. */
export async function ensureWaitlist(client: Client): Promise<void> {
  try {
    await client.workflow.start<typeof waitlistWorkflow>("waitlistWorkflow", {
      workflowId: WAITLIST_WORKFLOW_ID,
      taskQueue: TASK_QUEUE,
      args: [],
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) return;
    throw error;
  }
}

/** Where Activities read the current waitlist for the consent re-check (tests swap in a fixed list). */
export const waitlistSource = {
  async load(): Promise<WaitlistClient[]> {
    const client = await getClient();
    await ensureWaitlist(client);
    return (await client.workflow.getHandle(WAITLIST_WORKFLOW_ID).query(getWaitlist)).clients;
  },
};

export type OpeningListing = {
  workflowId: string;
  running: boolean;
  /** Temporal execution status: RUNNING, COMPLETED, FAILED, TERMINATED, TIMED_OUT, CANCELLED, … */
  executionStatus: string;
  startTime: Date;
  state?: OpeningState;
  error?: string;
  /** The query failed only because nothing answered in time (or the connection dropped), not a real error. */
  transient?: boolean;
  /** state is the last one read earlier (the background service isn't answering queries right now). */
  stale?: boolean;
  staleSince?: number;
};

/** Final state of closed openings, by run: a closed Workflow never changes, so it is read once. */
const closedStates = new Map<string, { runId: string; state: OpeningState }>();

/**
 * List opening Workflows (optionally only running ones) and query each one; query failures are reported,
 * not thrown (with `transient` set when it was only "no answer in time"). Listing itself has a deadline and
 * throws if Temporal doesn't answer. Queries need a Worker, so with skipQueries (Worker known to be down)
 * only closed openings already read are shown, and each query has a short deadline so one stuck opening
 * can't hold up the dashboard.
 */
export async function listOpenings(
  client: Client,
  options: { runningOnly?: boolean; extraIds?: string[]; skipQueries?: boolean; queryDeadlineMs?: number; listDeadlineMs?: number } = {},
) {
  const query = `WorkflowType='openingWorkflow'${options.runningOnly ? " AND ExecutionStatus='Running'" : ""}`;
  const seen = new Map<string, { running: boolean; executionStatus: string; startTime: Date; runId: string }>();
  await client.connection.withDeadline(Date.now() + (options.listDeadlineMs ?? 5_000), async () => {
    for await (const wf of client.workflow.list({ query })) {
      if (!seen.has(wf.workflowId)) {
        seen.set(wf.workflowId, { running: wf.status.name === "RUNNING", executionStatus: wf.status.name, startTime: wf.startTime, runId: wf.runId });
      }
      if (seen.size >= 200) break;
    }
  });
  for (const id of options.extraIds ?? []) {
    if (!seen.has(id)) seen.set(id, { running: true, executionStatus: "RUNNING", startTime: new Date(), runId: "" });
  }
  const entries = [...seen.entries()];
  const deadlineMs = options.queryDeadlineMs ?? 5_000;
  const results = await Promise.allSettled(
    entries.map(([id, meta]) => {
      const closed = !meta.running ? closedStates.get(id) : undefined;
      if (closed && closed.runId === meta.runId) return Promise.resolve(closed.state);
      if (options.skipQueries) {
        return Promise.reject(Object.assign(new Error("The background service isn't running, so this opening can't be read right now."), { code: 14 }));
      }
      return client.connection.withDeadline(Date.now() + deadlineMs, () => client.workflow.getHandle(id).query(getOpening));
    }),
  );
  return entries.map(([workflowId, { runId, ...meta }], i): OpeningListing => {
    const r = results[i];
    if (r.status === "fulfilled") {
      if (!meta.running && runId) closedStates.set(workflowId, { runId, state: r.value });
      return { workflowId, ...meta, state: r.value };
    }
    return {
      workflowId,
      ...meta,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      transient: isTransientTemporalError(r.reason),
    };
  });
}
