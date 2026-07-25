// 两次基准结果对比：回归 > 15% 标红并以非零码退出。
// 用法：server/node_modules/.bin/tsx scripts/bench/compare.mjs <baseline.json> <candidate.json>
// 指标按 name 匹配；direction 决定回归方向：
//   lower-better  涨幅 > +15% 记回归
//   higher-better 跌幅 > -15% 记回归
//   none          只展示不参与判定
// 跨场景文件对比时只比交集指标。

import { readFile } from "node:fs/promises";

const REGRESSION_THRESHOLD = 15; // 百分比

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error("用法：tsx scripts/bench/compare.mjs <baseline.json> <candidate.json>");
  process.exit(2);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
const baseByName = new Map(baseline.metrics.map((m) => [m.name, m]));

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

console.log(`baseline : ${baseline.scenario} @ ${baseline.timestamp} (${baseline.environment?.commit ?? "?"})`);
console.log(`candidate: ${candidate.scenario} @ ${candidate.timestamp} (${candidate.environment?.commit ?? "?"})`);
if (baseline.scenario !== candidate.scenario) {
  console.log(`${DIM}警告：场景不同，仅按指标名取交集对比${RESET}`);
}
console.log("");

let regressions = 0;
let compared = 0;
for (const cand of candidate.metrics) {
  const base = baseByName.get(cand.name);
  if (!base) {
    console.log(`  [新增] ${cand.name}: ${cand.value} ${cand.unit}`);
    continue;
  }
  if (cand.direction === "none" || base.value === 0) {
    console.log(`  ${DIM}[跳过] ${cand.name}: ${base.value} → ${cand.value} ${cand.unit}${RESET}`);
    continue;
  }
  compared++;
  const pct = ((cand.value - base.value) / base.value) * 100;
  const isRegression = cand.direction === "lower-better" ? pct > REGRESSION_THRESHOLD : pct < -REGRESSION_THRESHOLD;
  if (isRegression) regressions++;
  const tag = isRegression ? `${RED}[回归]` : pct === 0 ? `${DIM}[持平]` : `${GREEN}[正常]`;
  console.log(`  ${tag} ${cand.name}: ${base.value} → ${cand.value} ${cand.unit} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)${RESET}`);
}

console.log("");
if (regressions > 0) {
  console.log(`${RED}发现 ${regressions}/${compared} 项指标回归超过 ${REGRESSION_THRESHOLD}%${RESET}`);
  process.exit(1);
}
console.log(`${GREEN}${compared} 项可比指标均在 ${REGRESSION_THRESHOLD}% 阈值内${RESET}`);
