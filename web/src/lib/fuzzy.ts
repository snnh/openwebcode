/**
 * 子序列模糊匹配：Quick Open 与命令面板共用的轻量评分。
 * 返回 -1 表示不匹配；分数越高匹配越好（连续命中、词首命中、短串优先）。
 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const text = candidate.toLowerCase();
  let score = 0;
  let qi = 0;
  let streak = 0;
  let lastHit = -2;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] !== q[qi]) continue;
    // 连续命中加分；路径分隔符/驼峰/连字符后的词首命中加分
    streak = lastHit === ti - 1 ? streak + 1 : 0;
    score += 1 + streak * 2;
    if (ti === 0 || "/\\-_ .".includes(text[ti - 1]) || (text[ti] !== candidate[ti] && candidate[ti] === candidate[ti].toUpperCase())) {
      score += 3;
    }
    lastHit = ti;
    qi++;
  }
  if (qi < q.length) return -1;
  // 更短的候选串排名靠前
  score -= text.length * 0.01;
  return score;
}

interface Ranked<T> {
  item: T;
  score: number;
}

/** 过滤并按分数降序排列；空 query 保留原顺序。 */
export function filterAndRank<T>(query: string, items: readonly T[], text: (item: T) => string): T[] {
  const q = query.trim();
  if (!q) return [...items];
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(q, text(item));
    if (score >= 0) ranked.push({ item, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((entry) => entry.item);
}
