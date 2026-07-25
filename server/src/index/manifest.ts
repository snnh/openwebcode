/**
 * manifest diff（0.4.0 Phase 2 §4.1）：core `index.scan` 始终输出完整清单，
 * 增量语义由 Node 对连续 manifest 做 diff 得到。
 * 变化判定：优先 sha256；缺 hash 的条目退回 size+modifiedMs 联合判定。
 */

import type { IndexScanEntry } from "../core-client.js";

export interface ManifestDiff {
  added: IndexScanEntry[];
  changed: IndexScanEntry[];
  deleted: string[];
}

function entryEquals(prev: IndexScanEntry, next: IndexScanEntry): boolean {
  if (prev.sha256 && next.sha256) return prev.sha256 === next.sha256;
  return prev.size === next.size && prev.modifiedMs === next.modifiedMs;
}

export function diffManifest(previous: ReadonlyMap<string, IndexScanEntry>, next: readonly IndexScanEntry[]): ManifestDiff {
  const added: IndexScanEntry[] = [];
  const changed: IndexScanEntry[] = [];
  const seen = new Set<string>();
  for (const entry of next) {
    seen.add(entry.path);
    const prev = previous.get(entry.path);
    if (!prev) added.push(entry);
    else if (!entryEquals(prev, entry)) changed.push(entry);
  }
  const deleted: string[] = [];
  for (const path of previous.keys()) {
    if (!seen.has(path)) deleted.push(path);
  }
  return { added, changed, deleted };
}
