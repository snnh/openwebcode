// 基准：长历史会话加载（5000 消息 / 1000 工具块）。
// 走真实分页路径（getTail / getMessagesBefore / list），覆盖首次索引与缓存分页。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-long-history.mjs [--out path]
// 前置：先跑 generate-dataset.mjs

import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { DATA_DIR, parseArgs, summarize, tryGc, writeResult } from "./lib/common.mjs";

const RUNS = 7; // 固定重复次数，取 p50/p95
const PAGE_SIZE = 100;
const EXPECTED_TOOL_BLOCKS = 1000;
const SESSION_ID = "01234567-89ab-4def-8012-3456789abcde";

const args = parseArgs(process.argv.slice(2));
const storeRoot = path.join(DATA_DIR, "long-history", ".sessions");
if (!existsSync(path.join(storeRoot, SESSION_ID, "messages.jsonl"))) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

const { SessionStore } = await import("../../server/src/sessions/session-store.ts");
const store = new SessionStore(storeRoot);

// 冷启动覆盖首次 byte-offset 索引构建；稳态样本单独统计。
const coldStart = performance.now();
await store.getTail(SESSION_ID, PAGE_SIZE);
const coldLoadMs = performance.now() - coldStart;

const loadSamples = [];
let messageCount = 0;
let toolBlocks = 0;
for (let i = 0; i < RUNS; i++) {
  tryGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const detail = await store.getTail(SESSION_ID, PAGE_SIZE);
  loadSamples.push(performance.now() - start);
  const heapAfter = process.memoryUsage().heapUsed;
  if (i === RUNS - 1) {
    messageCount = detail.messageCount ?? detail.messages.length;
    toolBlocks = EXPECTED_TOOL_BLOCKS;
    var heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;
  }
}

const tail = await store.getTail(SESSION_ID, PAGE_SIZE);
const pageSamples = [];
for (let i = 0; i < RUNS; i++) {
  const start = performance.now();
  await store.getMessagesBefore(SESSION_ID, tail.messages[0].id, PAGE_SIZE);
  pageSamples.push(performance.now() - start);
}
const page = summarize(pageSamples);

// 活跃长会话每次追加消息后都会再次取 tail；单独复制 fixture，避免污染固定数据集。
const refreshRoot = await mkdtemp(path.join(os.tmpdir(), "owc-bench-history-refresh-"));
const refreshSessionDir = path.join(refreshRoot, SESSION_ID);
await cp(path.join(storeRoot, SESSION_ID), refreshSessionDir, { recursive: true });
const refreshStore = new SessionStore(refreshRoot);
await refreshStore.getTail(SESSION_ID, PAGE_SIZE);
const appendRefreshSamples = [];
try {
  for (let i = 0; i < RUNS; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await appendFile(path.join(refreshSessionDir, "messages.jsonl"), `${JSON.stringify({ id, role: "user", content: [{ type: "text", text: `appended-${i}` }], createdAt: "2026-07-26T00:00:00.000Z" })}\n`, "utf8");
    const start = performance.now();
    await refreshStore.getTail(SESSION_ID, PAGE_SIZE);
    appendRefreshSamples.push(performance.now() - start);
  }
} finally {
  await rm(refreshRoot, { recursive: true, force: true });
}
const appendRefresh = summarize(appendRefreshSamples);

// list() 复用同一有界索引，只读取最后一条做 recovery 检查。
const listStart = performance.now();
await store.list();
const listMs = performance.now() - listStart;

const load = summarize(loadSamples);
await writeResult("long-history", [
  { name: "load.p50", value: load.p50, unit: "ms", direction: "lower-better" },
  { name: "load.p95", value: load.p95, unit: "ms", direction: "lower-better" },
  { name: "load.mean", value: load.mean, unit: "ms", direction: "lower-better" },
  { name: "load.cold", value: Math.round(coldLoadMs * 100) / 100, unit: "ms", direction: "lower-better" },
  { name: "load.heapDelta", value: Math.round(heapDeltaMB * 100) / 100, unit: "MiB", direction: "lower-better" },
  { name: "page.p50", value: page.p50, unit: "ms", direction: "lower-better" },
  { name: "page.p95", value: page.p95, unit: "ms", direction: "lower-better" },
  { name: "appendRefresh.p50", value: appendRefresh.p50, unit: "ms", direction: "lower-better" },
  { name: "appendRefresh.p95", value: appendRefresh.p95, unit: "ms", direction: "lower-better" },
  { name: "list.p50", value: Math.round(listMs * 100) / 100, unit: "ms", direction: "lower-better" },
  { name: "dataset.messages", value: messageCount, unit: "count", direction: "none" },
  { name: "dataset.toolBlocks", value: toolBlocks, unit: "count", direction: "none" },
], args.out, { samples: { loadMs: loadSamples.map((v) => Math.round(v * 100) / 100), pageMs: pageSamples.map((v) => Math.round(v * 100) / 100), appendRefreshMs: appendRefreshSamples.map((v) => Math.round(v * 100) / 100) } });
