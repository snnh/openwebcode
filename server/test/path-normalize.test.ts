import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { PathNormalizeRequest } from "../src/core-client.js";
import type { AppEvent } from "../src/events/event-bus.js";
import type { Provider } from "../src/providers/provider.js";
import { makeAgentHarness } from "./helpers/agent-harness.js";
import { makeFakeCore } from "./helpers/fake-core.js";

/** 轮询 captured 等 permission.request 事件并取其 requestId（15s 超时；Windows CI 高负载下 5s 偶发不够）。 */
async function waitForPermissionRequest(captured: AppEvent[]): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const request = captured.find((event) => event.type === "permission.request");
    if (request) return (request.payload as { requestId: string }).requestId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no permission.request within 15s");
}

/** 仿 core path.normalize 的确定性 canonicalize：相对拼 cwd、去 ./ 与重复分隔符、绝对路径保留盘符；
 * 相对路径含 .. 抛错（core 返回 -32602，调用方回退）；POSIX 保留前导 /，Windows 盘符自带根不补。 */
function canonicalize(cwd: string, p: string): string {
  const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(p);
  if (!isAbs && /(^|[\\/])\.\.([\\/]|$)/.test(p)) throw new Error("path cannot be normalized");
  const joined = isAbs ? p : `${cwd}/${p}`;
  const parts = joined.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  const rooted = /^([\\/])/.test(joined) && !/^[A-Za-z]:$/.test(parts[0] ?? "");
  return (rooted ? "/" : "") + parts.join("/");
}

/** 权限审批链路夹具：core.normalizePath 走 canonicalize（cwd 在 harness 建好临时目录后回填）；
 * provider 首轮按调用方给的路径发 write_file tool_call，次轮收尾。 */
async function setup(normalizeThrows: boolean, toolPaths: (root: string) => Array<{ id: string; path: string }>) {
  let called = false;
  let cwd = "";
  const provider: Provider = {
    name: "fake",
    async *streamChat() {
      if (called) {
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      called = true;
      for (const call of toolPaths(cwd)) yield { type: "tool_call", id: call.id, name: "write_file", input: { path: call.path, content: "a" } };
      yield { type: "done", stopReason: "tool_use" };
    },
  };
  const core = makeFakeCore({
    async normalizePath(request: PathNormalizeRequest) {
      if (normalizeThrows) throw new Error("path.normalize unavailable");
      return { path: canonicalize(cwd, request.path), allowed: true, root: cwd };
    },
  });
  const harness = await makeAgentHarness({ core, provider, permissionMode: "ask", tempPrefix: "owc-pathnorm-" });
  cwd = harness.root;
  const captured: AppEvent[] = [];
  harness.events.on("event", (event: AppEvent) => captured.push(event));
  return { ...harness, captured };
}

/** 跑一轮：等首个 permission.request → allow_always 应答 → 等 run 结束。 */
async function approveFirst(agent: AgentRunner, sessionId: string, captured: AppEvent[], run: Promise<unknown>): Promise<void> {
  const requestId = await waitForPermissionRequest(captured);
  (await agent.preparePermissionResponse(sessionId, requestId, "allow_always"))!();
  await run;
}

describe("path.normalize — 权限规则键 canonical 化", () => {
  it("write_file 的 ./ 与绝对路径拼写归一为同一条 allow-always 规则", async () => {
    const { agent, session, sessions, captured, root, app } = await setup(false, (root) => [{ id: "wf-1", path: "./out.txt" }, { id: "wf-2", path: path.join(root, "out.txt") }]);
    expect(session.cwd).toBe(root);
    await approveFirst(agent, session.id, captured, agent.run(session.id, "go"));
    // 只挂起一次：第二个调用命中同一 canonical 规则；卡片与规则键都是 canonical path（write_file 落 dirname 前缀）
    const requests = captured.filter((event) => event.type === "permission.request");
    expect(requests).toHaveLength(1);
    const canonical = canonicalize(root, "out.txt");
    expect((requests[0]!.payload as { input: { path: string } }).input.path).toBe(canonical);
    const detail = await sessions.get(session.id);
    expect(detail?.permissionRules).toMatchObject([{ tool: "write_file", argumentPrefix: path.posix.dirname(canonical) }]);
    // 两个 tool_result 均成功
    expect(detail?.messages.some((m) => m.content.some((c) => c.type === "tool_result" && c.isError))).toBe(false);
    await app.close();
  }, 15_000);

  it("normalizePath 抛错时回退原始路径作为规则键", async () => {
    const { agent, session, sessions, captured, app } = await setup(true, () => [{ id: "wf-1", path: "out.txt" }]);
    await approveFirst(agent, session.id, captured, agent.run(session.id, "go"));
    // 回退原始相对路径 "out.txt"：dirname 为 "." 时按原值保留（不放大为整目录）
    expect((await sessions.get(session.id))?.permissionRules).toMatchObject([{ tool: "write_file", argumentPrefix: "out.txt" }]);
    await app.close();
  }, 15_000);
});
