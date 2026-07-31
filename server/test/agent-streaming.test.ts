import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("AgentRunner live streaming", () => {
  it("publishes deltas during the stream with tool_call_delta and a reset on retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-agent-live-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "live", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
      async readFile() { return { content: "file", totalLines: 1, encoding: "utf-8", truncated: false }; },
    } as unknown as CoreClient;

    let attempt = 0;
    const provider: Provider = {
      name: "live",
      async *streamChat() {
        attempt += 1;
        if (attempt === 1) {
          // 第一次 attempt 流出部分文本后失败：前端应收到 stream_reset 而不是重复文本
          yield { type: "text_delta", text: " partial" };
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        if (attempt === 2) {
          yield { type: "text_delta", text: "hello " };
          yield { type: "text_delta", text: "world" };
          yield { type: "tool_call_delta", id: "c1", name: "read_file", argumentsDelta: "" };
          yield { type: "tool_call_delta", id: "c1", argumentsDelta: "{\"path\":\"a.ts\"}" };
          yield { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.ts" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const seen: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event: { type: string; payload: unknown }) => seen.push({ type: event.type, payload: event.payload }));
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "stream it");
    expect(attempt).toBe(3);

    const types = seen.map((event) => event.type);
    const firstDelta = types.indexOf("message.delta");
    const resetAt = types.indexOf("message.stream_reset");
    // 流式发布：delta 先于 run 结束事件；失败 attempt 的 partial 先于 reset，重试文本在其后
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(resetAt).toBeGreaterThan(firstDelta);
    const streamEnd = types.lastIndexOf("agent.state");
    expect(firstDelta).toBeLessThan(streamEnd);
    const deltaText = seen.filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { text: string }).text).join("");
    expect(deltaText).toBe(" partialhello worlddone");
    expect(deltaText.match(/hello /g)).toHaveLength(1);

    const toolDeltas = seen.filter((event) => event.type === "message.tool_call_delta")
      .map((event) => event.payload as { id: string; name?: string; text: string });
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    expect(toolDeltas[0]).toMatchObject({ id: "c1", name: "read_file" });
    expect(toolDeltas.map((delta) => delta.text).join("")).toBe("{\"path\":\"a.ts\"}");

    // 完整 tool_call 仍落盘（流式分片不产生重复内容）
    const detail = await sessions.get(session.id);
    const toolCalls = detail?.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_call") ?? [];
    expect(toolCalls).toEqual([expect.objectContaining({ id: "c1", name: "read_file" })]);
  });
});
