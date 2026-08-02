// 基准：10 万文件级索引冷加载与查询（code_search / @ 补全 / Quick Open 供数路径）。
// 不生成 10 万真实磁盘文件：按 index-store.ts 的真实磁盘格式（meta.json + files.jsonl
// + symbols.jsonl，压实后的单批次快照形态，batch 头带固定 at 保证逐字节可复现）在临时目录
// 构造 10 万行量级索引数据，跑完清理。
// 测量：
//   1. IndexStore.load() 冷加载（逐行 JSON.parse replay，index-store.ts:196-215）
//   2. IndexManager 首次查询（ensureLoaded 全链路）
//   3. searchSymbols / searchFiles 温查询（index-manager.ts:585-627 fuzzyScore 全扫），
//      固定 query 集 × N 次，报 p50/p95
// 用途：诊断型基准——决策 code_search/Quick Open 是否需要索引结构优化（当前每次击键
// 全扫内存 Map，O(符号数)）。
// 验收门禁（占位性质）：本基准无历史基线，门禁按本机实测 + 3-5 倍余量设定，
// 只拦截量级级劣化（如实现退化为每次查询重读磁盘），待首个 release 基线建立后收紧。
// 用法：server/node_modules/.bin/tsx scripts/bench/bench-index-100k.mjs [--out path]

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mulberry32, parseArgs, round2, summarize, tryGc, writeResult } from "./lib/common.mjs";

const SEED = 20260802; // 固定 seed，改动即新数据集
const FILE_COUNT = 100_000;
const CODE_FILE_RATIO = 0.6; // 代码文件占比（提符号），其余只进文件清单
const QUERY_RUNS = 30; // 每个 query 的重复次数，取 p50/p95
const FIXTURE_CWD = "D:/bench/index-100k-fixture";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

// ---- 占位门禁（见文件头注释；首个基线后收紧）----
// 取值依据：2026-08 开发机实测 replay ~166ms / coldFirst ~248ms / 温查询最差 p95 ~41ms。
// 门禁放在实测的 ~6 倍：共享 CI runner 的磁盘 IO 与 CPU 抖动远大于本机，
// 余量放宽后仍能拦截量级级劣化（如查询退化为重读磁盘、replay 退化为逐行异步 IO）。
const GATE_REPLAY_MS = 1_000; // 冷加载
const GATE_COLD_FIRST_MS = 1_500; // ensureLoaded 全链路首次查询
const GATE_SYMBOL_WORST_P95_MS = 200; // searchSymbols 各 query 最差 p95
const GATE_FILE_WORST_P95_MS = 250; // searchFiles 各 query 最差 p95

// 固定 query 集：覆盖 fuzzyScore 的各评分分支（前缀/子串/子序列/无匹配全扫）。
// 词表与下方生成器同源，seed 固定则命中分布稳定；nomatch 是最坏情况（全扫零命中）。
const SYMBOL_QUERIES = [
  { tag: "prefix", query: "parse" },
  { tag: "substring", query: "Session" },
  { tag: "subsequence", query: "ldtkn" },
  { tag: "kindFilter", query: "parse", kind: "function" },
  { tag: "nomatch", query: "zzNoMatchAnywhere" },
];
const FILE_QUERIES = [
  { tag: "basename", query: "index.ts" },
  { tag: "pathSegment", query: "pkg-0500" },
  { tag: "shallow", query: "mod-3" },
  { tag: "nomatch", query: "zzNoMatchAnywhere" },
];

const CODE_EXTS = ["ts", "ts", "tsx", "js", "py", "go", "rs", "java", "cpp", "cs"];
const DATA_EXTS = ["md", "json", "yml", "txt", "css"];
const SYMBOL_KINDS = ["function", "method", "class", "interface", "type", "constant", "variable"];
const NAME_VERBS = ["get", "set", "build", "parse", "render", "handle", "load", "save", "fetch", "compute"];
const NAME_NOUNS = ["Config", "Session", "Index", "Symbol", "Manifest", "Buffer", "Stream", "Token", "File", "Path", "Manager", "Store", "Client", "Queue"];

const args = parseArgs(process.argv.slice(2));

const { IndexStore, workspaceHash, INDEX_FORMAT_VERSION } = await import("../../server/src/index/index-store.ts");
const { IndexManager } = await import("../../server/src/index/index-manager.ts");
const { EventBus } = await import("../../server/src/events/event-bus.ts");

/** 确定性伪 hex（sha256 字段的填充，只要求形状真实）。 */
function pseudoHex(rng, len) {
  let out = "";
  while (out.length < len) out += Math.floor(rng() * 16).toString(16);
  return out.slice(0, len);
}

/** 生成 10 万文件索引快照，返回 { filesText, symbolsText, meta, symbolCount }。 */
function generateIndexDataset() {
  const rng = mulberry32(SEED >>> 0);
  const filesLines = [JSON.stringify({ type: "batch", batch: 0, at: BASE_TIME, compacted: true })];
  const symbolsLines = [JSON.stringify({ type: "batch", batch: 0, at: BASE_TIME, compacted: true })];
  let symbolCount = 0;
  for (let i = 0; i < FILE_COUNT; i++) {
    const isCode = rng() < CODE_FILE_RATIO;
    const ext = isCode ? CODE_EXTS[Math.floor(rng() * CODE_EXTS.length)] : DATA_EXTS[Math.floor(rng() * DATA_EXTS.length)];
    // 目录按 i 顺序唯一划分（每 10 个文件一个目录），避免不同 i 碰撞同路径被 Map 去重
    const dir = `src/pkg-${String(Math.floor(i / 100)).padStart(4, "0")}/mod-${Math.floor(i / 10) % 10}`;
    // 每 10 个代码文件一个叫 index.<ext>：制造大量基名精确命中（真实仓库同形态）
    const base = isCode && i % 10 === 0 ? `index.${ext}` : `file-${i}.${ext}`;
    const filePath = `${dir}/${base}`;
    filesLines.push(JSON.stringify({
      path: filePath,
      size: 500 + Math.floor(rng() * 20_000),
      modifiedMs: BASE_TIME + i * 1000,
      sha256: pseudoHex(rng, 64),
    }));
    if (!isCode) continue;
    const perFile = 1 + Math.floor(rng() * 6);
    const symbols = [];
    for (let s = 0; s < perFile; s++) {
      const name = NAME_VERBS[Math.floor(rng() * NAME_VERBS.length)] + NAME_NOUNS[Math.floor(rng() * NAME_NOUNS.length)];
      const startLine = 1 + Math.floor(rng() * 900);
      symbols.push({
        name,
        kind: SYMBOL_KINDS[Math.floor(rng() * SYMBOL_KINDS.length)],
        startLine,
        endLine: startLine + Math.floor(rng() * 40),
        signature: `${name}(args): void // bench fixture`,
      });
    }
    symbolCount += symbols.length;
    symbolsLines.push(JSON.stringify({ path: filePath, symbols }));
  }
  const meta = {
    version: INDEX_FORMAT_VERSION,
    cwd: FIXTURE_CWD,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + FILE_COUNT * 1000,
    files: FILE_COUNT,
    symbols: symbolCount,
  };
  return {
    filesText: filesLines.join("\n") + "\n",
    symbolsText: symbolsLines.join("\n") + "\n",
    meta,
    symbolCount,
  };
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "owc-bench-index-"));
const failures = [];
try {
  // ---- 构造索引数据（压实后的单批次快照形态）----
  const dataset = generateIndexDataset();
  const indexRoot = path.join(tmpRoot, "index");
  const indexDir = path.join(indexRoot, workspaceHash(FIXTURE_CWD));
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(indexDir, "files.jsonl"), dataset.filesText, "utf8");
  await writeFile(path.join(indexDir, "symbols.jsonl"), dataset.symbolsText, "utf8");
  await writeFile(path.join(indexDir, "meta.json"), JSON.stringify(dataset.meta, null, 2), "utf8");
  const filesSha256 = createHash("sha256").update(dataset.filesText).digest("hex");
  const symbolsSha256 = createHash("sha256").update(dataset.symbolsText).digest("hex");
  console.log(`索引数据已构造：${FILE_COUNT} 文件 / ${dataset.symbolCount} 符号（files.jsonl ${(dataset.filesText.length / 1024 / 1024).toFixed(1)} MiB，symbols.jsonl ${(dataset.symbolsText.length / 1024 / 1024).toFixed(1)} MiB）`);
  console.log(`  files.jsonl sha256:   ${filesSha256}`);
  console.log(`  symbols.jsonl sha256: ${symbolsSha256}`);

  // ---- 冷加载：IndexStore.load() 逐行 JSON.parse replay ----
  tryGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const store = new IndexStore(indexRoot, FIXTURE_CWD);
  const replayStart = performance.now();
  const loaded = await store.load();
  const replayMs = performance.now() - replayStart;
  tryGc();
  const loadHeapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  if (loaded.files.size !== FILE_COUNT) throw new Error(`索引文件数不符：${loaded.files.size} != ${FILE_COUNT}`);
  const loadedSymbols = [...loaded.symbols.values()].reduce((sum, list) => sum + list.length, 0);
  if (loadedSymbols !== dataset.symbolCount) throw new Error(`索引符号数不符：${loadedSymbols} != ${dataset.symbolCount}`);
  console.log(`\n冷加载 replay：${replayMs.toFixed(1)} ms（${loaded.fileLines + loaded.symbolLines} 行），堆增量 ${loadHeapDeltaMB.toFixed(1)} MiB`);

  // ---- IndexManager 全链路：首次查询触发 ensureLoaded ----
  const stubCore = { on() { return stubCore; } };
  const manager = new IndexManager(stubCore, indexRoot, new EventBus(), { autoRefresh: false });
  const coldFirstStart = performance.now();
  await manager.searchSymbols(FIXTURE_CWD, "parse");
  const coldFirstMs = performance.now() - coldFirstStart;
  console.log(`ensureLoaded 全链路首次查询：${coldFirstMs.toFixed(1)} ms`);

  // ---- 温查询：固定 query 集 × QUERY_RUNS 次 ----
  async function benchQueries(kind, queries) {
    const results = [];
    for (const spec of queries) {
      const samples = [];
      for (let i = 0; i < QUERY_RUNS; i++) {
        const start = performance.now();
        if (kind === "symbols") await manager.searchSymbols(FIXTURE_CWD, spec.query, spec.kind ? { kind: spec.kind } : {});
        else await manager.searchFiles(FIXTURE_CWD, spec.query);
        samples.push(performance.now() - start);
      }
      results.push({ spec, summary: summarize(samples), samples });
      console.log(`  ${kind}.${spec.tag} ("${spec.query}"${spec.kind ? `, kind=${spec.kind}` : ""}): p50=${results[results.length - 1].summary.p50} ms, p95=${results[results.length - 1].summary.p95} ms`);
    }
    return results;
  }
  console.log(`\n温查询（每 query ${QUERY_RUNS} 次）：`);
  const symbolResults = await benchQueries("symbols", SYMBOL_QUERIES);
  const fileResults = await benchQueries("files", FILE_QUERIES);
  manager.stop();

  const symbolWorstP95 = Math.max(...symbolResults.map((r) => r.summary.p95));
  const fileWorstP95 = Math.max(...fileResults.map((r) => r.summary.p95));

  // ---- 汇总输出 ----
  const metrics = [
    { name: "load.replayMs", value: round2(replayMs), unit: "ms", direction: "lower-better" },
    { name: "load.heapDelta", value: round2(loadHeapDeltaMB), unit: "MiB", direction: "lower-better" },
    { name: "query.coldFirstMs", value: round2(coldFirstMs), unit: "ms", direction: "lower-better" },
    { name: "query.symbols.worstP95", value: symbolWorstP95, unit: "ms", direction: "lower-better", minDelta: 2 },
    { name: "query.files.worstP95", value: fileWorstP95, unit: "ms", direction: "lower-better", minDelta: 2 },
  ];
  for (const { spec, summary } of symbolResults) {
    metrics.push(
      { name: `symbols.${spec.tag}.p50`, value: summary.p50, unit: "ms", direction: "lower-better", minDelta: 2 },
      { name: `symbols.${spec.tag}.p95`, value: summary.p95, unit: "ms", direction: "lower-better", minDelta: 2 },
    );
  }
  for (const { spec, summary } of fileResults) {
    metrics.push(
      { name: `files.${spec.tag}.p50`, value: summary.p50, unit: "ms", direction: "lower-better", minDelta: 2 },
      { name: `files.${spec.tag}.p95`, value: summary.p95, unit: "ms", direction: "lower-better", minDelta: 2 },
    );
  }
  metrics.push(
    { name: "dataset.files", value: FILE_COUNT, unit: "count", direction: "none" },
    { name: "dataset.symbols", value: dataset.symbolCount, unit: "count", direction: "none" },
  );

  await writeResult("index-100k", metrics, args.out, {
    params: {
      seed: SEED,
      fileCount: FILE_COUNT,
      queryRuns: QUERY_RUNS,
      queries: { symbols: SYMBOL_QUERIES, files: FILE_QUERIES },
      datasetSha256: { files: filesSha256, symbols: symbolsSha256 },
      // 门禁是占位性质（见文件头注释），写进结果便于审阅
      gates: {
        replayMs: GATE_REPLAY_MS,
        coldFirstMs: GATE_COLD_FIRST_MS,
        symbolWorstP95Ms: GATE_SYMBOL_WORST_P95_MS,
        fileWorstP95Ms: GATE_FILE_WORST_P95_MS,
      },
    },
    samples: Object.fromEntries([
      ...symbolResults.map((r) => [`symbols.${r.spec.tag}Ms`, r.samples.map(round2)]),
      ...fileResults.map((r) => [`files.${r.spec.tag}Ms`, r.samples.map(round2)]),
    ]),
  });

  // ---- 验收门禁（占位性质，见文件头注释）----
  const checks = [
    ["冷加载 replay", replayMs, GATE_REPLAY_MS],
    ["ensureLoaded 首次查询", coldFirstMs, GATE_COLD_FIRST_MS],
    ["searchSymbols 最差 p95", symbolWorstP95, GATE_SYMBOL_WORST_P95_MS],
    ["searchFiles 最差 p95", fileWorstP95, GATE_FILE_WORST_P95_MS],
  ];
  for (const [label, value, gate] of checks) {
    if (value >= gate) failures.push(`${label} ${value.toFixed(1)} ms >= 门禁 ${gate} ms`);
  }
} finally {
  // Windows ENOTEMPTY 注意：与 server 测试同款——独立临时根 + 递归 force 清理，
  // 不在 finally 里混用其他可能持句柄的关闭逻辑（manager.stop() 已在上面显式调用）。
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n[验收未通过]\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\n[验收通过] 所有占位门禁达标（门禁性质见文件头注释，待首个基线后收紧）");
