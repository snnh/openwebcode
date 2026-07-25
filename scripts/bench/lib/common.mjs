// 基准公共库：确定性随机、统计、结果输出、测试服务器工装。
// 所有基准脚本通过 tsx 运行（tsx 可加载 server/src 下的 TS 源码），
// 不引入任何 benchmark 框架，保持依赖为零。

import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BENCH_ROOT = benchRoot;
export const DATA_DIR = path.join(benchRoot, "data");
export const RESULTS_DIR = path.join(benchRoot, "results");

// ws 是 server 的依赖；从 server/package.json 解析，避免在仓库根新增依赖。
const serverRequire = createRequire(path.join(benchRoot, "..", "..", "server", "package.json"));
export const { WebSocket } = serverRequire("ws");

/** 固定 seed 的 mulberry32 PRNG：基准内容必须跨机器可重复。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用 PRNG 生成确定性的伪自然语言文本（约 targetLen 字符）。 */
export function pseudoText(rng, targetLen) {
  const words = ["alpha", "beta", "gamma", "delta", "stream", "token", "session", "context", "tool", "result", "render", "frame", "memory", "latency", "buffer", "event"];
  let out = "";
  while (out.length < targetLen) {
    out += words[Math.floor(rng() * words.length)] + (rng() < 0.12 ? ".\n" : " ");
  }
  return out.slice(0, targetLen);
}

export function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return 0;
  const idx = Math.min(sortedSamples.length - 1, Math.ceil((p / 100) * sortedSamples.length) - 1);
  return sortedSamples[Math.max(0, idx)];
}

/** 样本数组 → { mean, p50, p95, min, max }（内部会拷贝排序，不改原数组）。 */
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);
  return {
    mean: round2(mean),
    p50: round2(percentile(sorted, 50)),
    p95: round2(percentile(sorted, 95)),
    min: round2(sorted[0] ?? 0),
    max: round2(sorted[sorted.length - 1] ?? 0),
  };
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 机器可读结果的环境信息：数值只在同环境对比时有意义。 */
export function environmentInfo() {
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: benchRoot, encoding: "utf8" }).trim();
  } catch { /* 非 git 环境时容忍 */ }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    commit,
  };
}

/**
 * 写出一份基准结果 JSON 并打印人读摘要。
 * metrics: [{ name, value, unit, direction }]
 * direction: "lower-better" | "higher-better" | "none"（compare 时跳过 none）
 */
export async function writeResult(scenario, metrics, outPath, extra = {}) {
  const result = {
    schemaVersion: 1,
    scenario,
    timestamp: new Date().toISOString(),
    environment: environmentInfo(),
    metrics,
    ...extra,
  };
  await mkdir(RESULTS_DIR, { recursive: true });
  const target = outPath ?? path.join(RESULTS_DIR, `${scenario}.json`);
  await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\n== ${scenario} ==`);
  for (const m of metrics) console.log(`  ${m.name}: ${m.value} ${m.unit}`);
  console.log(`  → ${path.relative(process.cwd(), target)}`);
  return result;
}

/** 解析 --out <path> 与 --key=value 形式的简单 CLI 参数。 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i].startsWith("--")) {
      const [k, v] = argv[i].slice(2).split("=");
      args[k] = v ?? true;
    }
  }
  return args;
}

/**
 * 起一个真实 fastify server（loopback 随机端口），与 server 集成测试同款接线。
 * 只通过既有配置项插桩（deltaBatchWindowMs / wsBackpressureLimits），不改被测行为。
 * 返回 { app, events, base, close }。
 */
export async function startBenchServer({ deltaBatchWindowMs, wsBackpressureLimits } = {}) {
  const { buildServer } = await import("../../../server/src/app.ts");
  const { EventBus } = await import("../../../server/src/events/event-bus.ts");
  const { SessionStore } = await import("../../../server/src/sessions/session-store.ts");
  const { PricingCatalog } = await import("../../../server/src/cost/pricing-catalog.ts");
  const { ProviderRegistry } = await import("../../../server/src/providers/provider.ts");

  const root = await mkdtemp(path.join(os.tmpdir(), "owc-bench-"));
  const sessions = new SessionStore(path.join(root, ".sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  // 构造器第三参是既有的合批窗口配置项；不传则用默认 16ms。
  const events = deltaBatchWindowMs === undefined ? new EventBus() : new EventBus(1000, 4 * 1024 * 1024, deltaBatchWindowMs);
  const stubCore = { on() { return stubCore; } };
  const deps = {
    core: stubCore,
    sessions,
    agent: { isRunning: () => false },
    events,
    providers: new ProviderRegistry(),
    pricing,
    ...(wsBackpressureLimits ? { wsBackpressureLimits } : {}),
  };
  const app = await buildServer(deps);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const base = `ws://127.0.0.1:${address.port}`;
  const close = async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  };
  return { app, events, base, close };
}

/** 连接 /api/events 并收集事件，返回记录器。skipTypes 默认滤掉首条 connected。 */
export async function connectWs(base, { skipTypes = ["connected"] } = {}) {
  const ws = new WebSocket(`${base}/api/events`);
  const received = []; // { event, bytes, at }
  let closeCode = 0;
  const closed = new Promise((resolve) => ws.on("close", (code) => { closeCode = code; resolve(); }));
  ws.on("message", (data) => {
    const event = JSON.parse(data.toString());
    if (skipTypes.includes(event.type)) return;
    received.push({ event, bytes: data.length, at: Date.now() });
  });
  await new Promise((resolve) => ws.on("open", resolve));
  return { ws, received, closed, get closeCode() { return closeCode; } };
}

/** 等待条件成立（轮询），超时抛错。 */
export async function waitFor(cond, timeoutMs = 15000, intervalMs = 10) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 若运行在 node --expose-gc 下则触发 GC；否则静默跳过（内存数值为近似值）。 */
export function tryGc() {
  if (typeof globalThis.gc === "function") globalThis.gc();
}
