// 基准：浏览器渲染（Playwright + 真实 server，5000 消息会话）。
// 三项指标：
//   1. 滚动帧率：自动滚动 5000 消息会话，rAF 采样帧间隔，fps p50（目标 >= 50）
//   2. 输入回显延迟：Composer 输入字符，keydown → DOM 更新（目标 <= 50ms）
//   3. 内存增长：循环滚动 N 次，performance.memory 首尾差值比（目标 <= 20%）
// 用法：server/node_modules/.bin/tsx scripts/bench/browser/bench-browser-render.mjs [--out path]
// 前置：先跑 generate-dataset.mjs；需要 web/dist 已构建（npm run build --prefix web）；
//       需要 playwright chromium（server/node_modules/.bin/playwright install chromium）

import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DATA_DIR, parseArgs, percentile, startBenchServer, tryGc, writeResult } from "../lib/common.mjs";

const SESSION_ID = "01234567-89ab-4def-8012-3456789abcde";
const SCROLL_ROUNDS = 60; // 循环滚动次数（模拟 10 分钟使用的加速版）
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 720;

const args = parseArgs(process.argv.slice(2));
const benchRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storeRoot = path.join(DATA_DIR, "long-history", ".sessions");
if (!existsSync(path.join(storeRoot, SESSION_ID, "messages.jsonl"))) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

// Playwright 从 server 的 node_modules 解析（避免在仓库根新增依赖）
const serverRequire = createRequire(path.join(benchRoot, "..", "..", "server", "package.json"));
let chromium;
try {
  ({ chromium } = serverRequire("playwright"));
} catch {
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("playwright 未安装。请运行：npm --prefix server install && server/node_modules/.bin/playwright install chromium");
    process.exit(2);
  }
}

// 启动真实 server（SessionStore 指向 long-history 数据集）
const { SessionStore } = await import("../../../server/src/sessions/session-store.ts");
const { buildServer } = await import("../../../server/src/app.ts");
const { EventBus } = await import("../../../server/src/events/event-bus.ts");
const { PricingCatalog } = await import("../../../server/src/cost/pricing-catalog.ts");
const { ProviderRegistry } = await import("../../../server/src/providers/provider.ts");

const sessions = new SessionStore(storeRoot);
await sessions.initialize();
const pricing = new PricingCatalog(path.join(storeRoot, "..", "pricing.json"));
await pricing.initialize();
const events = new EventBus();
const stubCore = { on() { return stubCore; }, async ping() { return { version: "bench" }; } };
const app = await buildServer({
  core: stubCore,
  sessions,
  agent: { isRunning: () => false, getPerf: () => [] },
  events,
  providers: new ProviderRegistry(),
  pricing,
  webDist: path.join(benchRoot, "..", "..", "web", "dist"),
});
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
const serverBase = `http://127.0.0.1:${address.port}`;
console.log(`Server 已启动：${serverBase}`);

// 启动浏览器
const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT } });

// 导航到真实 Web 页面，并把分页历史全部载入后再采样。任何 selector 缺失都必须失败，
// 避免 404/空白页被误测成高帧率。
const response = await page.goto(`${serverBase}/`, { waitUntil: "networkidle" });
if (!response?.ok()) throw new Error(`Web 页面加载失败：HTTP ${response?.status() ?? "unknown"}`);
await page.locator(".session-link").first().click();
await page.locator("#composer-input").waitFor({ state: "visible" });
await page.locator(".execution-track").waitFor({ state: "visible" });

let pageLoads = 0;
while (await page.locator(".load-more-btn").count()) {
  const button = page.locator(".load-more-btn").first();
  if (await button.isDisabled()) {
    await page.waitForTimeout(50);
    continue;
  }
  await button.click();
  pageLoads++;
  if (pageLoads > 60) throw new Error("历史分页超过 60 次，疑似未收敛");
  await page.waitForTimeout(20);
}
console.log(`真实 Web 已就绪：历史分页加载 ${pageLoads} 次`);

// ---- 指标 1：滚动帧率 ----
console.log("测量滚动帧率…");
const fpsSamples = await page.evaluate(async (opts) => {
  const { scrollRounds } = opts;
  const container = document.querySelector(".execution-track");
  if (!(container instanceof HTMLElement)) throw new Error("找不到 execution-track");
  if (container.scrollHeight <= container.clientHeight) throw new Error("execution-track 没有可滚动内容");
  const intervals = [];
  let lastTs = 0;
  let rafCount = 0;
  const maxFrames = scrollRounds * 60; // 每轮约 60 帧

  function measureFrame(ts) {
    if (lastTs > 0) intervals.push(ts - lastTs);
    lastTs = ts;
    rafCount++;
    if (rafCount < maxFrames) requestAnimationFrame(measureFrame);
  }

  // 启动 rAF 采样
  requestAnimationFrame(measureFrame);

  // 自动滚动：循环滚到底部再回顶部
  const scrollHeight = container.scrollHeight || document.body.scrollHeight;
  for (let i = 0; i < scrollRounds; i++) {
    const target = i % 2 === 0 ? scrollHeight : 0;
    container.scrollTo?.({ top: target, behavior: "instant" }) ?? window.scrollTo(0, target);
    await new Promise((r) => setTimeout(r, 100));
  }
  // 等 rAF 采样完成
  await new Promise((r) => setTimeout(r, 200));
  return intervals;
}, { scrollRounds: SCROLL_ROUNDS });

const fpsValues = fpsSamples.filter((v) => v > 0).map((v) => 1000 / v);
fpsValues.sort((a, b) => a - b);
const fpsP50 = fpsValues.length > 0 ? fpsValues[Math.floor(fpsValues.length * 0.5)] : 0;
const fpsP95 = fpsValues.length > 0 ? fpsValues[Math.floor(fpsValues.length * 0.05)] : 0; // p5 of fps = p95 of intervals

// ---- 指标 2：输入回显延迟 ----
console.log("测量输入回显延迟…");
const inputLatencies = [];
for (let i = 0; i < 10; i++) {
  const latency = await page.evaluate(async () => {
    const textarea = document.querySelector("#composer-input");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("找不到 composer 输入框");
    const start = performance.now();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, `bench input ${Date.now()}`);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  });
  inputLatencies.push(latency);
  await page.waitForTimeout(50);
}
inputLatencies.sort((a, b) => a - b);
const inputP50 = inputLatencies.length > 0 ? inputLatencies[Math.floor(inputLatencies.length * 0.5)] : 0;

// ---- 指标 3：内存增长 ----
console.log("测量内存增长…");
const memBefore = await page.evaluate(() => /** @type {any} */(performance).memory?.usedJSHeapSize ?? 0);
// 加速滚动模拟长时间使用
await page.evaluate(async (rounds) => {
  const container = document.querySelector(".execution-track");
  if (!(container instanceof HTMLElement)) throw new Error("找不到 execution-track");
  const scrollHeight = container.scrollHeight || document.body.scrollHeight;
  for (let i = 0; i < rounds; i++) {
    const target = i % 2 === 0 ? scrollHeight : 0;
    container.scrollTo?.({ top: target, behavior: "instant" }) ?? window.scrollTo(0, target);
    await new Promise((r) => setTimeout(r, 50));
  }
}, SCROLL_ROUNDS * 3);
const memAfter = await page.evaluate(() => /** @type {any} */(performance).memory?.usedJSHeapSize ?? 0);
const memGrowthPct = memBefore > 0 ? ((memAfter - memBefore) / memBefore) * 100 : 0;

// 清理
await browser.close();
await app.close();

// 输出结果
const ms = (v) => Math.round(v * 100) / 100;
console.log(`\n滚动帧率 p50: ${ms(fpsP50)} fps（目标 >= 50）`);
console.log(`输入回显 p50: ${ms(inputP50)} ms（目标 <= 50）`);
console.log(`内存增长: ${ms(memGrowthPct)}%（目标 <= 20%）`);

await writeResult("browser-render", [
  { name: "scroll.fps.p50", value: ms(fpsP50), unit: "fps", direction: "higher-better" },
  { name: "scroll.fps.p95", value: ms(fpsP95), unit: "fps", direction: "higher-better" },
  { name: "input.latency.p50", value: ms(inputP50), unit: "ms", direction: "lower-better" },
  { name: "memory.growthPct", value: ms(memGrowthPct), unit: "%", direction: "lower-better" },
  { name: "scroll.samples", value: fpsSamples.length, unit: "count", direction: "none" },
], args.out, {
  params: { scrollRounds: SCROLL_ROUNDS, windowWidth: WINDOW_WIDTH, windowHeight: WINDOW_HEIGHT, messages: 5000, pageLoads },
});

const violations = [];
if (fpsP50 < 50) violations.push(`滚动帧率 ${ms(fpsP50)} fps < 50 fps`);
if (inputP50 > 50) violations.push(`输入回显 ${ms(inputP50)} ms > 50 ms`);
if (memBefore <= 0) violations.push("performance.memory 不可用");
if (memGrowthPct > 20) violations.push(`内存增长 ${ms(memGrowthPct)}% > 20%`);
if (fpsSamples.length < 100) violations.push(`帧率样本不足：${fpsSamples.length}`);
if (violations.length > 0) throw new Error(`浏览器性能门禁失败：${violations.join("；")}`);
