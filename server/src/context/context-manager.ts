import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, MessageContent } from "../sessions/types.js";

export type ToolEvictionStrategy = "lag" | "interval" | "off";

export interface ContextPolicy {
  enabled: boolean;
  strategy: ToolEvictionStrategy;
  lag: number;
  interval: number;
  pinExemptRounds: number;
  restoreBudget: number;
}

export interface LedgerEntry {
  messageId: string;
  kind: "tool_result";
  artifactId: string;
  state: "full" | "evicted" | "restored";
  createdRound: number;
  pinnedUntilRound: number;
  restoredAt?: string;
}

export interface ContextLedger {
  version: 1;
  round: number;
  policy: ContextPolicy;
  entries: LedgerEntry[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface ContextView {
  messages: ChatMessage[];
  ledger: ContextLedger;
}

const DEFAULT_POLICY: ContextPolicy = {
  enabled: true,
  strategy: "lag",
  lag: 1,
  interval: 5,
  pinExemptRounds: 5,
  restoreBudget: 20_000,
};

export class ContextManager {
  constructor(private readonly sessionRoot: string) {}

  async load(): Promise<ContextLedger> {
    try {
      return JSON.parse(await readFile(path.join(this.sessionRoot, "ledger.json"), "utf8")) as ContextLedger;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { version: 1, round: 0, policy: { ...DEFAULT_POLICY }, entries: [], usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 } };
    }
  }

  async save(ledger: ContextLedger): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    const target = path.join(this.sessionRoot, "ledger.json");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async buildView(messages: ChatMessage[]): Promise<ContextView> {
    const ledger = await this.load();
    const view = messages.map((message) => ({ ...message, content: message.content.map((block) => ({ ...block })) }));
    const byMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
    for (const message of view) {
      const entry = byMessage.get(message.id);
      if (!entry || entry.state === "full" || entry.state === "restored") continue;
      message.content = message.content.map((block) => {
        if (block.type !== "tool_result") return block;
        return {
          ...block,
          content: `[tool result evicted; artifact:${entry.artifactId}; use the UI restore action to reinsert full text]`,
        };
      });
    }
    return { messages: view, ledger };
  }

  async recordUsage(usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }): Promise<ContextLedger> {
    const ledger = await this.load();
    ledger.usage.inputTokens += usage.inputTokens;
    ledger.usage.outputTokens += usage.outputTokens;
    ledger.usage.cacheRead += usage.cacheRead;
    ledger.usage.cacheWrite += usage.cacheWrite;
    await this.save(ledger);
    return ledger;
  }

  async advanceRound(): Promise<ContextLedger> {
    const ledger = await this.load();
    ledger.round += 1;
    await this.save(ledger);
    return ledger;
  }

  async evict(messages: ChatMessage[]): Promise<ContextLedger> {
    const ledger = await this.load();
    const toolMessages = messages.filter((message) => message.role === "tool");
    if (!ledger.policy.enabled || ledger.policy.strategy === "off") return ledger;
    const eligible = ledger.policy.strategy === "lag"
      ? toolMessages.slice(0, Math.max(0, toolMessages.length - ledger.policy.lag))
      : ledger.policy.strategy === "interval" && ledger.round % Math.max(1, ledger.policy.interval) === 0
        ? toolMessages.slice(0, Math.max(0, toolMessages.length - ledger.policy.lag))
        : [];
    for (const message of eligible) {
      const existing = ledger.entries.find((entry) => entry.messageId === message.id);
      if (existing) {
        if (existing.pinnedUntilRound >= ledger.round) continue;
        existing.state = "evicted";
        delete existing.restoredAt;
        continue;
      }
      const result = message.content.find((block) => block.type === "tool_result");
      if (!result || result.type !== "tool_result") continue;
      const artifactId = `artifact-${randomUUID()}`;
      await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
      await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
      ledger.entries.push({ messageId: message.id, kind: "tool_result", artifactId, state: "evicted", createdRound: ledger.round, pinnedUntilRound: 0 });
    }
    await this.save(ledger);
    return ledger;
  }

  async restore(messageId: string): Promise<ContextLedger> {
    const ledger = await this.load();
    const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
    if (!entry) throw new Error("No evicted tool result for message");
    entry.state = "restored";
    entry.restoredAt = new Date().toISOString();
    entry.pinnedUntilRound = ledger.round + ledger.policy.pinExemptRounds;
    await this.save(ledger);
    return ledger;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
