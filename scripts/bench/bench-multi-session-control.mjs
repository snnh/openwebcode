// 基准：多会话控制面阻塞（core 级）。
// 复现根因：会话 A 跑一个长 exec.run 时，core 主循环被同步执行占住，
// 会话 B 的 session.configure / fs.stat / exec.run / core.ping 全部排队。
// 测量：上述控制面调用在长命令运行期间的等待时间；另测两个短命令并发的总耗时。
// 用法：tsx scripts/bench/bench-multi-session-control.mjs [--rounds=3] [--longMs=2000] [--out path]
// 前置：core 已构建；OWC_CORE_PATH 可覆盖路径（默认 build/owc-exec）。

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs, summarize, writeResult } from "./lib/common.mjs";
import { CoreClient } from "../../server/src/core-client.ts";

const args = parseArgs(process.argv.slice(2));
const ROUNDS = Number.parseInt(args.rounds ?? "3", 10);
const LONG_MS = Number.parseInt(args.longMs ?? "2000", 10);
if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 1) throw new Error("--rounds 必须是正整数");
if (!Number.isSafeInteger(LONG_MS) || LONG_MS < 100) throw new Error("--longMs 必须 >= 100");

const corePath = process.env.OWC_CORE_PATH
  ?? path.resolve("build", process.platform === "win32" ? "Debug/owc-exec.exe" : "owc-exec");
if (!existsSync(corePath)) {
  console.error(`core 不存在：${corePath}（先构建 core，或设置 OWC_CORE_PATH）`);
  process.exit(2);
}

const isWindows = process.platform === "win32";
const sleepCmd = isWindows
  ? `powershell -NoProfile -Command "Start-Sleep -Milliseconds ${LONG_MS}"`
  : `sleep ${(LONG_MS / 1000).toFixed(3)}`;
const shortCmd = isWindows
  ? "powershell -NoProfile -Command \"Write-Output ok\""
  : "echo ok";

const root = await mkdtemp(path.join(os.tmpdir(), "owc-bench-control-"));
const cwdA = path.join(root, "a");
const cwdB = path.join(root, "b");
await mkdir(cwdA, { recursive: true });
await mkdir(cwdB, { recursive: true });

const sandbox = (cwd) => ({ enabled: false, readRoots: [cwd], writeRoots: [cwd], denyPaths: [], network: "allow" });
const core = new CoreClient(corePath, 130_000);

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

try {
  const info = await core.start();
  await core.configureSession({ sessionId: "A", cwd: cwdA, sandbox: sandbox(cwdA) });
  await core.configureSession({ sessionId: "B", cwd: cwdB, sandbox: sandbox(cwdB) });
  await core.run({ sessionId: "A", execId: "warm-a", cmd: shortCmd, cwd: cwdA, timeoutMs: 30_000 });
  await core.run({ sessionId: "B", execId: "warm-b", cmd: shortCmd, cwd: cwdB, timeoutMs: 30_000 });
  await core.statFile({ sessionId: "B", path: "." });

  const configure = [];
  const stat = [];
  const ping = [];
  const shortExec = [];
  const twoShort = [];

  for (let round = 0; round < ROUNDS; round++) {
    const long = core.run({
      sessionId: "A",
      execId: `long-${round}`,
      cmd: sleepCmd,
      cwd: cwdA,
      timeoutMs: 60_000,
    });
    // 让长命令真正进入执行；core 同步执行时这里之后主循环已不可用。
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 四个控制面调用同时发出：同步 exec.run 会占住主循环，它们都应被卡住。
    const [cfg, st, pg, ex] = await Promise.all([
      timed(() => core.configureSession({ sessionId: "B", cwd: cwdB, sandbox: sandbox(cwdB) })),
      timed(() => core.statFile({ sessionId: "B", path: "." })),
      timed(() => core.ping()),
      timed(() => core.run({ sessionId: "B", execId: `short-${round}`, cmd: shortCmd, cwd: cwdB, timeoutMs: 30_000 })),
    ]);
    configure.push(cfg.ms);
    stat.push(st.ms);
    ping.push(pg.ms);
    shortExec.push(ex.ms);

    await long;

    const two = await timed(() => Promise.all([
      core.run({ sessionId: "A", execId: `two-a-${round}`, cmd: shortCmd, cwd: cwdA, timeoutMs: 30_000 }),
      core.run({ sessionId: "B", execId: `two-b-${round}`, cmd: shortCmd, cwd: cwdB, timeoutMs: 30_000 }),
    ]));
    twoShort.push(two.ms);
  }

  const metrics = [
    { name: "control.configure.p50", value: summarize(configure).p50, unit: "ms", direction: "lower-better" },
    { name: "control.configure.p95", value: summarize(configure).p95, unit: "ms", direction: "lower-better" },
    { name: "control.stat.p50", value: summarize(stat).p50, unit: "ms", direction: "lower-better" },
    { name: "control.stat.p95", value: summarize(stat).p95, unit: "ms", direction: "lower-better" },
    { name: "control.ping.p50", value: summarize(ping).p50, unit: "ms", direction: "lower-better" },
    { name: "control.ping.p95", value: summarize(ping).p95, unit: "ms", direction: "lower-better" },
    { name: "control.shortExec.p50", value: summarize(shortExec).p50, unit: "ms", direction: "lower-better" },
    { name: "control.shortExec.p95", value: summarize(shortExec).p95, unit: "ms", direction: "lower-better" },
    { name: "exec.twoShort.p50", value: summarize(twoShort).p50, unit: "ms", direction: "lower-better" },
    { name: "exec.twoShort.p95", value: summarize(twoShort).p95, unit: "ms", direction: "lower-better" },
    { name: "params.rounds", value: ROUNDS, unit: "count", direction: "none" },
    { name: "params.longMs", value: LONG_MS, unit: "ms", direction: "none" },
    { name: "core.version", value: info.version, unit: "text", direction: "none" },
  ];
  await writeResult("multi-session-control", metrics, args.out);
} finally {
  await core.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
