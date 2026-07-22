import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentRun, AppEvent } from "../lib/contracts";

export const agentRunKey = (sessionId: string) => ["run", sessionId] as const;

/** REST snapshot for the Run state machine. Event payloads update it eagerly;
 * stale or missed lifecycle events are corrected by the normal query fetch. */
export function useAgentRun(sessionId?: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: agentRunKey(sessionId ?? ""),
    queryFn: () => api.run(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const applyEvent = useCallback((event: AppEvent): void => {
    if (!sessionId || event.sessionId !== sessionId) return;
    if (event.type.startsWith("run.")) {
      const payload = event.payload as Partial<AgentRun>;
      if (typeof payload.id === "string" && typeof payload.state === "string") {
        queryClient.setQueryData<AgentRun>(agentRunKey(sessionId), payload as AgentRun);
      } else {
        void queryClient.invalidateQueries({ queryKey: agentRunKey(sessionId) });
      }
      return;
    }
    if (event.type !== "agent.state") return;
    const payload = event.payload as { runId?: string; state?: string; turnIndex?: number; since?: string };
    // The compatibility `idle` event follows a terminal run.* event and must
    // not overwrite the durable completed/failed/aborted snapshot.
    if (!payload.runId || !payload.state || payload.state === "idle") return;
    const state = payload.state as AgentRun["state"];
    queryClient.setQueryData<AgentRun | undefined>(agentRunKey(sessionId), (previous) =>
      !previous || previous.id !== payload.runId
        ? previous
        : {
          ...previous,
          state,
          ...(payload.turnIndex === undefined ? {} : { turnIndex: payload.turnIndex }),
          ...(payload.since === undefined ? {} : { since: payload.since }),
        },
    );
  }, [queryClient, sessionId]);
  return { ...query, applyEvent };
}
