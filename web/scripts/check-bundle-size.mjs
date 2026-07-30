// 构建产物体积预算校验（Phase 0 bundle 治理；0.5.0 Phase 1a 增加编辑器 chunk 独立上限）
// 规则：主入口 chunk（index-*.js）≤ ENTRY_BUDGET_KB；Monaco 编辑器懒加载 chunk（monaco-*.js）
// ≤ MONACO_BUDGET_KB；Monaco 语言服务 worker chunk（*.worker-*.js，运行时按语言按需加载，
// 不进首屏）≤ WORKER_BUDGET_KB；其余单个 JS chunk ≤ CHUNK_BUDGET_KB。
// 阈值集中在顶部常量，后续演进直接改这里。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_BUDGET_KB = 520; // 主入口 chunk 上限（minified，未压缩；当前入口约 503 KB，预算留 ~3% 余量）
const CHUNK_BUDGET_KB = 500; // 其他单个 JS chunk 上限
const MONACO_BUDGET_KB = 4096; // Monaco 编辑器懒加载 chunk 上限（仅在打开编辑器时加载，不影响入口体积）
const WORKER_BUDGET_KB = 7168; // Monaco 语言服务 worker chunk 上限（ts.worker 约 6.8MB，仅打开对应语言文件时按需加载）

const assetsDir = fileURLToPath(new URL("../dist/assets", import.meta.url));

let files;
try {
  files = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
} catch {
  console.error(`[check-bundle-size] 找不到构建产物目录：${assetsDir}，请先运行 vite build`);
  process.exit(1);
}

function budgetOf(name) {
  if (/^index-[\w-]+\.js$/.test(name)) return { budget: ENTRY_BUDGET_KB, label: "主入口" };
  if (/^monaco-[\w-]+\.js$/.test(name)) return { budget: MONACO_BUDGET_KB, label: "编辑器 chunk" };
  if (/\.worker-[\w-]+\.js$/.test(name)) return { budget: WORKER_BUDGET_KB, label: "编辑器 worker chunk" };
  return { budget: CHUNK_BUDGET_KB, label: "chunk" };
}

const failures = [];
for (const name of files) {
  const sizeKb = statSync(join(assetsDir, name)).size / 1024;
  const { budget, label } = budgetOf(name);
  if (sizeKb > budget) {
    failures.push(`${name}: ${sizeKb.toFixed(1)} KB 超过 ${label} 上限 ${budget} KB`);
  }
}

if (failures.length > 0) {
  console.error(`[check-bundle-size] 体积预算未达标：\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`[check-bundle-size] ${files.length} 个 JS chunk 均在预算内（入口 ≤ ${ENTRY_BUDGET_KB} KB，编辑器 ≤ ${MONACO_BUDGET_KB} KB，编辑器 worker ≤ ${WORKER_BUDGET_KB} KB，其余 ≤ ${CHUNK_BUDGET_KB} KB）`);
