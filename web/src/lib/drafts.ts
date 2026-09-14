/**
 * Composer 草稿的 sessionStorage 持久化：键 `owc-draft-<sessionId>`。
 * 刷新不丢，但标签页关闭即清除——草稿可能含未发送的敏感内容，
 * 不落盘到 localStorage（否则浏览器 profile 中长期残留明文）。
 * 与内存 drafts 镜像：发送后清空条目；会话列表加载后修剪已删除会话的残留键。
 */

const DRAFT_PREFIX = "owc-draft-";

/** 旧版草稿存 localStorage（明文长期残留）：首次使用时迁移清理，不保留副本。 */
let legacyPurged = false;
function purgeLegacyDrafts(): void {
  if (legacyPurged) return;
  legacyPurged = true;
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // localStorage 不可用时忽略
  }
}

function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

/** 读取持久化草稿；键不存在、JSON 损坏或内容非字符串时返回 undefined */
export function loadDraft(sessionId: string): string | undefined {
  purgeLegacyDrafts();
  try {
    const raw = window.sessionStorage.getItem(draftKey(sessionId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" && parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 写入草稿；空串等价于清除。持久化失败（隐私模式/配额）不影响使用 */
export function saveDraft(sessionId: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(draftKey(sessionId), JSON.stringify(value));
    else window.sessionStorage.removeItem(draftKey(sessionId));
  } catch {
    // 持久化失败不影响使用
  }
}

export function clearDraft(sessionId: string): void {
  try {
    window.sessionStorage.removeItem(draftKey(sessionId));
  } catch {
    // 忽略
  }
}

/** 会话列表加载后调用：删除不属于任何现存会话的草稿键 */
export function pruneDrafts(validSessionIds: ReadonlySet<string>): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key && key.startsWith(DRAFT_PREFIX) && !validSessionIds.has(key.slice(DRAFT_PREFIX.length))) {
        stale.push(key);
      }
    }
    for (const key of stale) window.sessionStorage.removeItem(key);
  } catch {
    // 忽略
  }
}
