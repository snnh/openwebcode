/**
 * Composer 草稿的 localStorage 持久化：键 `owc-draft-<sessionId>`。
 * 与内存 drafts 镜像：发送后清空条目；会话列表加载后修剪已删除会话的残留键。
 */

const DRAFT_PREFIX = "owc-draft-";

function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

/** 读取持久化草稿；键不存在、JSON 损坏或内容非字符串时返回 undefined */
export function loadDraft(sessionId: string): string | undefined {
  try {
    const raw = window.localStorage.getItem(draftKey(sessionId));
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
    if (value) window.localStorage.setItem(draftKey(sessionId), JSON.stringify(value));
    else window.localStorage.removeItem(draftKey(sessionId));
  } catch {
    // 持久化失败不影响使用
  }
}

export function clearDraft(sessionId: string): void {
  try {
    window.localStorage.removeItem(draftKey(sessionId));
  } catch {
    // 忽略
  }
}

/** 会话列表加载后调用：删除不属于任何现存会话的草稿键 */
export function pruneDrafts(validSessionIds: ReadonlySet<string>): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(DRAFT_PREFIX) && !validSessionIds.has(key.slice(DRAFT_PREFIX.length))) {
        stale.push(key);
      }
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}
