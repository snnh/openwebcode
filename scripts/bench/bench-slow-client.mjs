// 基准：慢 WS 客户端背压。
// 一个慢客户端（握手后 pause 底层 socket，模拟永不读）+ 一个正常客户端并发收事件流。
// 测量：慢客户端被服务端断连的耗时与关闭码（背压生效证据）、正常客户端吞吐是否受影响。
// 通过待发送消息数确定性触发背压，不依赖 runner 的 TCP 接收窗口大小；
// 与 server/test/event-stream-backpressure.test.ts 使用同一稳定触发方式。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-slow-client.mjs [--out path]

import { connectWs, parseArgs, startBenchServer, waitFor, writeResult, WebSocket } from "./lib/common.mjs";

const FLOOD_EVENTS = 10; // 固定 10 条 × 200KB ≈ 2MB 事件流
const FLOOD_PAYLOAD_BYTES = 200_000;

const args = parseArgs(process.argv.slice(2));
const { events, base, close } = await startBenchServer({
  wsBackpressureLimits: { maxBufferedMessages: 1 },
});

try {
  // 慢客户端：open 后立即 pause socket
  const slowWs = new WebSocket(`${base}/api/events?sessionId=slow-client`);
  let slowCloseCode = 0;
  let slowClosedAt = 0;
  const slowClosed = new Promise((resolve) => slowWs.on("close", (code) => {
    slowCloseCode = code;
    slowClosedAt = performance.now();
    resolve();
  }));
  let resyncReceived = false;
  slowWs.on("message", (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === "resync.required") resyncReceived = true;
  });
  await new Promise((resolve) => slowWs.on("open", resolve));
  slowWs._socket.pause();

  // 正常客户端
  const healthy = await connectWs(base, { sessionId: "healthy-client" });

  // 同步发布时 send callback 尚未运行：第三条消息观察到两条待发送消息，
  // 因此稳定触发慢客户端路径，不依赖操作系统 socket buffer 容量。
  const floodStart = performance.now();
  for (let i = 0; i < 3; i++) {
    events.publish({ source: "server", sessionId: "slow-client", type: `slow-flood-${i}`, payload: "x" });
  }

  // 恢复慢客户端读取，让 resync.required + close(1013) 冲刷出来
  slowWs._socket.resume();
  let disconnectTimer;
  try {
    await Promise.race([
      slowClosed,
      new Promise((_, reject) => { disconnectTimer = setTimeout(() => reject(new Error("慢客户端未在 10 秒内断连")), 10_000); }),
    ]);
  } finally {
    clearTimeout(disconnectTimer);
  }
  const disconnectMs = slowClosedAt - floodStart;

  // 背压只踢慢客户端：健康客户端随后仍能完整接收 2MB 事件流。
  // 每条收讫后再发下一条，避免为健康客户端人为制造待发送队列。
  const healthyStart = performance.now();
  const payload = "x".repeat(FLOOD_PAYLOAD_BYTES);
  for (let i = 0; i < FLOOD_EVENTS; i++) {
    events.publish({ source: "server", sessionId: "healthy-client", type: `healthy-flood-${i}`, payload });
    await waitFor(() => healthy.received.length >= i + 1, 20_000);
  }
  const healthyDrainMs = performance.now() - healthyStart;

  healthy.ws.close();
  const healthyBytes = healthy.received.reduce((s, r) => s + r.bytes, 0);
  const ms = (v) => Math.round(v * 100) / 100;
  await writeResult("slow-client", [
    { name: "slow.disconnectMs", value: ms(disconnectMs), unit: "ms", direction: "lower-better" },
    { name: "slow.closeCode", value: slowCloseCode, unit: "code", direction: "none" },
    { name: "slow.resyncReceived", value: resyncReceived ? 1 : 0, unit: "bool", direction: "none" },
    { name: "healthy.deliveredEvents", value: healthy.received.length, unit: "count", direction: "higher-better" },
    { name: "healthy.drainMs", value: ms(healthyDrainMs), unit: "ms", direction: "lower-better" },
    { name: "healthy.throughput", value: ms(healthyBytes / 1024 / 1024 / (healthyDrainMs / 1000)), unit: "MiB/s", direction: "higher-better" },
  ], args.out, {
    params: { floodEvents: FLOOD_EVENTS, floodPayloadBytes: FLOOD_PAYLOAD_BYTES, maxBufferedMessages: 1 },
  });

  // 背压未生效视为基准失败（不是回归，是功能破坏）
  if (slowCloseCode !== 1013 || !resyncReceived || healthy.received.length < FLOOD_EVENTS) {
    console.error("背压断言失败：慢客户端未被正确断连或正常客户端受影响");
    process.exit(1);
  }
} finally {
  await close();
}
