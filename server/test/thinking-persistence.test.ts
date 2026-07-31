import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { BackgroundTaskRegistry } from "../src/agent/background-tasks.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

const core = {
  on() { return core; },
  async configureSession() { return { sandboxCapability: "advisory" }; },
} as unknown as CoreClientLike;

/** 快照用例标准 rig：test provider 固定回一条 text_delta；observed 收集全部事件。 */
async function makeRunner(options: {
  text: string;
  tempPrefix: string;
  cwd?: (root: string) => string;
  snapshotMode?: "manual";
  backgroundTasks?: BackgroundTaskRegistry;
}) {
  const root = await tempRoot(options.tempPrefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: options.cwd ? options.cwd(root) : root, provider: "test", model: "test-model" });
  if (options.snapshotMode) {
    await sessions.updateConfig(session.id, { provider: "test", model: "test-model", snapshotMode: options.snapshotMode });
  }
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register({
    name: "test",
    async *streamChat() {
      yield { type: "text_delta", text: options.text };
      yield { type: "done", stopReason: "end_turn" };
    },
  });
  const events = new EventBus();
  const observed: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event) => observed.push(event));
  const runner = new AgentRunner(
    sessions, providers, core, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, options.backgroundTasks,
  );
  return { sessions, session, runner, observed };
}

describe("thinking persistence", () => {
  it("persists providers that emit thinking deltas without thinking_end", async () => {
    const root = await tempRoot("owc-thinking-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai-compatible", model: "reasoning-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const provider: Provider = {
      name: "openai-compatible",
      async *streamChat() {
        yield { type: "thinking_delta", text: "先分析" };
        yield { type: "thinking_delta", text: "问题。" };
        yield { type: "text_delta", text: "最终答案" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "请回答");

    const detail = await sessions.get(session.id);
    const assistant = detail?.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", text: "先分析问题。", provider: "openai-compatible" },
      { type: "text", text: "最终答案" },
    ]);
  });

  it("skips automatic checkpoints in manual snapshot mode", async () => {
    const { sessions, session, runner } = await makeRunner({
      text: "完成",
      tempPrefix: "owc-manual-snapshot-",
      snapshotMode: "manual",
    });

    await runner.run(session.id, "不要自动快照");

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("skips automatic checkpoint while a background task still uses the workspace", async () => {
    const backgroundTasks = { hasRunningForSession: () => true, drainNotices: () => [] } as unknown as BackgroundTaskRegistry;
    const { sessions, session, runner, observed } = await makeRunner({
      text: "继续执行",
      tempPrefix: "owc-background-snapshot-",
      backgroundTasks,
    });

    await runner.run(session.id, "后台任务还在运行");

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.stringContaining("后台任务") }) }),
    ]));
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("skips automatic checkpoint when app's managed workspace gate only has a shared lease", async () => {
    const { sessions, session, runner, observed } = await makeRunner({
      text: "继续执行",
      tempPrefix: "owc-workspace-lease-snapshot-",
    });

    await runner.run(session.id, "工作区正在读取", {
      managedWorkspace: { automaticSnapshotAllowed: false },
    });

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.stringContaining("文件或命令") }) }),
    ]));
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("continues the user turn when an automatic checkpoint cannot be created", async () => {
    const { sessions, session, runner, observed } = await makeRunner({
      text: "仍然继续",
      tempPrefix: "owc-checkpoint-failure-",
      cwd: (root) => path.join(root, "workspace-was-removed"),
    });
    let downgraded = 0;

    await runner.run(session.id, "不要因为快照失败而丢失这条消息", {
      managedWorkspace: {
        automaticSnapshotAllowed: true,
        downgradeAfterAutomaticSnapshot: () => { downgraded += 1; },
      },
    });

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.any(String) }) }),
    ]));
    expect(downgraded).toBe(1);
    expect(observed.some((event) => event.type === "agent.error")).toBe(false);
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
