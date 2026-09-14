// 基准：上下文构建稳态耗时。
// 复用 long-history 数据集（5000 消息）；实例化 ContextManager，
// 先做一次全量 buildView（预热缓存），再连续 N 次追加 1 条消息后 buildView（模拟稳态 turn）。
// 测量：全量构建耗时 vs 增量构建耗时（p50/p95）、incremental 命中率、堆内存增量。
// 验收指标：增量构建 p50 相比全量构建 p50 下降 >= 50%（speedup >= 2.0）。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-context-build.mjs [--out path]
// 前置：先跑 generate-dataset.mjs

import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { DATA_DIR, mulberry32, parseArgs, pseudoText, summarize, tryGc, writeResult } from "./lib/common.mjs";

const FULL_BUILD_RUNS = 5; // 全量构建重复次数
const INCREMENTAL_RUNS = 20; // 增量构建重复次数（模拟连续 turn）
const SESSION_ID = "01234567-89ab-4def-8012-3456789abcde";

const args = parseArgs(process.argv.slice(2));
const storeRoot = path.join(DATA_DIR, "long-history", ".sessions");
if (!existsSync(path.join(storeRoot, SESSION_ID, "messages.jsonl"))) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

const { SessionStore } = await import("../../server/src/sessions/session-store.ts");
const { ContextManager } = await import("../../server/src/context/context-manager.ts");

const store = new SessionStore(storeRoot);
const session = await store.get(SESSION_ID);
const messages = session.messages;
console.log(`已加载会话：${messages.length} 条消息`);

// ContextManager 需要 sessionRoot（含 ledger.json 的目录）
const sessionRoot = path.join(storeRoot, SESSION_ID);
const manager = new ContextManager(sessionRoot);

// 确定性 PRNG 生成追加消息
const rng = mulberry32(20260725);
let appendCounter = 0;
function makeAppendMessage(parentId) {
  appendCounter++;
  return {
    id: `bench-append-${appendCounter.toString(16).padStart(8, "0")}-4000-8000-${appendCounter.toString(16).padStart(12, "0")}`,
    role: appendCounter % 2 === 0 ? "user" : "assistant",
    createdAt: new Date(Date.now() + appendCounter * 1000).toISOString(),
    parentId,
    content: [{ type: "text", text: pseudoText(rng, 200 + Math.floor(rng() * 300)) }],
  };
}

// ---- 全量构建基准 ----
const fullBuildSamples = [];
for (let i = 0; i < FULL_BUILD_RUNS; i++) {
  tryGc();
  const start = performance.now();
  const view = await manager.buildView(messages, { forceFullRebuild: true });
  fullBuildSamples.push(performance.now() - start);
  if (i === 0) {
    console.log(`全量构建：${view.stats.totalTokens} tokens, incremental=${view.stats.incremental}`);
  }
}

// ---- 增量构建基准 ----
// 先做一次全量预热缓存（模拟真实场景：首包全量，后续增量）
await manager.buildView(messages, { forceFullRebuild: true });

const incrementalSamples = [];
let incrementalHits = 0;
let currentMessages = [...messages];
let lastId = currentMessages[currentMessages.length - 1].id;

tryGc();
const heapBefore = process.memoryUsage().heapUsed;

for (let i = 0; i < INCREMENTAL_RUNS; i++) {
  const newMsg = makeAppendMessage(lastId);
  currentMessages = [...currentMessages, newMsg];
  lastId = newMsg.id;

  const start = performance.now();
  const view = await manager.buildView(currentMessages);
  const elapsed = performance.now() - start;
  incrementalSamples.push(elapsed);
  if (view.stats.incremental) incrementalHits++;
}

tryGc();
const heapAfter = process.memoryUsage().heapUsed;
const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

// ---- 滚动驱逐场景（P1 回归覆盖）：context-saver 每轮新增驱逐条目 ----
// 数据集本身不含 ledger.json（共享数据集的既有口径不动）；本场景在独立目录里
// 自建账本，逐轮驱逐最老的未驱逐工具消息并追加一条新消息，验证增量缓存在
// 条目变化下仍命中（片段级失效），而不是退化为逐轮全量重建。
const evictRoot = path.join(DATA_DIR, "long-history-evict", SESSION_ID);
await mkdir(evictRoot, { recursive: true });
const evictManager = new ContextManager(evictRoot);
const toolMessageIds = messages.filter((m) => m.role === "tool").map((m) => m.id);
const KEEP_FULL_ROUNDS = 10; // 与默认 lag=10 对齐：最近 10 个工具轮保留全文
const makeEntry = (messageId, round) => ({
  messageId,
  kind: "tool_result",
  artifactId: `artifact-${messageId}`,
  state: "evicted",
  createdRound: round,
  pinnedUntilRound: 0,
  toolName: "read_file",
  sizeBytes: 1500,
});
// 初始账本：除最近 10 轮外全部已驱逐（滚动驱逐的稳态）
await evictManager.updateLedger((ledger) => {
  toolMessageIds.slice(0, -KEEP_FULL_ROUNDS).forEach((id, index) => ledger.entries.push(makeEntry(id, index)));
});
await evictManager.buildView(messages, { forceFullRebuild: true }); // 预热缓存

const evictSamples = [];
let evictHits = 0;
let evictMessages = [...messages];
let evictLastId = lastId;
for (let i = 0; i < INCREMENTAL_RUNS; i++) {
  const newMsg = makeAppendMessage(evictLastId);
  evictMessages = [...evictMessages, newMsg];
  evictLastId = newMsg.id;
  // 模拟滚动驱逐：保留窗口前移，最老一条保留轮被逐出
  const evictTarget = toolMessageIds[toolMessageIds.length - KEEP_FULL_ROUNDS + i];
  if (evictTarget) {
    await evictManager.updateLedger((ledger) => {
      ledger.entries.push(makeEntry(evictTarget, toolMessageIds.length + i));
    });
  }
  const start = performance.now();
  const view = await evictManager.buildView(evictMessages);
  const elapsed = performance.now() - start;
  evictSamples.push(elapsed);
  if (view.stats.incremental) evictHits++;
}
const evictSummary = summarize(evictSamples);
console.log(`\n滚动驱逐增量 p50: ${evictSummary.p50.toFixed(2)} ms，命中率 ${evictHits}/${INCREMENTAL_RUNS}`);

// ---- 汇总 ----
const fullSummary = summarize(fullBuildSamples);
const incSummary = summarize(incrementalSamples);
const speedup = fullSummary.p50 / Math.max(0.01, incSummary.p50);

console.log(`\n全量构建 p50: ${fullSummary.p50.toFixed(2)} ms`);
console.log(`增量构建 p50: ${incSummary.p50.toFixed(2)} ms`);
console.log(`加速比: ${speedup.toFixed(2)}x（目标 >= 2.0x）`);
console.log(`增量命中率: ${incrementalHits}/${INCREMENTAL_RUNS}`);

const ms = (v) => Math.round(v * 100) / 100;
// 增量构建是亚毫秒级操作（20 次采样）：共享 CI runner 上 ±0.3ms 抖动即对应
// ±30%+ 百分比，纯相对阈值会系统性误报。minDelta=0.5ms 是绝对噪声地板；
// speedup 由 p50 派生、噪声同源，且下方有 speedup>=2.0 的验收断言兜底，
// 故只展示不参与跨版本判定。
await writeResult("context-build", [
  { name: "fullBuild.p50", value: ms(fullSummary.p50), unit: "ms", direction: "lower-better" },
  { name: "fullBuild.p95", value: ms(fullSummary.p95), unit: "ms", direction: "lower-better" },
  { name: "incremental.p50", value: ms(incSummary.p50), unit: "ms", direction: "lower-better", minDelta: 0.5 },
  { name: "incremental.p95", value: ms(incSummary.p95), unit: "ms", direction: "lower-better", minDelta: 0.5 },
  { name: "context.incremental.speedup", value: ms(speedup), unit: "x", direction: "none" },
  { name: "incremental.hitRate", value: ms(incrementalHits / INCREMENTAL_RUNS), unit: "ratio", direction: "higher-better" },
  { name: "incrementalEvict.p50", value: ms(evictSummary.p50), unit: "ms", direction: "lower-better", minDelta: 0.5 },
  { name: "incrementalEvict.p95", value: ms(evictSummary.p95), unit: "ms", direction: "lower-better", minDelta: 0.5 },
  { name: "incrementalEvict.hitRate", value: ms(evictHits / INCREMENTAL_RUNS), unit: "ratio", direction: "higher-better" },
  { name: "heapDelta", value: ms(heapDeltaMB), unit: "MiB", direction: "lower-better" },
  { name: "dataset.messages", value: messages.length, unit: "count", direction: "none" },
], args.out, {
  params: { fullBuildRuns: FULL_BUILD_RUNS, incrementalRuns: INCREMENTAL_RUNS },
  samples: {
    fullBuildMs: fullBuildSamples.map(ms),
    incrementalMs: incrementalSamples.map(ms),
    incrementalEvictMs: evictSamples.map(ms),
  },
});

// 验收断言：增量构建加速比 >= 2.0（即 CPU 时间下降 >= 50%）
if (speedup < 2.0) {
  console.error(`\n[验收未通过] 增量构建加速比 ${speedup.toFixed(2)}x < 2.0x（目标：CPU 时间下降 >= 50%）`);
  process.exit(1);
}
// 滚动驱逐场景必须保持增量命中（P1 片段级失效的回归门槛）
if (evictHits < INCREMENTAL_RUNS) {
  console.error(`\n[验收未通过] 滚动驱逐场景增量命中率 ${evictHits}/${INCREMENTAL_RUNS}（驱逐条目变化不得退化为全量重建）`);
  process.exit(1);
}
console.log(`\n[验收通过] 增量构建加速比 ${speedup.toFixed(2)}x >= 2.0x；滚动驱逐命中率 ${evictHits}/${INCREMENTAL_RUNS}`);
