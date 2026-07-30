import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike, PathNormalizeRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-pathnorm-"));
  roots.push(root);
  return root;
}

/** 仿 core path.normalize 的确定性 canonicalize：相对拼 cwd、去 ./ 与重复分隔符、
 * 绝对路径原样保留盘符；相对路径含 .. 时抛错（core 返回 -32602，调用方回退）。 */
function canonicalize(cwd: string, p: string): string {
  const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(p);
  if (!isAbs && /(^|[\\/])\.\.([\\/]|$)/.test(p)) throw new Error("path cannot be normalized");
  const joined = isAbs ? p : `${cwd}/${p}`;
  const parts = joined.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  return parts.join("/");
}

function createCore(cwd: string, options: { normalizeThrows?: boolean } = {}): CoreClientLike {
  return {
    on() { return this; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile() { return { content: "file content" }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    async writeFile() { return { ok: true }; },
    async editFile() { return { matches: 1 }; },
    async run() { return { exitCode: 0, durationMs: 1, truncated: false }; },
    async cleanupSession() { return { ok: true }; },
    async normalizePath(request: PathNormalizeRequest) {
      if (options.normalizeThrows) throw new Error("path.normalize unavailable");
      return { path: canonicalize(cwd, request.path), allowed: true, root: cwd };
    },
    setRequestTimeoutMs() {},
    start() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
    stop() { return Promise.resolve(); },
    ping() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
    listFiles() { return Promise.resolve({ entries: [], truncated: false }); },
  } as unknown as CoreClientLike;
}

describe("path.normalize — 权限规则键 canonical 化", () => {
  async function setup(cwd: string, core: CoreClientLike, toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>) {
    const root = cwd;
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "ask", []);

    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (event: AppEvent) => captured.push(event));
    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        void request;
        if (!providerCalled) {
          providerCalled = true;
          for (const tc of toolCalls) yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.input };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    let providerCalled = false;
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, events, pricing);
    return { runner, session, sessions, captured, root };
  }

  it("write_file 的 ./ 与绝对路径拼写归一为同一条 allow-always 规则", async () => {
    const root = await tempRoot();
    const core = createCore(root);
    const absOut = path.join(root, "out.txt");
    const { runner, session, sessions, captured } = await setup(root, core, [
      { name: "write_file", id: "wf-1", input: { path: "./out.txt", content: "a" } },
      { name: "write_file", id: "wf-2", input: { path: absOut, content: "b" } },
    ]);
    expect(session.cwd).toBe(root);

    const runPromise = runner.run(session.id, "go");
    // 第一个调用挂起审批；allow_always 后规则落库
    const requestId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no permission.request within 5s")), 5_000);
      const check = (): void => {
        const req = captured.find((event) => event.type === "permission.request");
        if (req) {
          clearTimeout(timer);
          resolve((req.payload as { requestId: string }).requestId);
        } else setTimeout(check, 20);
      };
      check();
    });
    const complete = await runner.preparePermissionResponse(session.id, requestId, "allow_always");
    expect(complete).toBeDefined();
    complete!();
    await runPromise;

    // 只挂起一次：第二个调用命中同一 canonical 规则
    const requests = captured.filter((event) => event.type === "permission.request");
    expect(requests.length).toBe(1);
    // 确认卡片与规则键都是 canonical path（core 归一化结果）
    const canonical = canonicalize(root, "out.txt");
    expect((requests[0]!.payload as { input: { path: string } }).input.path).toBe(canonical);
    const detail = await sessions.get(session.id);
    expect(detail?.permissionRules).toEqual([{ tool: "write_file", argumentPrefix: canonical }]);
    // 两个 tool_result 均成功
    const toolResults = detail?.messages.filter((m) => m.role === "tool").flatMap((m) => m.content) ?? [];
    expect(toolResults.filter((c) => c.type === "tool_result" && c.isError).length).toBe(0);
  }, 15_000);

  it("normalizePath 抛错时回退原始路径作为规则键", async () => {
    const root = await tempRoot();
    const core = createCore(root, { normalizeThrows: true });
    const { runner, session, sessions, captured } = await setup(root, core, [
      { name: "write_file", id: "wf-1", input: { path: "out.txt", content: "a" } },
    ]);

    const runPromise = runner.run(session.id, "go");
    const requestId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no permission.request within 5s")), 5_000);
      const check = (): void => {
        const req = captured.find((event) => event.type === "permission.request");
        if (req) {
          clearTimeout(timer);
          resolve((req.payload as { requestId: string }).requestId);
        } else setTimeout(check, 20);
      };
      check();
    });
    const complete = await runner.preparePermissionResponse(session.id, requestId, "allow_always");
    complete!();
    await runPromise;

    const detail = await sessions.get(session.id);
    expect(detail?.permissionRules).toEqual([{ tool: "write_file", argumentPrefix: "out.txt" }]);
  }, 15_000);
});
