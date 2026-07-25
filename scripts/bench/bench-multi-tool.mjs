// 基准：多工具回合（50 tool_call + 50 tool_result / run）。
// 起真实 server + WS 客户端，以固定数据集模拟单次 agent run 的工具密集事件流，
// 测量事件发布到客户端收齐的端到端延迟分布（p50/p95）、事件吞吐（events/s）、服务端内存增量。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-multi-tool.mjs [--out path]
// 前置：先跑 generate-dataset.mjs

import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connectWs, DATA_DIR, parseArgs, startBenchServer, summarize, tryGc, waitFor, writeResult } from "./lib/common.mjs";

const RUNS = 5; // 固定重复次数，取 p50/p95
const args = parseArgs(process.argv.slice(2));

const datasetPath = path.join(DATA_DIR, "multi-tool", "events.json");
if (!existsSync(datasetPath)) {
  console.error("数据集不存在，请先运行：tsx scripts/bench/generate-dataset.mjs");
  process.exit(2);
}

const events0 = JSON.parse(await readFile(datasetPath, "utf8"));
const EVENT_COUNT = events0.length; // 100 events (50 tool_call + 50 tool_result)

const latencySamples = [];
const drainSamples = [];
const throughputSamples = [];
let heapDeltaMB = 0;

for (let run = 0; run < RUNS; run++) {
  const { events, base, close } = await startBenchServer();
  try {
    const client = await connectWs(base);
    tryGc();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();

    // 发布全部工具事件（模拟 agent run 的工具密集阶段）
    for (const evt of events0) {
      events.publish({ source: "agent", type: evt.type, sessionId: "bench-multi-tool", payload: evt.payload });
    }

    // 等客户端收齐全部事件
    await waitFor(() => client.received.length >= EVENT_COUNT, 20000);
    const drainMs = performance.now() - start;
    tryGc();
    const heapAfter = process.memoryUsage().heapUsed;

    // 逐事件延迟：客户端收到时间 - 事件创建时间
    const latencies = client.received.map((r) => r.at - Date.parse(r.event.createdAt));
    const lat = summarize(latencies);
    latencySamples.push(lat);
    drainSamples.push(drainMs);
    throughputSamples.push(EVENT_COUNT / (drainMs / 1000)); // events/s

    if (run === RUNS - 1) {
      heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;
    }
    client.ws.close();
  } finally {
    await close();
  }
}

// 汇总
const p50s = latencySamples.map((s) => s.p50);
const p95s = latencySamples.map((s) => s.p95);
const drainSummary = summarize(drainSamples);
const throughputSummary = summarize(throughputSamples);
const latP50Summary = summarize(p50s);
const latP95Summary = summarize(p95s);

const ms = (v) => Math.round(v * 100) / 100;
await writeResult("multi-tool", [
  { name: "latency.p50", value: ms(latP50Summary.p50), unit: "ms", direction: "lower-better" },
  { name: "latency.p95", value: ms(latP95Summary.p50), unit: "ms", direction: "lower-better" },
  { name: "drain.p50", value: ms(drainSummary.p50), unit: "ms", direction: "lower-better" },
  { name: "drain.p95", value: ms(drainSummary.p95), unit: "ms", direction: "lower-better" },
  { name: "throughput.p50", value: ms(throughputSummary.p50), unit: "events/s", direction: "higher-better" },
  { name: "heapDelta", value: ms(heapDeltaMB), unit: "MiB", direction: "lower-better" },
  { name: "dataset.events", value: EVENT_COUNT, unit: "count", direction: "none" },
], args.out, {
  params: { toolCalls: 50, toolResults: 50, runs: RUNS },
  samples: { drainMs: drainSamples.map(ms), throughput: throughputSamples.map(ms) },
});
