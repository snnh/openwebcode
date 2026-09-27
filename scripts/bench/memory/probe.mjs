// 内存诊断探针：server 主进程的驻留/分配/模块成本三视角测量（Linux）。
//
// 用法（PID 需先通过 `kill -USR1 <pid>` 打开 inspector；默认 127.0.0.1:9229）：
//   node scripts/bench/memory/probe.mjs gc <pid>
//       CDP 触发两次 full GC，前后对比 heapUsed / heapTotal / external / RSS。
//       用途：区分「真实驻留」与「V8 空闲页未归还」——这是 server RSS 只涨不跌的常见形态。
//   node scripts/bench/memory/probe.mjs alloc <pid> [秒数=12]
//       堆分配采样（HeapProfiler.startSampling），按函数输出 top 分配点。
//       用途：定位高频大分配（如整表 JSON.parse）——采样值只含分配量，不受 GC 时机影响。
//   node scripts/bench/memory/probe.mjs heap <pid>
//       GC 后取堆快照并统计 top 构造器自持大小。
//       用途：确认驻留构成，排除异常结构（泄漏的大数组/字符串会顶到榜首）。
//   node scripts/bench/memory/probe.mjs modcost <dist 模块路径...>
//       独立子进程顺序 import 各模块，测量每步 RSS 增量（差分）。
//       用途：判断「把某模块改动态 import」的真实收益——在共享依赖（fastify/undici 等
//       必需基础设施）已加载后，业务模块的增量常常 <1MB，即懒加载无收益。
//   node scripts/bench/memory/probe.mjs segment <dataDir> <sessionId>
//       活动段加载 vs 整表加载的堆占用/耗时对比（SessionStore.getActive vs get）。
//       用途：验证 /clear、压缩锚点之后的大会话是否只驻留活动段。
//
// 前置：server/dist 已构建；ws 从 server/node_modules 解析（不在仓库根另装依赖）。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "server", "package.json"));
const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "server");
const MB = 1024 * 1024;

function rssMB(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)[1]) * 1024 / MB);
}

async function connect() {
  const { default: WebSocket } = await import(require.resolve("ws"));
  const list = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json());
  const ws = new WebSocket(list[0].webSocketDebuggerUrl, { maxPayload: 1024 * MB });
  let id = 0;
  const pending = new Map();
  const chunks = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(msg.params.chunk);
  });
  await new Promise((resolve) => ws.on("open", resolve));
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send, chunks };
}

const evalIn = async (send, expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
const memoryExpr = `(() => { const m = process.memoryUsage(); const r = (n) => Math.round(n/${MB}); return JSON.stringify({ heapUsed: r(m.heapUsed), heapTotal: r(m.heapTotal), external: r(m.external), arrayBuffers: r(m.arrayBuffers), rss: r(m.rss) }) })()`;

async function cmdGc(pid) {
  const { ws, send } = await connect();
  await send("HeapProfiler.enable");
  console.log("BEFORE:", await evalIn(send, memoryExpr), "procRSS", rssMB(pid) + "MB");
  await send("HeapProfiler.collectGarbage");
  await send("HeapProfiler.collectGarbage");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  console.log("AFTER :", await evalIn(send, memoryExpr), "procRSS", rssMB(pid) + "MB");
  ws.close();
}

async function cmdAlloc(pid, seconds = 12) {
  const { ws, send } = await connect();
  await send("HeapProfiler.enable");
  await send("HeapProfiler.startSampling", { samplingInterval: 32768 });
  console.log(`sampling ${seconds}s ...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const { result } = await send("HeapProfiler.stopSampling");
  ws.close();
  const totals = new Map();
  const walk = (node) => {
    const cf = node.callFrame;
    const label = `${cf.functionName || "(anon)"} @ ${String(cf.url).replace(/^file:\/\/.*\/(dist|node_modules)\//, "")}:${cf.lineNumber + 1}`;
    if (node.selfSize > 0) totals.set(label, (totals.get(label) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) walk(child);
  };
  walk(result.profile.head);
  console.log("top 分配点:");
  for (const [label, size] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    if (size > 512 * 1024) console.log(`${(size / MB).toFixed(1).padStart(8)} MB  ${label}`);
  }
}

async function cmdHeap(pid) {
  const { ws, send, chunks } = await connect();
  await send("HeapProfiler.enable");
  await send("HeapProfiler.collectGarbage");
  await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  ws.close();
  const data = JSON.parse(chunks.join(""));
  const meta = data.snapshot.meta;
  const fields = meta.node_fields;
  const nameIdx = fields.indexOf("name"), selfIdx = fields.indexOf("self_size"), typeIdx = fields.indexOf("type");
  const nodeTypes = meta.node_types[typeIdx];
  const totals = new Map();
  for (let i = 0; i < data.nodes.length; i += fields.length) {
    const type = nodeTypes[data.nodes[i + typeIdx]];
    const raw = data.strings[data.nodes[i + nameIdx]];
    const name = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
    const key = `${type}:${name}`;
    totals.set(key, (totals.get(key) ?? 0) + data.nodes[i + selfIdx]);
  }
  console.log(`快照 ${(chunks.join("").length / MB).toFixed(0)}MB，top 构造器自持:`);
  for (const [key, size] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${(size / MB).toFixed(1).padStart(8)} MB  ${key}`);
  }
}

function cmdModCost(modules) {
  console.log("独立子进程顺序加载（每步 RSS 增量）:");
  spawnSync(process.execPath, ["--expose-gc", "-e", "global.gc?.(); console.log('bare: ' + (process.memoryUsage().rss/1048576|0) + ' MB');"], { stdio: "inherit" });
  for (const mod of modules) {
    const absolute = path.isAbsolute(mod) ? mod : path.join(SERVER_ROOT, mod);
    const script = `global.gc?.(); import(${JSON.stringify(absolute)}).then(() => { global.gc?.(); console.log((process.memoryUsage().rss/1048576|0) + ' MB after ' + ${JSON.stringify(mod)}); }).catch((error) => console.log('ERR ' + error.code + ' ' + ${JSON.stringify(mod)}));`;
    spawnSync(process.execPath, ["--expose-gc", "-e", script], { stdio: "inherit" });
  }
}

async function cmdSegment(dataDir, sessionId) {
  const { SessionStore } = await import(path.join(SERVER_ROOT, "dist/sessions/session-store.js"));
  const { ContextManager } = await import(path.join(SERVER_ROOT, "dist/context/context-manager.js"));
  const { pickSegmentBoundary } = await import(path.join(SERVER_ROOT, "dist/context/context-ledger-ops.js"));
  const store = new SessionStore(path.join(dataDir, "sessions"));
  const context = new ContextManager(store.contextRoot(sessionId));
  const ledger = await context.load();
  const boundary = pickSegmentBoundary(ledger);
  console.log("ledger 边界:", boundary ? `${boundary.kind} @ ${boundary.uptoMessageId.slice(0, 8)}` : "无（回退整表）");
  global.gc?.();
  let before = process.memoryUsage().heapUsed;
  let started = Date.now();
  const segment = await store.getActive(sessionId, boundary);
  console.log(`段加载: ${segment.messages.length} 条, 堆 +${Math.round((process.memoryUsage().heapUsed - before) / MB)}MB, ${Date.now() - started}ms`);
  global.gc?.();
  const store2 = new SessionStore(path.join(dataDir, "sessions"));
  before = process.memoryUsage().heapUsed;
  started = Date.now();
  const full = await store2.get(sessionId);
  console.log(`整表加载: ${full.messages.length} 条, 堆 +${Math.round((process.memoryUsage().heapUsed - before) / MB)}MB, ${Date.now() - started}ms`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "gc") await cmdGc(Number(rest[0]));
else if (command === "alloc") await cmdAlloc(Number(rest[0]), rest[1] ? Number(rest[1]) : undefined);
else if (command === "heap") await cmdHeap(Number(rest[0]));
else if (command === "modcost") cmdModCost(rest);
else if (command === "segment") await cmdSegment(rest[0], rest[1]);
else {
  console.log("用法: probe.mjs gc|alloc|heap <pid> | modcost <dist模块...> | segment <dataDir> <sessionId>");
  process.exit(1);
}
