// 基准：空转 CPU 与定时器数量。
// 场景：真实 fastify server 启动后无 run；可选一个空闲 WS 客户端（面板关闭语义）。
// 测量：N 秒内本进程 CPU 时间、平均 CPU 百分比、活跃 Timeout 数量。
// 用法：tsx scripts/bench/bench-idle-cpu.mjs [--seconds=60] [--clients=0|1] [--out path]

import { parseArgs, connectWs, startBenchServer, writeResult } from "./lib/common.mjs";

const args = parseArgs(process.argv.slice(2));
const SECONDS = Number.parseInt(args.seconds ?? "60", 10);
const CLIENTS = Number.parseInt(args.clients ?? "0", 10);
if (!Number.isSafeInteger(SECONDS) || SECONDS < 5) throw new Error("--seconds 必须是 >= 5 的整数");
if (!Number.isSafeInteger(CLIENTS) || CLIENTS < 0 || CLIENTS > 1) throw new Error("--clients 只能是 0 或 1");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeoutCount = () => {
  try {
    return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  } catch {
    return -1;
  }
};

const server = await startBenchServer();
let ws;
try {
  if (CLIENTS > 0) ws = await connectWs(server.base);
  // 启动抖动不计入空转；让初始化定时器稳定下来。
  await sleep(2000);

  const timersBefore = timeoutCount();
  const cpuBefore = process.cpuUsage();
  const wallStart = Date.now();
  await sleep(SECONDS * 1000);
  const cpu = process.cpuUsage(cpuBefore);
  const wallMs = Date.now() - wallStart;
  const timersAfter = timeoutCount();
  const userMs = Math.round(cpu.user / 1000);
  const systemMs = Math.round(cpu.system / 1000);
  const totalMs = userMs + systemMs;

  const metrics = [
    { name: "cpu.userMs", value: userMs, unit: "ms", direction: "lower-better" },
    { name: "cpu.systemMs", value: systemMs, unit: "ms", direction: "lower-better" },
    { name: "cpu.totalMs", value: totalMs, unit: "ms", direction: "lower-better" },
    { name: "cpu.percent", value: Math.round((totalMs / wallMs) * 10000) / 100, unit: "%", direction: "lower-better" },
    { name: "timer.timeoutCountBefore", value: timersBefore, unit: "count", direction: "none" },
    { name: "timer.timeoutCountAfter", value: timersAfter, unit: "count", direction: "none" },
    { name: "params.seconds", value: SECONDS, unit: "s", direction: "none" },
    { name: "params.clients", value: CLIENTS, unit: "count", direction: "none" },
  ];
  await writeResult("idle-cpu", metrics, args.out, { clients: CLIENTS, seconds: SECONDS });
} finally {
  if (ws) ws.ws.close();
  await server.close();
}
