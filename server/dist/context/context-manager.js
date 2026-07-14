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
    constructor(sessionRoot) {
        this.sessionRoot = sessionRoot;
    }
    async load() {
        try {
            return JSON.parse(await readFile(path.join(this.sessionRoot, "ledger.json"), "utf8"));
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            return { version: 1, round: 0, policy: { ...DEFAULT_POLICY }, entries: [], usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 } };
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
        const view = messages.map((message) => ({ ...message, content: message.content.map((block) => ({ ...block })) }));
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
        return { messages: view, ledger };
    }
    async recordUsage(usage) {
        const ledger = await this.load();
        ledger.usage.inputTokens += usage.inputTokens;
        ledger.usage.outputTokens += usage.outputTokens;
        ledger.usage.cacheRead += usage.cacheRead;
        ledger.usage.cacheWrite += usage.cacheWrite;
        await this.save(ledger);
        return ledger;
    }
    async advanceRound() {
        const ledger = await this.load();
        ledger.round += 1;
        await this.save(ledger);
        return ledger;
    }
    async evict(messages) {
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
    }
    async restore(messageId) {
        const ledger = await this.load();
        const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
        if (!entry)
            throw new Error("No evicted tool result for message");
        entry.state = "restored";
        entry.restoredAt = new Date().toISOString();
        entry.pinnedUntilRound = ledger.round + ledger.policy.pinExemptRounds;
        await this.save(ledger);
        return ledger;
    }
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
