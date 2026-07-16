import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { Currency } from "./model-profile.js";

export interface RecordedCost {
  priced: boolean;
  source?: { currency: Currency; microUnits: string };
  usdMicroUnits?: string;
  cnyMicroUnits?: string;
  exchangeRate?: {
    rate: string;
    source: string;
    effectiveDate: string;
    fetchedAt: string;
  };
}

export interface CostLedger {
  usdMicroUnits: string;
  cnyMicroUnits: string;
  unpricedTokens: number;
  unavailableUsdTokens: number;
  unavailableCnyTokens: number;
  lastExchangeRate?: RecordedCost["exchangeRate"];
}

export type ToolEvictionStrategy = "lag" | "interval" | "off";

export interface ContextPolicy {
  enabled: boolean;
  strategy: ToolEvictionStrategy;
  lag: number;
  interval: number;
  pinExemptRounds: number;
  restoreBudget: number;
  maxSessionTokens?: number;
  maxSessionCost?: { currency: Currency; microUnits: string };
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
  cost: CostLedger;
  cacheBreakpoints: string[];
}

export interface BudgetUpdate {
  maxSessionTokens?: number | undefined;
  maxSessionCost?: { currency: Currency; microUnits: string } | undefined;
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
  private static readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly sessionRoot: string) {}

  async load(): Promise<ContextLedger> {
    try {
      const ledger = JSON.parse(await readFile(path.join(this.sessionRoot, "ledger.json"), "utf8")) as Partial<ContextLedger>;
      return normalizeLedger(ledger);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return normalizeLedger({});
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

  async budgetStatus(): Promise<{
    token: { limit?: number; used: number; paused: boolean };
    cost: { limit?: { currency: Currency; microUnits: string }; usedMicroUnits: string; paused: boolean; reason?: "cost_exhausted" | "cost_unavailable" };
    paused: boolean;
  }> {
    const ledger = await this.load();
    const tokenUsed = ledger.usage.inputTokens + ledger.usage.outputTokens;
    const tokenLimit = ledger.policy.maxSessionTokens;
    const tokenPaused = tokenLimit !== undefined && tokenUsed >= tokenLimit;
    const costLimit = ledger.policy.maxSessionCost;
    const usedMicroUnits = costLimit?.currency === "CNY" ? ledger.cost.cnyMicroUnits : ledger.cost.usdMicroUnits;
    const unavailableTokens = costLimit?.currency === "CNY" ? ledger.cost.unavailableCnyTokens : ledger.cost.unavailableUsdTokens;
    const costUnavailable = costLimit !== undefined &&
      (ledger.cost.unpricedTokens > 0 || unavailableTokens > 0);
    const costPaused = costLimit !== undefined && (costUnavailable || BigInt(usedMicroUnits) >= BigInt(costLimit.microUnits));
    return {
      token: { ...(tokenLimit === undefined ? {} : { limit: tokenLimit }), used: tokenUsed, paused: tokenPaused },
      cost: {
        ...(costLimit === undefined ? {} : { limit: { ...costLimit } }),
        usedMicroUnits,
        paused: costPaused,
        ...(costPaused ? { reason: costUnavailable ? "cost_unavailable" as const : "cost_exhausted" as const } : {}),
      },
      paused: tokenPaused || costPaused,
    };
  }

  async updateBudget(update: BudgetUpdate): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      if ("maxSessionTokens" in update) {
        const value = update.maxSessionTokens;
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new Error("maxSessionTokens must be a positive integer");
        }
        if (value === undefined) delete ledger.policy.maxSessionTokens;
        else ledger.policy.maxSessionTokens = value;
      }
      if ("maxSessionCost" in update) {
        const value = update.maxSessionCost;
        if (value !== undefined &&
            (!/^[1-9]\d*$/.test(value.microUnits) || !["USD", "CNY"].includes(value.currency))) {
          throw new Error("maxSessionCost must contain a positive integer microUnits and USD or CNY currency");
        }
        if (value === undefined) delete ledger.policy.maxSessionCost;
        else ledger.policy.maxSessionCost = { ...value };
      }
      await this.save(ledger);
      return ledger;
    });
  }

  async setBudget(
    maxSessionTokens: number | undefined,
    maxSessionCost: { currency: Currency; microUnits: string } | undefined,
  ): Promise<ContextLedger> {
    return this.updateBudget({ maxSessionTokens, maxSessionCost });
  }

  async setTokenBudget(maxSessionTokens: number | undefined): Promise<ContextLedger> {
    return this.updateBudget({ maxSessionTokens });
  }

  async recordUsage(
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number },
    cost?: RecordedCost,
  ): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      ledger.usage.inputTokens += usage.inputTokens;
      ledger.usage.outputTokens += usage.outputTokens;
      ledger.usage.cacheRead += usage.cacheRead;
      ledger.usage.cacheWrite += usage.cacheWrite;
      if (cost) {
        const billedTokens = usage.inputTokens + usage.outputTokens + usage.cacheRead + usage.cacheWrite;
        if (!cost.priced) {
          ledger.cost.unpricedTokens += billedTokens;
        } else {
          if (!cost.usdMicroUnits) ledger.cost.unavailableUsdTokens += billedTokens;
          if (!cost.cnyMicroUnits) ledger.cost.unavailableCnyTokens += billedTokens;
        }
        if (cost.usdMicroUnits) ledger.cost.usdMicroUnits = addIntegers(ledger.cost.usdMicroUnits, cost.usdMicroUnits);
        if (cost.cnyMicroUnits) ledger.cost.cnyMicroUnits = addIntegers(ledger.cost.cnyMicroUnits, cost.cnyMicroUnits);
        if (cost.exchangeRate) ledger.cost.lastExchangeRate = { ...cost.exchangeRate };
      }
      await this.save(ledger);
      return ledger;
    });
  }

  async replaceLedger(value: unknown): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = normalizeLedger(value && typeof value === "object" ? value as Partial<ContextLedger> : {});
      await this.save(ledger);
      return ledger;
    });
  }

  async recordCacheBreakpoints(messageIds: string[]): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      ledger.cacheBreakpoints = [...new Set(messageIds)].slice(-3);
      await this.save(ledger);
      return ledger;
    });
  }

  async advanceRound(): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      ledger.round += 1;
      await this.save(ledger);
      return ledger;
    });
  }

  async evict(messages: ChatMessage[]): Promise<ContextLedger> {
    return this.serial(async () => {
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
    });
  }

  async readArtifact(artifactId: string, offset: number, limit: number): Promise<string> {
    if (!/^artifact-[0-9a-f-]{36}$/.test(artifactId)) throw new Error("Invalid artifact ID");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000) throw new Error("limit must be between 1 and 64000");
    try {
      const content = await readFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), "utf8");
      return content.slice(offset, offset + limit);
    } catch (error) {
      if (isMissing(error)) throw new Error("Artifact not found");
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = ContextManager.operations.get(this.sessionRoot) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    ContextManager.operations.set(this.sessionRoot, settled);
    void settled.finally(() => {
      if (ContextManager.operations.get(this.sessionRoot) === settled) {
        ContextManager.operations.delete(this.sessionRoot);
      }
    });
    return result;
  }

  async restore(messageId: string): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
      if (!entry) throw new Error("No evicted tool result for message");
      entry.state = "restored";
      entry.restoredAt = new Date().toISOString();
      entry.pinnedUntilRound = ledger.round + ledger.policy.pinExemptRounds;
      await this.save(ledger);
      return ledger;
    });
  }
}

function normalizePolicy(value: ContextPolicy | undefined): ContextPolicy {
  const policy: ContextPolicy = { ...DEFAULT_POLICY, ...(value ?? {}) };
  const cost = value?.maxSessionCost;
  if (cost && (cost.currency === "USD" || cost.currency === "CNY") && /^[1-9]\d*$/.test(cost.microUnits)) {
    policy.maxSessionCost = { ...cost };
  } else {
    delete policy.maxSessionCost;
  }
  if (policy.maxSessionTokens !== undefined && (!Number.isSafeInteger(policy.maxSessionTokens) || policy.maxSessionTokens < 1)) {
    delete policy.maxSessionTokens;
  }
  return policy;
}

function normalizeLedger(value: Partial<ContextLedger>): ContextLedger {
  const usage = value.usage;
  const cost = value.cost;
  return {
    version: 1,
    round: Number.isSafeInteger(value.round) && (value.round ?? -1) >= 0 ? value.round! : 0,
    policy: normalizePolicy(value.policy),
    entries: Array.isArray(value.entries) ? value.entries : [],
    usage: {
      inputTokens: safeTokenCount(usage?.inputTokens),
      outputTokens: safeTokenCount(usage?.outputTokens),
      cacheRead: safeTokenCount(usage?.cacheRead),
      cacheWrite: safeTokenCount(usage?.cacheWrite),
    },
    cost: {
      usdMicroUnits: integerString(cost?.usdMicroUnits),
      cnyMicroUnits: integerString(cost?.cnyMicroUnits),
      unpricedTokens: safeTokenCount(cost?.unpricedTokens),
      unavailableUsdTokens: safeTokenCount(cost?.unavailableUsdTokens),
      unavailableCnyTokens: safeTokenCount(cost?.unavailableCnyTokens),
      ...(cost?.lastExchangeRate ? { lastExchangeRate: { ...cost.lastExchangeRate } } : {}),
    },
    cacheBreakpoints: Array.isArray(value.cacheBreakpoints)
      ? value.cacheBreakpoints.filter((item): item is string => typeof item === "string").slice(-3)
      : [],
  };
}

export function selectCacheBreakpoints(messages: ChatMessage[], ledger: ContextLedger): string[] {
  const selected: string[] = [];
  const lastEvicted = [...ledger.entries].reverse().find((entry) => entry.state === "evicted");
  if (lastEvicted) selected.push(lastEvicted.messageId);
  const users = messages.filter((message) => message.role === "user");
  if (users.length >= 2) selected.push(users[users.length - 2]!.id);
  return [...new Set(selected)].slice(-3);
}

function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function integerString(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : "0";
}

function addIntegers(left: string, right: string): string {
  if (!/^\d+$/.test(right)) throw new Error("Cost must be a non-negative integer string");
  return (BigInt(left) + BigInt(right)).toString();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
