// 基准：长流式（1 MiB/s 突发 token delta）。
// 起真实 server + 真实 WS 客户端，以 1 MiB/s 速率推送 message.delta，
// 测量客户端收到的事件吞吐与端到端延迟分布（p50/p95）、服务端内存增量。
// delta 合批开（16ms，现状默认）/ 关（0=直发）各跑一次做对比——通过 EventBus
// 构造器既有配置项插桩，不改被测代码。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-long-stream.mjs [--out path]

import { connectWs, parseArgs, startBenchServer, summarize, tryGc, waitFor, writeResult } from "./lib/common.mjs";

const RATE_BYTES_PER_S = 1024 * 1024; // 1 MiB/s
const DURATION_MS = 2000; // 固定推送 2 秒 → 总量 2 MiB
const TICK_MS = 16; // 与渲染帧节奏对齐的发送节拍
const CHUNK_BYTES = 4096; // 每个 delta 的文本量
const CHUNKS_PER_TICK = Math.max(1, Math.round((RATE_BYTES_PER_S * (TICK_MS / 1000)) / CHUNK_BYTES)); // = 4

const args = parseArgs(process.argv.slice(2));

/** 跑一次指定合批窗口的流式突发，返回测量结果。 */
async function runBurst(deltaBatchWindowMs) {
  const { events, base, close } = await startBenchServer({ deltaBatchWindowMs });
  try {
    const client = await connectWs(base);
    const chunk = "x".repeat(CHUNK_BYTES); // 内容不影响测量，固定即可
    tryGc();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();

    // 按节拍推送；事件总量固定（2 MiB / 4 KiB = 512 个 delta）
    const totalTicks = DURATION_MS / TICK_MS;
    for (let tick = 0; tick < totalTicks; tick++) {
      for (let i = 0; i < CHUNKS_PER_TICK; i++) {
        events.publish({ source: "agent", type: "message.delta", sessionId: "bench", payload: { text: chunk } });
      }
      //  pacing：等下一个节拍
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
    events.flushDeltas?.(); // 冲刷合批缓冲，保证全部落线
    const published = events.stats().published;

    // 等客户端收齐：以 payload 文本字节为准（合批只改事件条数，文本总量守恒）。
    // 期望值按实际发送计划计算（CHUNKS_PER_TICK 取整后码率略低于 1 MiB/s）。
    const expectedTextBytes = (DURATION_MS / TICK_MS) * CHUNKS_PER_TICK * CHUNK_BYTES;
    const textBytesOf = () => client.received.reduce((s, r) => s + Buffer.byteLength(r.event.payload?.text ?? "", "utf8"), 0);
    await waitFor(() => textBytesOf() >= expectedTextBytes, 20000);
    const drainMs = performance.now() - start;
    tryGc();
    const heapAfter = process.memoryUsage().heapUsed;

    const latencies = client.received.map((r) => r.at - Date.parse(r.event.createdAt));
    const receivedBytes = client.received.reduce((s, r) => s + r.bytes, 0);
    const lat = summarize(latencies);
    client.ws.close();
    return {
      published,
      receivedEvents: client.received.length,
      receivedMiB: receivedBytes / 1024 / 1024,
      drainMs,
      lat,
      heapDeltaMB: (heapAfter - heapBefore) / 1024 / 1024,
    };
  } finally {
    await close();
  }
}

const batchOn = await runBurst(16); // 现状默认：16ms 合批
const batchOff = await runBurst(0); // 直发对照

const mb = (v) => Math.round(v * 100) / 100;
const ms = (v) => Math.round(v * 100) / 100;
await writeResult("long-stream", [
  { name: "batchOn.latency.p50", value: ms(batchOn.lat.p50), unit: "ms", direction: "lower-better" },
  { name: "batchOn.latency.p95", value: ms(batchOn.lat.p95), unit: "ms", direction: "lower-better" },
  { name: "batchOn.throughput", value: mb(batchOn.receivedMiB / (batchOn.drainMs / 1000)), unit: "MiB/s", direction: "higher-better" },
  { name: "batchOn.receivedEvents", value: batchOn.receivedEvents, unit: "count", direction: "none" },
  { name: "batchOn.heapDelta", value: mb(batchOn.heapDeltaMB), unit: "MiB", direction: "lower-better" },
  { name: "batchOff.latency.p50", value: ms(batchOff.lat.p50), unit: "ms", direction: "lower-better" },
  { name: "batchOff.latency.p95", value: ms(batchOff.lat.p95), unit: "ms", direction: "lower-better" },
  { name: "batchOff.throughput", value: mb(batchOff.receivedMiB / (batchOff.drainMs / 1000)), unit: "MiB/s", direction: "higher-better" },
  { name: "batchOff.receivedEvents", value: batchOff.receivedEvents, unit: "count", direction: "none" },
  { name: "batchOff.heapDelta", value: mb(batchOff.heapDeltaMB), unit: "MiB", direction: "lower-better" },
], args.out, {
  params: { rateBytesPerSec: RATE_BYTES_PER_S, durationMs: DURATION_MS, chunkBytes: CHUNK_BYTES },
});
