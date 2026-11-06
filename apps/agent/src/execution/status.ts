/** Execution status transition policy, using the shared run-state vocabulary. */
import type { AgentRunState } from "@answra/shared/schema";

const TERMINAL_STATES = new Set<AgentRunState>([
  "completed",
  "failed",
  "aborted",
  "superseded",
  "orphaned",
]);

const ALLOWED_TRANSITIONS: Record<AgentRunState, readonly AgentRunState[]> = {
  queued: ["claimed", "aborted", "superseded"],
  claimed: ["running", "failed", "aborted", "superseded", "orphaned"],
  running: ["retry-wait", "completed", "failed", "aborted", "superseded", "orphaned"],
  "retry-wait": ["running", "failed", "aborted", "superseded", "orphaned"],
  completed: [],
  failed: [],
  aborted: [],
  superseded: [],
  orphaned: [],
};

export function canTransitionRun(from: AgentRunState, to: AgentRunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalRunState(state: AgentRunState): boolean {
  return TERMINAL_STATES.has(state);
}
