import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const DEFAULT_POLICY = {
    enabled: true,
    strategy: "lag",
    lag: 1,
    interval: 5,
    pinExemptRounds: 5,
    restoreBudget: 20_000,
};
export class ContextManager {
    sessionRoot;
    static operations = new Map();
    constructor(sessionRoot) {
        this.sessionRoot = sessionRoot;
    }
    async load() {
        try {
            const ledger = JSON.parse(await readFile(path.join(this.sessionRoot, "ledger.json"), "utf8"));
            return normalizeLedger(ledger);
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            return normalizeLedger({});
        }
    }
    async save(ledger) {
        await mkdir(this.sessionRoot, { recursive: true });
        const target = path.join(this.sessionRoot, "ledger.json");
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
        await rename(temporary, target);
    }
    async buildView(messages) {
        const ledger = await this.load();
        const compacted = ledger.compacted;
        const compactedIndex = compacted ? Math.min(compacted.uptoIndex, messages.length) : 0;
        const clearedIndex = ledger.cleared ? Math.min(ledger.cleared.uptoIndex, messages.length) : 0;
        // 压缩和清空都裁剪消息前缀；较新的边界获胜。clear 覆盖压缩时不得重新注入旧摘要。
        const uptoIndex = Math.max(compactedIndex, clearedIndex);
        const view = messages.slice(uptoIndex).map((message) => ({ ...message, content: message.content.map((block) => ({ ...block })) }));
        const byMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
        for (const message of view) {
            const entry = byMessage.get(message.id);
            if (!entry || entry.state === "full" || entry.state === "restored")
                continue;
            message.content = message.content.map((block) => {
                if (block.type !== "tool_result")
                    return block;
                return {
                    ...block,
                    content: `[tool result evicted; artifact:${entry.artifactId}; use the UI restore action to reinsert full text]`,
                };
            });
        }
        if (compacted && (!ledger.cleared || compactedIndex > clearedIndex)) {
            view.unshift({
                id: `compaction:${compacted.createdAt}`,
                role: "user",
                createdAt: compacted.createdAt,
                content: [{ type: "text", text: `[Earlier context compacted (${compacted.mode})]\n${renderCompaction(compacted)}` }],
            });
        }
        enforceImageBudget(view);
        return { messages: view, ledger };
    }
    async budgetStatus() {
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
                ...(costPaused ? { reason: costUnavailable ? "cost_unavailable" : "cost_exhausted" } : {}),
            },
            paused: tokenPaused || costPaused,
        };
    }
    async updateBudget(update) {
        return this.serial(async () => {
            const ledger = await this.load();
            if ("maxSessionTokens" in update) {
                const value = update.maxSessionTokens;
                if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
                    throw new Error("maxSessionTokens must be a positive integer");
                }
                if (value === undefined)
                    delete ledger.policy.maxSessionTokens;
                else
                    ledger.policy.maxSessionTokens = value;
            }
            if ("maxSessionCost" in update) {
                const value = update.maxSessionCost;
                if (value !== undefined &&
                    (!/^[1-9]\d*$/.test(value.microUnits) || !["USD", "CNY"].includes(value.currency))) {
                    throw new Error("maxSessionCost must contain a positive integer microUnits and USD or CNY currency");
                }
                if (value === undefined)
                    delete ledger.policy.maxSessionCost;
                else
                    ledger.policy.maxSessionCost = { ...value };
            }
            await this.save(ledger);
            return ledger;
        });
    }
    async setBudget(maxSessionTokens, maxSessionCost) {
        return this.updateBudget({ maxSessionTokens, maxSessionCost });
    }
    async setTokenBudget(maxSessionTokens) {
        return this.updateBudget({ maxSessionTokens });
    }
    async recordUsage(usage, cost) {
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
                }
                else {
                    if (!cost.usdMicroUnits)
                        ledger.cost.unavailableUsdTokens += billedTokens;
                    if (!cost.cnyMicroUnits)
                        ledger.cost.unavailableCnyTokens += billedTokens;
                }
                if (cost.usdMicroUnits)
                    ledger.cost.usdMicroUnits = addIntegers(ledger.cost.usdMicroUnits, cost.usdMicroUnits);
                if (cost.cnyMicroUnits)
                    ledger.cost.cnyMicroUnits = addIntegers(ledger.cost.cnyMicroUnits, cost.cnyMicroUnits);
                if (cost.exchangeRate)
                    ledger.cost.lastExchangeRate = { ...cost.exchangeRate };
            }
            await this.save(ledger);
            return ledger;
        });
    }
    async updateLedger(update) {
        return this.serial(async () => {
            const ledger = await this.load();
            update(ledger);
            await this.save(ledger);
            return ledger;
        });
    }
    async markCleared(uptoIndex) {
        if (!Number.isSafeInteger(uptoIndex) || uptoIndex < 0)
            throw new Error("Clear index must be a non-negative integer");
        return this.updateLedger((ledger) => {
            ledger.cleared = { uptoIndex, at: new Date().toISOString() };
        });
    }
    async replaceLedger(value) {
        return this.serial(async () => {
            const ledger = normalizeLedger(value && typeof value === "object" ? value : {});
            await this.save(ledger);
            return ledger;
        });
    }
    async recordCacheBreakpoints(messageIds) {
        return this.serial(async () => {
            const ledger = await this.load();
            ledger.cacheBreakpoints = [...new Set(messageIds)].slice(-3);
            await this.save(ledger);
            return ledger;
        });
    }
    async advanceRound() {
        return this.serial(async () => {
            const ledger = await this.load();
            ledger.round += 1;
            await this.save(ledger);
            return ledger;
        });
    }
    async evict(messages) {
        return this.serial(async () => {
            const ledger = await this.load();
            const toolMessages = messages.filter((message) => message.role === "tool");
            if (!ledger.policy.enabled || ledger.policy.strategy === "off")
                return ledger;
            const eligible = ledger.policy.strategy === "lag"
                ? toolMessages.slice(0, Math.max(0, toolMessages.length - ledger.policy.lag))
                : ledger.policy.strategy === "interval" && ledger.round % Math.max(1, ledger.policy.interval) === 0
                    ? toolMessages.slice(0, Math.max(0, toolMessages.length - ledger.policy.lag))
                    : [];
            for (const message of eligible) {
                const existing = ledger.entries.find((entry) => entry.messageId === message.id);
                if (existing) {
                    if (existing.pinnedUntilRound >= ledger.round)
                        continue;
                    existing.state = "evicted";
                    delete existing.restoredAt;
                    continue;
                }
                const result = message.content.find((block) => block.type === "tool_result");
                if (!result || result.type !== "tool_result")
                    continue;
                const artifactId = `artifact-${randomUUID()}`;
                await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
                await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
                ledger.entries.push({ messageId: message.id, kind: "tool_result", artifactId, state: "evicted", createdRound: ledger.round, pinnedUntilRound: 0 });
            }
            await this.save(ledger);
            return ledger;
        });
    }
    async readArtifact(artifactId, offset, limit) {
        if (!/^artifact-[0-9a-f-]{36}$/.test(artifactId))
            throw new Error("Invalid artifact ID");
        if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error("offset must be a non-negative integer");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000)
            throw new Error("limit must be between 1 and 64000");
        try {
            const content = await readFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), "utf8");
            return content.slice(offset, offset + limit);
        }
        catch (error) {
            if (isMissing(error))
                throw new Error("Artifact not found");
            throw error;
        }
    }
    serial(operation) {
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
    async restore(messageId) {
        return this.serial(async () => {
            const ledger = await this.load();
            const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
            if (!entry)
                throw new Error("No evicted tool result for message");
            entry.state = "restored";
            entry.restoredAt = new Date().toISOString();
            entry.pinnedUntilRound = ledger.round + ledger.policy.pinExemptRounds;
            await this.save(ledger);
            return ledger;
        });
    }
}
function normalizePolicy(value) {
    const policy = { ...DEFAULT_POLICY, ...(value ?? {}) };
    const cost = value?.maxSessionCost;
    if (cost && (cost.currency === "USD" || cost.currency === "CNY") && /^[1-9]\d*$/.test(cost.microUnits)) {
        policy.maxSessionCost = { ...cost };
    }
    else {
        delete policy.maxSessionCost;
    }
    if (policy.maxSessionTokens !== undefined && (!Number.isSafeInteger(policy.maxSessionTokens) || policy.maxSessionTokens < 1)) {
        delete policy.maxSessionTokens;
    }
    return policy;
}
function isCompaction(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return Number.isSafeInteger(record.uptoIndex) && (record.uptoIndex ?? -1) >= 0 &&
        typeof record.mode === "string" && ["toolcalls", "overview", "truncated"].includes(record.mode) &&
        typeof record.summary === "string" &&
        Array.isArray(record.instructions) &&
        typeof record.createdAt === "string";
}
/** 注入视图的压缩文本：用户明确指令累积置顶（§7.4 overview 契约）。 */
function renderCompaction(record) {
    if (record.instructions.length === 0)
        return record.summary;
    return [
        "用户明确指令（跨段累积，务必继续遵守）：",
        ...record.instructions.map((item) => `- ${item}`),
        "",
        record.summary,
    ].join("\n");
}
/** 图像独立预算（§7.3②）：视图中至多保留最新 MAX_IMAGES 张且不超 MAX_IMAGE_BYTES，更早的替换为占位文本。 */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function enforceImageBudget(view) {
    let count = 0;
    let bytes = 0;
    for (let m = view.length - 1; m >= 0; m -= 1) {
        const content = view[m].content;
        for (let b = content.length - 1; b >= 0; b -= 1) {
            const block = content[b];
            if (block.type !== "image")
                continue;
            const size = Math.ceil(block.data.length * 3 / 4);
            if (count < MAX_IMAGES && bytes + size <= MAX_IMAGE_BYTES) {
                count += 1;
                bytes += size;
            }
            else {
                content[b] = { type: "text", text: `[image omitted from LLM context: ${block.mediaType}, ${Math.round(size / 1024)}KB]` };
            }
        }
    }
}
function normalizeLedger(value) {
    const usage = value.usage;
    const cost = value.cost;
    return {
        version: 1,
        round: Number.isSafeInteger(value.round) && (value.round ?? -1) >= 0 ? value.round : 0,
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
            ? value.cacheBreakpoints.filter((item) => typeof item === "string").slice(-3)
            : [],
        ...(isCompaction(value.compacted)
            ? { compacted: { ...value.compacted, instructions: value.compacted.instructions.filter((item) => typeof item === "string") } }
            : {}),
        ...(value.cleared && Number.isSafeInteger(value.cleared.uptoIndex) && value.cleared.uptoIndex >= 0 && typeof value.cleared.at === "string" && Number.isFinite(Date.parse(value.cleared.at))
            ? { cleared: { uptoIndex: value.cleared.uptoIndex, at: value.cleared.at } }
            : {}),
    };
}
export function selectCacheBreakpoints(messages, ledger) {
    const selected = [];
    const lastEvicted = [...ledger.entries].reverse().find((entry) => entry.state === "evicted");
    if (lastEvicted)
        selected.push(lastEvicted.messageId);
    const users = messages.filter((message) => message.role === "user");
    if (users.length >= 2)
        selected.push(users[users.length - 2].id);
    return [...new Set(selected)].slice(-3);
}
function safeTokenCount(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
function integerString(value) {
    return typeof value === "string" && /^\d+$/.test(value) ? value : "0";
}
function addIntegers(left, right) {
    if (!/^\d+$/.test(right))
        throw new Error("Cost must be a non-negative integer string");
    return (BigInt(left) + BigInt(right)).toString();
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
