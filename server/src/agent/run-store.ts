import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";

export type AgentRunState =
  | "accepted"
  | "starting"
  | "snapshotting"
  | "preparing_context"
  | "streaming"
  | "executing_tools"
  | "waiting_permission"
  | "advancing_turn"
  | "settling"
  | "budget_paused"
  | "completed"
  | "failed"
  | "aborted";

export interface AgentRunSnapshot {
  id: string;
  sessionId: string;
  triggerMessageId: string;
  state: AgentRunState;
  turnIndex: number;
  startedAt: string;
  since: string;
  settledAt?: string;
  error?: { code: string; message: string; retryable: boolean };
}

/**
 * Durable, replace-in-place snapshots for the current and historical runs of
 * one session. Message history remains append-only; these files only describe
 * lifecycle truth that can be rebuilt after a browser reconnect.
 */
export class RunStore {
  constructor(private readonly sessionRoot: string) {}

  async write(run: AgentRunSnapshot): Promise<void> {
    const directory = path.join(this.sessionRoot, "runs");
    await mkdir(directory, { recursive: true });
    const serialized = `${JSON.stringify(run, null, 2)}\n`;
    await Promise.all([
      writeUtf8Atomically(path.join(directory, `${run.id}.json`), serialized),
      writeUtf8Atomically(path.join(directory, "latest.json"), serialized),
    ]);
  }

  async readLatest(): Promise<AgentRunSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.sessionRoot, "runs", "latest.json"), "utf8")) as AgentRunSnapshot;
      if (!value || typeof value.id !== "string" || typeof value.sessionId !== "string" || typeof value.state !== "string") {
        throw new Error("Invalid run snapshot");
      }
      return value;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
}
