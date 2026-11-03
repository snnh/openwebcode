// 基准：多会话内存 soak。
// 把 long-history 数据集复制成 N 个独立会话，逐个整表加载 + 全量 buildView，
// 测量冷加载/构建耗时、堆与 RSS 增长、SessionStore 缓存记账。
// 用途：建立“打开 N 个长会话”的内存基线，后续对比三档模式与缓存参数化。
// 用法：tsx scripts/bench/bench-memory-soak.mjs [--sessions=8] [--messages=5000] [--out path]
// 前置：先跑 generate-dataset.mjs。

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DATA_DIR, parseArgs, summarize, tryGc, writeResult } from "./lib/common.mjs";

const args = parseArgs(process.argv.slice(2));
const SESSIONS = Number.parseInt(args.sessions ?? "8", 10);
if (!Number.isSafeInteger(SESSIONS) || SESSIONS < 1) throw new Error("--sessions 必须是正整数");

const SOURCE_ID = "01234567-89ab-4def-8012-3456789abcde";
const sourceDir = path.join(DATA_DIR, "long-history", ".sessions", SOURCE_ID);
if (!existsSync(path.join(sourceDir, "messages.jsonl"))) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

const { SessionStore } = await import("../../server/src/sessions/session-store.ts");
const { ContextManager } = await import("../../server/src/context/context-manager.ts");
const { setCacheScale } = await import("../../server/src/cache-limits.ts");
const { runtimeProfile } = await import("../../server/src/runtime-mode.ts");
const { messageIndexStats } = await import("../../server/src/sessions/message-reader.ts");

const MODE = args.mode ?? "balanced";
if (!["performance", "balanced", "memory"].includes(MODE)) throw new Error("--mode 必须是 performance/balanced/memory");
setCacheScale(runtimeProfile(MODE).cacheScale);

const root = await mkdtemp(path.join(os.tmpdir(), "owc-bench-memory-"));
const storeRoot = path.join(root, ".sessions");
const ids = [];

try {
  for (let i = 0; i < SESSIONS; i++) {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    ids.push(id);
    const target = path.join(storeRoot, id);
    await cp(sourceDir, target, { recursive: true });
    const metaPath = path.join(target, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.id = id;
    meta.title = `memory soak ${i + 1}`;
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  tryGc();
  const before = process.memoryUsage();
  const store = new SessionStore(storeRoot);
  await store.initialize();

  const loadSamples = [];
  const buildSamples = [];
  for (const id of ids) {
    const loadStart = performance.now();
    const session = await store.get(id);
    loadSamples.push(performance.now() - loadStart);

    const manager = new ContextManager(store.contextRoot(id));
    const buildStart = performance.now();
    await manager.buildView(session.messages, { forceFullRebuild: true });
    buildSamples.push(performance.now() - buildStart);
  }

  tryGc();
  const after = process.memoryUsage();
  const cache = store.messagesCacheStats();
  const context = ContextManager.cacheStats();
  const index = messageIndexStats();
  const dropOrder = args["drop-order"] === "context" ? "context" : "messages";
  let droppedFirst;
  let droppedSecond;
  let afterFirst;
  let afterSecond;
  if (dropOrder === "context") {
    droppedFirst = ContextManager.clearCaches();
    tryGc();
    afterFirst = process.memoryUsage();
    droppedSecond = store.clearMessageCaches();
    tryGc();
    afterSecond = process.memoryUsage();
  } else {
    droppedFirst = store.clearMessageCaches();
    tryGc();
    afterFirst = process.memoryUsage();
    droppedSecond = ContextManager.clearCaches();
    tryGc();
    afterSecond = process.memoryUsage();
  }
  const firstLabel = dropOrder === "context" ? "context" : "messages";
  const secondLabel = dropOrder === "context" ? "messages" : "context";
  const mb = (value) => Math.round((value / (1024 * 1024)) * 100) / 100;
  const load = summarize(loadSamples);
  const build = summarize(buildSamples);

  const metrics = [
    { name: "load.p50", value: load.p50, unit: "ms", direction: "lower-better" },
    { name: "load.p95", value: load.p95, unit: "ms", direction: "lower-better" },
    { name: "build.p50", value: build.p50, unit: "ms", direction: "lower-better" },
    { name: "build.p95", value: build.p95, unit: "ms", direction: "lower-better" },
    { name: "heap.beforeMB", value: mb(before.heapUsed), unit: "MB", direction: "lower-better" },
    { name: "heap.afterMB", value: mb(after.heapUsed), unit: "MB", direction: "lower-better" },
    { name: "heap.perSessionMB", value: Math.round(((after.heapUsed - before.heapUsed) / SESSIONS / (1024 * 1024)) * 100) / 100, unit: "MB", direction: "lower-better" },
    { name: "rss.afterMB", value: mb(after.rss), unit: "MB", direction: "lower-better" },
    { name: "external.afterMB", value: mb(after.external), unit: "MB", direction: "lower-better" },
    { name: "cache.entries", value: cache.entries, unit: "count", direction: "none" },
    { name: "cache.bytesMB", value: mb(cache.bytes), unit: "MB", direction: "lower-better" },
    { name: "cache.pinned", value: cache.pinned, unit: "count", direction: "none" },
    { name: "context.viewEntries", value: context.viewEntries, unit: "count", direction: "none" },
    { name: "context.viewMB", value: mb(context.viewBytes), unit: "MB", direction: "lower-better" },
    { name: "context.ledgerEntries", value: context.ledgerEntries, unit: "count", direction: "none" },
    { name: "context.ledgerMB", value: mb(context.ledgerBytes), unit: "MB", direction: "lower-better" },
    { name: "index.entries", value: index.entries, unit: "count", direction: "none" },
    { name: "index.lines", value: index.lines, unit: "count", direction: "none" },
    { name: "index.approxMB", value: mb(index.approxBytes), unit: "MB", direction: "lower-better" },
    { name: `drop.${firstLabel}Entries`, value: droppedFirst, unit: "count", direction: "none" },
    { name: `drop.${firstLabel}MB`, value: mb(after.heapUsed - afterFirst.heapUsed), unit: "MB", direction: "lower-better" },
    { name: `drop.${secondLabel}Entries`, value: droppedSecond, unit: "count", direction: "none" },
    { name: `drop.${secondLabel}MB`, value: mb(afterFirst.heapUsed - afterSecond.heapUsed), unit: "MB", direction: "lower-better" },
    { name: "heap.residualMB", value: mb(afterSecond.heapUsed - before.heapUsed), unit: "MB", direction: "lower-better" },
    { name: "heap.afterDropMB", value: mb(afterSecond.heapUsed), unit: "MB", direction: "lower-better" },
    { name: "rss.afterDropMB", value: mb(afterSecond.rss), unit: "MB", direction: "lower-better" },
    { name: "dataset.sessions", value: SESSIONS, unit: "count", direction: "none" },
  ];
  await writeResult("memory-soak", metrics, args.out, { sessions: SESSIONS, mode: MODE });
} finally {
  await rm(root, { recursive: true, force: true });
}
