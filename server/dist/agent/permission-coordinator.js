import { randomUUID } from "node:crypto";
export class PermissionCoordinator {
    events;
    pending = new Map();
    constructor(events) {
        this.events = events;
    }
    needsApproval(mode, rules, tool, input) {
        // 只读工具 + remember 自动放行：remember 是 agent 写自身长期记忆（低风险），
        // 写入路径固定为 <cwd>/.owc/memory.md 或 <dataDir>/memory.md，不接受任意路径
        if (["read_file", "glob", "grep", "read_artifact", "load_skill", "spawn_task", "remember"].includes(tool))
            return false;
        if (mode === "yolo")
            return false;
        if (mode === "acceptEdits" && ["write_file", "edit_file"].includes(tool))
            return false;
        return !rules.some((rule) => matchesRule(rule, tool, input));
    }
    request(sessionId, tool, input, signal) {
        signal.throwIfAborted();
        const requestId = randomUUID();
        return new Promise((resolve) => {
            const abort = () => {
                this.pending.delete(requestId);
                resolve({ allowed: false, reason: "Permission request aborted", persist: false });
            };
            this.pending.set(requestId, { sessionId, tool, input, resolve, signal, abort });
            signal.addEventListener("abort", abort, { once: true });
            this.events.publish({ source: "agent", type: "permission.request", sessionId, payload: { requestId, tool, input } });
        });
    }
    listPending(sessionId) {
        const result = [];
        for (const [requestId, pending] of this.pending) {
            if (pending.sessionId === sessionId)
                result.push({ requestId, tool: pending.tool, input: pending.input });
        }
        return result;
    }
    respond(sessionId, requestId, decision, reason) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.sessionId !== sessionId)
            return undefined;
        this.pending.delete(requestId);
        pending.signal.removeEventListener("abort", pending.abort);
        const persist = decision === "allow_always";
        return {
            tool: pending.tool,
            input: pending.input,
            persist,
            complete: (allowed = decision !== "deny", failureReason = reason) => pending.resolve({ allowed, ...(failureReason ? { reason: failureReason } : {}), persist: allowed && persist }),
        };
    }
    cancelSession(sessionId) {
        for (const [id, pending] of this.pending) {
            if (pending.sessionId !== sessionId)
                continue;
            this.pending.delete(id);
            pending.signal.removeEventListener("abort", pending.abort);
            pending.resolve({ allowed: false, reason: "Session stopped", persist: false });
        }
    }
}
export function permissionRule(tool, input) {
    if (tool === "bash" && typeof input.cmd === "string")
        return { tool, argumentPrefix: input.cmd };
    if (["write_file", "edit_file"].includes(tool) && typeof input.path === "string")
        return { tool, argumentPrefix: input.path };
    return { tool };
}
function matchesRule(rule, tool, input) {
    if (rule.tool !== tool)
        return false;
    if (rule.argumentPrefix === undefined)
        return true;
    const value = tool === "bash" ? input.cmd : input.path;
    if (typeof value !== "string")
        return false;
    if (tool === "bash")
        return value === rule.argumentPrefix;
    return value === rule.argumentPrefix || value.startsWith(`${rule.argumentPrefix}/`);
}
