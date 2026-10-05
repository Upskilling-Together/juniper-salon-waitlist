// Temporal Client helpers used by the API process and by Activities in the Worker process.
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getOpening, TASK_QUEUE, WAITLIST_WORKFLOW_ID } from "./messages";
import type { OpeningState } from "./types";
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

export type OpeningListing = {
  workflowId: string;
  running: boolean;
  startTime: Date;
  state?: OpeningState;
  error?: string;
};

/** List opening Workflows (optionally only running ones) and query each one; failures are reported, not thrown. */
export async function listOpenings(client: Client, options: { runningOnly?: boolean; extraIds?: string[] } = {}) {
  const query = `WorkflowType='openingWorkflow'${options.runningOnly ? " AND ExecutionStatus='Running'" : ""}`;
  const seen = new Map<string, { running: boolean; startTime: Date }>();
  for await (const wf of client.workflow.list({ query })) {
    if (!seen.has(wf.workflowId)) seen.set(wf.workflowId, { running: wf.status.name === "RUNNING", startTime: wf.startTime });
    if (seen.size >= 200) break;
  }
  for (const id of options.extraIds ?? []) {
    if (!seen.has(id)) seen.set(id, { running: true, startTime: new Date() });
  }
  const entries = [...seen.entries()];
  const results = await Promise.allSettled(
    entries.map(([id]) => client.workflow.getHandle(id).query(getOpening)),
  );
  return entries.map(([workflowId, meta], i): OpeningListing => {
    const r = results[i];
    return r.status === "fulfilled"
      ? { workflowId, ...meta, state: r.value }
      : { workflowId, ...meta, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
  });
}
