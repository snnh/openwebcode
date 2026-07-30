import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { appendSwarmBoard, digestSwarmBoard, readSwarmBoard, swarmBoardPath } from "../src/agent/swarm-board.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-swarm-board-"));
  roots.push(root);
  return root;
}

function createFakeCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile() { return { content: "文件内容" }; },
    async globFiles() { return { matches: [] }; },
    async grepFiles() { return { matches: [] }; },
  };
  return core as unknown as CoreClientLike;
}

describe("swarm-board 模块", () => {
  it("post/read 往返与 since 增量读", async () => {
    const root = await tempRoot();
    const board = swarmBoardPath(root, "s1");
    expect(board).toBe(path.join(root, "subagents", "swarm-s1-board.jsonl"));

    // 空板读取
    expect(await readSwarmBoard(board)).toMatchObject({ entries: [], offset: 0, total: 0 });

    expect(await appendSwarmBoard(board, "a", "第一条")).toBe(true);
    expect(await appendSwarmBoard(board, "b", "第二条")).toBe(true);

    const full = await readSwarmBoard(board);
    expect(full.total).toBe(2);
    expect(full.entries.map((entry) => [entry.from, entry.text])).toEqual([["a", "第一条"], ["b", "第二条"]]);

    // since 增量：只拿新条目
    const incremental = await readSwarmBoard(board, full.offset);
    expect(incremental.entries).toEqual([]);
    await appendSwarmBoard(board, "a", "第三条");
    const next = await readSwarmBoard(board, full.offset);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({ from: "a", text: "第三条" });

    // digest：路径、总条数、各成员发帖数、最后几条
    const digest = await digestSwarmBoard(board);
    expect(digest).toContain("3 entries");
    expect(digest).toContain("a=2");
    expect(digest).toContain("b=1");
    expect(digest).toContain("第三条");
  });

  it("超长文本截断、损坏行跳过、空板 digest 省略", async () => {
    const root = await tempRoot();
    const board = swarmBoardPath(root, "s2");
    expect(await digestSwarmBoard(board)).toBeUndefined();

    await appendSwarmBoard(board, "a", "x".repeat(600));
    // 混一行坏 JSON
    await appendFile(board, "not-json\n", "utf8");
    const snapshot = await readSwarmBoard(board);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.text).toHaveLength(501); // 500 + 省略号
  });
});

interface SwarmBoardFixture {
  sessions: SessionStore;
  runner: AgentRunner;
  requests: StreamChatRequest[];
  sessionId: string;
  /** 成员 read 到的板内容（按 prompt 记录） */
  boardReads: Map<string, string>;
}

/**
 * 主循环第一轮调用指定工具；swarm 成员三轮：post -> read -> 结论；
 * spawn_task 子代理直接回结论。记录子代理 read 到的板内容。
 */
async function setupSwarmBoard(mainCall: { name: string; input: Record<string, unknown> }): Promise<SwarmBoardFixture> {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
  await sessions.updateConfig(session.id, { provider: "fake", model: "test-model", swarmEnabled: true });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  events.on("event", (_event: AppEvent) => {});

  const requests: StreamChatRequest[] = [];
  const boardReads = new Map<string, string>();
  const subTurns = new Map<string, number>();
  let mainTurn = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(request) {
      requests.push(request);
      if (request.system.includes("exploration sub-agent")) {
        const last = request.messages.at(-1);
        if (request.system.includes("Shared discussion board")) {
          // swarm 成员：按轮次 post -> read -> 结论
          const firstUser = request.messages[0]?.content.find((block) => block.type === "text");
          const prompt = firstUser?.type === "text" ? firstUser.text : "";
          const turn = subTurns.get(prompt) ?? 0;
          subTurns.set(prompt, turn + 1);
          if (turn === 0) {
            yield { type: "tool_call", id: `post-${prompt}`, name: "swarm_board_post", input: { text: `发现：${prompt}` } };
            yield { type: "done", stopReason: "tool_use" };
            return;
          }
          if (turn === 1) {
            yield { type: "tool_call", id: `read-${prompt}`, name: "swarm_board_read", input: {} };
            yield { type: "done", stopReason: "tool_use" };
            return;
          }
          // 第三轮：last 是 tool 消息，取出 read 结果
          const readResult = last?.content.find((block) => block.type === "tool_result" && String(block.toolCallId).startsWith("read-"));
          if (readResult?.type === "tool_result") boardReads.set(prompt, readResult.content);
          yield { type: "text_delta", text: `结论：${prompt}` };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        // 非 swarm 子代理（spawn_task）：直接回结论
        yield { type: "text_delta", text: "结论：普通子代理" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      if (mainTurn++ === 0) {
        yield { type: "tool_call", id: "main-1", name: mainCall.name, input: mainCall.input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const runner = new AgentRunner(sessions, providers, createFakeCore(), events, pricing);
  return { sessions, runner, requests, sessionId: session.id, boardReads };
}

async function mainToolResult(fixture: SwarmBoardFixture) {
  const detail = await fixture.sessions.get(fixture.sessionId);
  return detail?.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.toolCallId === "main-1");
}

describe("swarm 共享讨论板（AgentRunner 集成）", () => {
  it("成员经讨论板协作：板文件创建、post/read 往返、boardDigest 汇总", async () => {
    const fixture = await setupSwarmBoard({
      name: "spawn_swarm",
      input: { prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"] },
    });
    await fixture.runner.run(fixture.sessionId, "并行评审");

    const toolResult = await mainToolResult(fixture);
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false });
    const content = (toolResult as { content: string }).content;
    expect(content).toContain("[1/2] 结论：评审 a.ts");

    // 板文件已创建，两行（两名成员各一帖）
    const contextRoot = fixture.sessions.contextRoot(fixture.sessionId);
    const boardFile = path.join(contextRoot, "subagents", "swarm-main-1-board.jsonl");
    const lines = (await readFile(boardFile, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const entry = JSON.parse(line) as { ts: string; from: string; text: string };
      expect(entry.ts).toBeTruthy();
      expect(entry.from).toBeTruthy();
      expect(entry.text).toMatch(/^发现：评审 [ab]\.ts$/);
    }

    // post/read 往返：每名成员至少读到自己那帖
    expect(fixture.boardReads.size).toBe(2);
    for (const [prompt, board] of fixture.boardReads) {
      expect(board).toContain(`发现：${prompt}`);
      expect(board).toContain("offset=");
    }

    // 汇总结果附 boardDigest：路径、总条数、各成员发帖数、最后几条
    expect(content).toContain("Board digest");
    expect(content).toContain("swarm-main-1-board.jsonl");
    expect(content).toContain("2 entries");
    expect(content).toContain("member posts:");
    expect(content).toContain("=1");

    // 子代理请求携带板工具与讨论板提示；主 agent 不携带
    const subRequests = fixture.requests.filter((request) => request.system.includes("exploration sub-agent"));
    expect(subRequests).toHaveLength(6); // 2 成员 × 3 轮
    expect(subRequests.every((request) => {
      const names = request.tools.map((tool) => tool.name);
      return names.includes("swarm_board_post") && names.includes("swarm_board_read");
    })).toBe(true);
    expect(subRequests.every((request) => request.system.includes("Shared discussion board"))).toBe(true);
    const mainRequest = fixture.requests.find((request) => !request.system.includes("exploration sub-agent"));
    expect((mainRequest?.tools ?? []).map((tool) => tool.name)).not.toContain("swarm_board_post");
    expect((mainRequest?.tools ?? []).map((tool) => tool.name)).not.toContain("swarm_board_read");
  });

  it("普通 spawn_task 子代理拿不到讨论板工具", async () => {
    const fixture = await setupSwarmBoard({ name: "spawn_task", input: { prompt: "单独探索" } });
    await fixture.runner.run(fixture.sessionId, "单任务");

    const toolResult = await mainToolResult(fixture);
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false });

    const subRequests = fixture.requests.filter((request) => request.system.includes("exploration sub-agent"));
    expect(subRequests.length).toBeGreaterThan(0);
    for (const request of subRequests) {
      const names = request.tools.map((tool) => tool.name);
      expect(names).not.toContain("swarm_board_post");
      expect(names).not.toContain("swarm_board_read");
      expect(request.system).not.toContain("Shared discussion board");
    }

    // 未创建任何讨论板文件
    const contextRoot = fixture.sessions.contextRoot(fixture.sessionId);
    const files = await readdir(path.join(contextRoot, "subagents"));
    expect(files.every((file) => !file.startsWith("swarm-"))).toBe(true);
  });
});
