// 基准：agent loop 历史读取热路径（SessionStore.get + ContextManager.buildView）。
// 复现 agent-runner 每轮真实调用序列（agent-runner.ts 每 turn 开头 sessions.get →
// buildView，工具批次后再次 sessions.get），但不接 provider/工具：
//   每 turn: get → buildView → appendMessage(assistant) → appendMessage(tool) → get
// 数据基于 long-history 数据集前 --messages 条，复制到独立临时目录（不污染固定数据集）。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-agent-loop.mjs [--messages=5000] [--turns=50] [--out path]
// 前置：先跑 generate-dataset.mjs

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DATA_DIR, parseArgs, summarize, tryGc, writeResult } from "./lib/common.mjs";

const SESSION_ID = "01234567-89ab-4def-8012-3456789abcde";
const BASE_TIME = Date.parse("2026-07-01T00:00:00.000Z");

const args = parseArgs(process.argv.slice(2));
const MESSAGE_COUNT = Number.parseInt(args.messages ?? "5000", 10);
const TURNS = Number.parseInt(args.turns ?? "50", 10);
if (!Number.isSafeInteger(MESSAGE_COUNT) || MESSAGE_COUNT < 1) throw new Error("--messages 必须是正整数");
if (!Number.isSafeInteger(TURNS) || TURNS < 1) throw new Error("--turns 必须是正整数");

const datasetDir = path.join(DATA_DIR, "long-history", ".sessions", SESSION_ID);
if (!existsSync(path.join(datasetDir, "messages.jsonl"))) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

const { SessionStore } = await import("../../server/src/sessions/session-store.ts");
const { ContextManager } = await import("../../server/src/context/context-manager.ts");

// 独立临时会话：取数据集前 MESSAGE_COUNT 条，activeLeafId 指向保留的最后一条。
const root = await mkdtemp(path.join(os.tmpdir(), "owc-bench-agent-loop-"));
const storeRoot = path.join(root, ".sessions");
const sessionRoot = path.join(storeRoot, SESSION_ID);

try {
  const raw = await readFile(path.join(datasetDir, "messages.jsonl"), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  if (lines.length < MESSAGE_COUNT) throw new Error(`数据集只有 ${lines.length} 条消息，无法满足 --messages=${MESSAGE_COUNT}`);
  const kept = lines.slice(0, MESSAGE_COUNT);
  const lastMessage = JSON.parse(kept[kept.length - 1]);
  await mkdir(sessionRoot, { recursive: true });
  const meta = {
    id: SESSION_ID,
    cwd: "D:/bench/fixture",
    provider: "bench",
    model: "bench-model",
    title: "bench agent-loop fixture",
    createdAt: new Date(BASE_TIME).toISOString(),
    updatedAt: new Date(BASE_TIME).toISOString(),
    activeLeafId: lastMessage.id,
  };
  await writeFile(path.join(sessionRoot, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await writeFile(path.join(sessionRoot, "messages.jsonl"), kept.join("\n") + "\n", "utf8");

  const store = new SessionStore(storeRoot);

  // 预热：冷加载（首次全量解析 + ledger 初始化）不属于稳态热路径。
  const warmSession = await store.get(SESSION_ID);
  await new ContextManager(sessionRoot).buildView(warmSession.messages);

  let turnCounter = 0;
  const makeAppend = (role, parentId) => {
    turnCounter++;
    return {
      role,
      content: role === "assistant"
        ? [{ type: "text", text: `bench turn ${turnCounter} reply` }, { type: "tool_call", id: `call_bench_${turnCounter}`, name: "read_file", input: { path: `src/f-${turnCounter}.ts` } }]
        : [{ type: "tool_result", toolCallId: `call_bench_${turnCounter - 1}`, content: `bench turn ${turnCounter} tool output`, isError: false }],
      parentId,
    };
  };

  const getSamples = [];
  const buildSamples = [];
  tryGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const wallStart = performance.now();

  for (let turn = 0; turn < TURNS; turn++) {
    // —— turn 开头（agent-runner.ts 每 turn 的 sessions.get + buildView）——
    let start = performance.now();
    const session = await store.get(SESSION_ID);
    getSamples.push(performance.now() - start);
    if (!session) throw new Error("Session not found");

    const context = new ContextManager(sessionRoot);
    start = performance.now();
    await context.buildView(session.messages);
    buildSamples.push(performance.now() - start);

    // —— 工具批次（assistant + tool_result 落盘）——
    const assistant = makeAppend("assistant", session.messages.at(-1).id);
    const assistantMsg = await store.appendMessage(SESSION_ID, assistant.role, assistant.content, { parentId: assistant.parentId });
    const tool = makeAppend("tool", assistantMsg.id);
    await store.appendMessage(SESSION_ID, tool.role, tool.content, { parentId: tool.parentId });

    // —— 工具批次后（agent-runner.ts 的 afterTools get + evict 输入）——
    start = performance.now();
    const afterTools = await store.get(SESSION_ID);
    getSamples.push(performance.now() - start);
    if (!afterTools) throw new Error("Session not found");
    await context.advanceRound();
  }

  const wallMs = performance.now() - wallStart;
  tryGc();
  const heapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

  const finalSession = await store.get(SESSION_ID);
  const get = summarize(getSamples);
  const build = summarize(buildSamples);

  await writeResult("agent-loop", [
    { name: "get.p50", value: get.p50, unit: "ms", direction: "lower-better", minDelta: 0.5 },
    { name: "get.p95", value: get.p95, unit: "ms", direction: "lower-better", minDelta: 0.5 },
    { name: "buildView.p50", value: build.p50, unit: "ms", direction: "lower-better", minDelta: 0.5 },
    { name: "buildView.p95", value: build.p95, unit: "ms", direction: "lower-better", minDelta: 0.5 },
    { name: "turn.wallTotal", value: Math.round(wallMs * 100) / 100, unit: "ms", direction: "lower-better" },
    { name: "heapDelta", value: Math.round(heapDeltaMB * 100) / 100, unit: "MiB", direction: "lower-better" },
    { name: "dataset.messages", value: MESSAGE_COUNT, unit: "count", direction: "none" },
    { name: "params.turns", value: TURNS, unit: "count", direction: "none" },
    { name: "final.messages", value: finalSession.messages.length, unit: "count", direction: "none" },
  ], args.out, {
    params: { messages: MESSAGE_COUNT, turns: TURNS },
    samples: { getMs: getSamples.map((v) => Math.round(v * 100) / 100), buildViewMs: buildSamples.map((v) => Math.round(v * 100) / 100) },
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
