import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContextManager } from "../context/context-manager.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { collectProviderTurn } from "../providers/retry.js";
/**
 * 子代理允许使用的只读工具全集（构造上只读；spawn_task 不在其中，子代理不可再派生）。
 */
export const SUB_AGENT_TOOL_NAMES = ["read_file", "glob", "grep", "read_artifact"];
export const SUB_AGENT_CONCLUSION_LIMIT = 2_000;
const SUB_AGENT_TOOLS = [
    { name: "read_file", description: "Read UTF-8 lines from a workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false } },
    { name: "glob", description: "Recursively match workspace paths using * and ? wildcards.", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
    { name: "grep", description: "Recursively search UTF-8 workspace files for literal text.", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
    { name: "read_artifact", description: "Read a bounded slice of a tool-output artifact when an evicted or truncated result points to an artifact ID.", inputSchema: { type: "object", properties: { artifactId: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["artifactId", "offset", "limit"], additionalProperties: false } },
];
export async function runSubAgent(options) {
    const maxTurns = options.maxTurns ?? 15;
    const allowed = new Set(options.toolNames.filter((name) => SUB_AGENT_TOOL_NAMES.includes(name)));
    const tools = SUB_AGENT_TOOLS.filter((tool) => allowed.has(tool.name));
    const system = `You are a read-only exploration sub-agent spawned by OpenWebCode. The workspace is ${options.cwd}. ` +
        "You run in an isolated context and cannot see the parent conversation. " +
        "You may only use the read-only tools provided; you cannot modify files or run commands. " +
        "Investigate the task, then reply with one concise conclusion in the user's language (default 中文). " +
        "Do not ask questions; make reasonable assumptions.";
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    const messages = [subMessage("user", [{ type: "text", text: options.prompt }])];
    const toolsUsed = [];
    let turns = 0;
    let conclusion = "";
    try {
        let finished = false;
        let lastText = "";
        for (let turn = 0; turn < maxTurns; turn++) {
            options.signal.throwIfAborted();
            const result = await collectProviderTurn(options.provider, {
                model: options.model,
                system,
                messages,
                tools,
                signal: options.signal,
            });
            turns += 1;
            const assistantContent = [];
            let text = "";
            let stopReason;
            for (const event of result.events) {
                if (event.type === "text_delta") {
                    text += event.text;
                    assistantContent.push({ type: "text", text: event.text });
                }
                else if (event.type === "tool_call") {
                    assistantContent.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
                }
                else if (event.type === "usage") {
                    await options.onUsage?.(event);
                }
                else if (event.type === "done") {
                    stopReason = event.stopReason;
                }
            }
            if (assistantContent.length > 0)
                messages.push(subMessage("assistant", assistantContent));
            lastText = text || lastText;
            if (stopReason !== "tool_use") {
                finished = true;
                break;
            }
            const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
            if (toolCalls.length === 0) {
                finished = true;
                break;
            }
            const results = [];
            for (const call of toolCalls) {
                if (call.type !== "tool_call")
                    continue;
                const outcome = await executeSubTool(options, allowed, call.name, call.input);
                if (!outcome.isError && !toolsUsed.includes(call.name))
                    toolsUsed.push(call.name);
                results.push({ type: "tool_result", toolCallId: call.id, content: outcome.content, isError: outcome.isError });
            }
            messages.push(subMessage("tool", results));
        }
        conclusion = finished
            ? lastText
            : lastText
                ? `${lastText}\n[reached max turns (${maxTurns}); partial answer]`
                : `[reached max turns (${maxTurns}) without a final answer]`;
        conclusion = truncateConclusion(conclusion);
        return { conclusion, turns, toolsUsed };
    }
    finally {
        // 转录存档：失败只 warn，不影响结论返回
        try {
            await mkdir(path.join(options.contextRoot, "subagents"), { recursive: true });
            await writeFile(path.join(options.contextRoot, "subagents", `${taskId}.json`), `${JSON.stringify({ id: taskId, prompt: options.prompt, startedAt, turns, toolsUsed, conclusion, messages }, null, 2)}\n`, "utf8");
        }
        catch (error) {
            process.stderr.write(`[sub-agent] 转录写入失败：${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
}
async function executeSubTool(options, allowed, name, input) {
    if (!allowed.has(name)) {
        const list = [...allowed].join(", ") || "(none)";
        return { content: `Tool not available to this sub-agent: ${name}. Allowed tools: ${list}`, isError: true };
    }
    try {
        let raw;
        if (name === "read_artifact") {
            const manager = new ContextManager(options.contextRoot);
            raw = await manager.readArtifact(String(input.artifactId), Number(input.offset), Number(input.limit));
        }
        else {
            const targetPath = typeof input.path === "string" ? input.path : "";
            if (!targetPath)
                throw new Error(`${name} requires a non-empty path`);
            let value;
            if (name === "read_file") {
                value = await options.core.readFile({
                    sessionId: options.sessionId,
                    path: targetPath,
                    ...(input.offset === undefined ? {} : { offset: Number(input.offset) }),
                    ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
                });
            }
            else if (name === "glob") {
                value = await options.core.globFiles({ sessionId: options.sessionId, path: targetPath, pattern: String(input.pattern ?? "") });
            }
            else {
                value = await options.core.grepFiles({ sessionId: options.sessionId, path: targetPath, pattern: String(input.pattern ?? "") });
            }
            raw = JSON.stringify(value);
        }
        const bounded = await boundToolResult(options.contextRoot, name, raw);
        return { content: bounded.content, isError: false };
    }
    catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
}
function truncateConclusion(text) {
    if (text.length <= SUB_AGENT_CONCLUSION_LIMIT)
        return text;
    return `${text.slice(0, SUB_AGENT_CONCLUSION_LIMIT)}…(truncated)`;
}
function subMessage(role, content) {
    return { id: randomUUID(), role, content, createdAt: new Date().toISOString() };
}
