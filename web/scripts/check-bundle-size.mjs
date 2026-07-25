// 构建产物体积预算校验（Phase 0 bundle 治理）
// 规则：主入口 chunk（index-*.js）≤ ENTRY_BUDGET_KB；其余单个 JS chunk ≤ CHUNK_BUDGET_KB。
// 阈值集中在顶部常量，后续演进直接改这里。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_BUDGET_KB = 500; // 主入口 chunk 上限（minified，未压缩）
const CHUNK_BUDGET_KB = 500; // 其他单个 JS chunk 上限

const assetsDir = fileURLToPath(new URL("../dist/assets", import.meta.url));

let files;
try {
  files = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
} catch {
  console.error(`[check-bundle-size] 找不到构建产物目录：${assetsDir}，请先运行 vite build`);
  process.exit(1);
}

const failures = [];
for (const name of files) {
  const sizeKb = statSync(join(assetsDir, name)).size / 1024;
  const isEntry = /^index-[\w-]+\.js$/.test(name);
  const budget = isEntry ? ENTRY_BUDGET_KB : CHUNK_BUDGET_KB;
  if (sizeKb > budget) {
    failures.push(`${name}: ${sizeKb.toFixed(1)} KB 超过 ${isEntry ? "主入口" : "chunk"} 上限 ${budget} KB`);
  }
}

if (failures.length > 0) {
  console.error(`[check-bundle-size] 体积预算未达标：\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`[check-bundle-size] ${files.length} 个 JS chunk 均在预算内（入口 ≤ ${ENTRY_BUDGET_KB} KB，其余 ≤ ${CHUNK_BUDGET_KB} KB）`);
