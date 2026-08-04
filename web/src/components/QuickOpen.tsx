/**
 * Quick Open（Ctrl/Cmd+P，0.4.0 Phase 5a）：模糊匹配工作区文件，
 * 选中后在只读代码视图浮层打开（§6.4，Esc 关闭即回到对话）。
 * 数据源与 Composer 的 @ 补全一致：索引缓存优先，409/501 回退 complete-path。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { api, ApiError } from "../lib/api";
import { filterAndRank } from "../lib/fuzzy";
import { useI18n } from "../i18n";
import { Overlay } from "./Overlay";

/** 文件查询：索引缓存优先，409/501 回退 complete-path（与 @ 补全同一降级路径） */
export async function queryWorkspaceFiles(sessionId: string, q: string, limit = 50): Promise<{ paths: string[]; indexStatus?: string }> {
  try {
    const response = await api.workspaceFiles(sessionId, q, limit);
    return { paths: response.files.map((file) => file.path), indexStatus: response.indexStatus };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 501)) {
      const fallback = await api.completePath(sessionId, q);
      return { paths: fallback.matches.map((match) => match.path), indexStatus: "unavailable" };
    }
    throw error;
  }
}

export function QuickOpen({ open, sessionId, onOpenFile, onOpenInEditor, onClose }: {
  open: boolean;
  sessionId?: string;
  onOpenFile(path: string): void;
  /** 0.5.0 Phase 1a：Ctrl/Cmd+Enter 在编辑器分栏打开；未提供时无此入口 */
  onOpenInEditor?(path: string): void;
  onClose(): void;
}): ReactElement | null {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<string[]>([]);
  const [indexStatus, setIndexStatus] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const requestSeq = useRef(0);

  // 打开时重置状态（聚焦由 Overlay 的 initialFocus 承担）
  useEffect(() => {
    if (open) {
      setQuery("");
      setItems([]);
      setIndexStatus(undefined);
      setFailed(false);
      setActive(0);
    }
  }, [open]);

  // 防抖 150ms 查询；乱序响应用序号丢弃
  useEffect(() => {
    if (!open || !sessionId) return;
    const seq = ++requestSeq.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await queryWorkspaceFiles(sessionId, query, 50);
          if (requestSeq.current !== seq) return;
          setItems(result.paths);
          setIndexStatus(result.indexStatus);
          setFailed(false);
        } catch {
          if (requestSeq.current !== seq) return;
          setFailed(true);
        }
      })();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, sessionId, query]);

  if (!open) return null;

  // 服务端已按 q 过滤；客户端再做一次模糊排序，保证相关性顺序稳定
  const ranked = filterAndRank(query, items, (path) => path);

  const pick = (path: string, inEditor = false): void => {
    onClose();
    if (inEditor && onOpenInEditor) onOpenInEditor(path);
    else onOpenFile(path);
  };

  return (
    <Overlay open={open} label={t("转到文件", "Go to File")} className="quick-open" initialFocus=".wb-overlay-input" onClose={onClose}>
      <input
        className="wb-overlay-input"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, ranked.length - 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
          else if (event.key === "Enter" && ranked[active]) { event.preventDefault(); pick(ranked[active], (event.ctrlKey || event.metaKey) && Boolean(onOpenInEditor)); }
        }}
        placeholder={t("按名称搜索文件", "Search files by name")}
        aria-label={t("文件搜索", "File search")}
        role="combobox"
        aria-expanded="true"
        aria-controls="quick-open-listbox"
        aria-activedescendant={ranked[active] ? `quick-open-option-${active}` : undefined}
      />
      {indexStatus === "unavailable" && (
        <p className="wb-overlay-hint">{t("索引不可用，使用实时文件搜索", "Index unavailable; using live file search")}</p>
      )}
      {onOpenInEditor && (
        <p className="wb-overlay-hint">{t("Enter 打开只读视图，Ctrl/Cmd+Enter 在编辑器中打开", "Enter opens the read-only view; Ctrl/Cmd+Enter opens in the editor")}</p>
      )}
      <ul className="wb-overlay-list" id="quick-open-listbox" role="listbox" aria-label={t("文件", "Files")}>
        {ranked.map((path, index) => (
          <li key={path}>
            <button
              id={`quick-open-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={`wb-overlay-item${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(path)}
            >
              <span className="wb-overlay-item-title">{path.split("/").pop()}</span>
              <span className="wb-overlay-item-path">{path}</span>
            </button>
          </li>
        ))}
        {ranked.length === 0 && (
          <li className="muted-empty wb-overlay-empty">
            {failed
              ? t("文件列表加载失败（继续输入重试，或按 Esc 关闭）", "Could not load files (keep typing to retry, or press Esc to close)")
              : t("无匹配文件", "No matching files")}
          </li>
        )}
      </ul>
    </Overlay>
  );
}
