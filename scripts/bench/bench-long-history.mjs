// 基准：长历史会话加载（5000 消息 / 1000 工具块）。
// 走 server 的会话加载路径（SessionStore.get / list），如实记录现状数值作为基线——
// 当前实现为全量 readFile + 逐行 JSON.parse，无分页尾读；基准的意义就是量化它。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-long-history.mjs [--out path]
// 前置：先跑 generate-dataset.mjs

import path from "node:path";
import { existsSync } from "node:fs";
import { DATA_DIR, parseArgs, summarize, tryGc, writeResult } from "./lib/common.mjs";

const RUNS = 7; // 固定重复次数，取 p50/p95
const SESSION_ID = "01234567-89ab-4def-8012-3456789abcde";

const args = parseArgs(process.argv.slice(2));
const storeRoot = path.join(DATA_DIR, "long-history", ".sessions");
if (!existsSync(path.join(storeRoot, SESSION_ID, "messages.jsonl"))) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

const { SessionStore } = await import("../../server/src/sessions/session-store.ts");
const store = new SessionStore(storeRoot);

// 预热一次，排除文件系统冷缓存对首次测量的干扰
await store.get(SESSION_ID);

const loadSamples = [];
let messageCount = 0;
let toolBlocks = 0;
for (let i = 0; i < RUNS; i++) {
  tryGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const detail = await store.get(SESSION_ID);
  loadSamples.push(performance.now() - start);
  const heapAfter = process.memoryUsage().heapUsed;
  if (i === RUNS - 1) {
    messageCount = detail.messages.length;
    toolBlocks = detail.messages.reduce(
      (n, m) => n + m.content.filter((b) => b.type === "tool_call" || b.type === "tool_result").length,
      0,
    );
    var heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;
  }
}

// list() 同样会读全部 messages.jsonl（recovery 检查），单独测一次
const listStart = performance.now();
await store.list();
const listMs = performance.now() - listStart;

const load = summarize(loadSamples);
await writeResult("long-history", [
  { name: "load.p50", value: load.p50, unit: "ms", direction: "lower-better" },
  { name: "load.p95", value: load.p95, unit: "ms", direction: "lower-better" },
  { name: "load.mean", value: load.mean, unit: "ms", direction: "lower-better" },
  { name: "load.heapDelta", value: Math.round(heapDeltaMB * 100) / 100, unit: "MiB", direction: "lower-better" },
  { name: "list.p50", value: Math.round(listMs * 100) / 100, unit: "ms", direction: "lower-better" },
  { name: "dataset.messages", value: messageCount, unit: "count", direction: "none" },
  { name: "dataset.toolBlocks", value: toolBlocks, unit: "count", direction: "none" },
], args.out, { samples: { loadMs: loadSamples.map((v) => Math.round(v * 100) / 100) } });
