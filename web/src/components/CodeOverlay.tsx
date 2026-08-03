/**
 * 只读代码视图浮层（0.4.0 Phase 5a §6.4）：Quick Open 选中文件的承载。
 * 代码视图永远是对话的辅助浮层，Esc/关闭即回到对话，不产生视图状态管理。
 */
import { useEffect, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useI18n } from "../i18n";
import { CodeView } from "./editor/CodeView";
import { Icon } from "./Icon";
import { langFromPath } from "../lib/file-langs";

export { langFromPath };

export function CodeOverlay({ sessionId, path, onEdit, onClose }: {
  sessionId: string;
  path: string;
  /** 0.5.0 Phase 1a：升级为可编辑编辑器分栏；未提供时不显示入口 */
  onEdit?(path: string): void;
  onClose(): void;
}): ReactElement {
  const { t } = useI18n();
  const content = useQuery({
    queryKey: ["file-content", sessionId, path],
    queryFn: () => api.readFile(sessionId, path),
    retry: false,
  });

  // Esc 关闭：浮层本身不抢输入框，监听全局 keydown
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="wb-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wb-overlay code-overlay" role="dialog" aria-modal="true" aria-label={path}>
        <header className="wb-overlay-header">
          <span className="code-overlay-path"><Icon name="file" size={13} /> {path}</span>
          {onEdit && (
            <button className="btn small" onClick={() => onEdit(path)} aria-label={t("在编辑器中打开", "Open in editor")}>
              {t("编辑", "Edit")}
            </button>
          )}
          <button className="icon-btn" aria-label={t("关闭（Esc）", "Close (Esc)")} onClick={onClose}>✕</button>
        </header>
        <div className="code-overlay-body">
          {content.isPending && <p className="wb-overlay-hint">{t("加载中…", "Loading…")}</p>}
          {content.isError && (
            <p className="wb-overlay-hint">{t(`无法读取文件：${content.error instanceof Error ? content.error.message : "未知错误"}`, `Could not read file: ${content.error instanceof Error ? content.error.message : "unknown error"}`)}</p>
          )}
          {content.data && (
            <>
              <CodeView code={content.data.content} lang={langFromPath(path)} />
              {content.data.truncated && <p className="wb-overlay-hint">{t("文件过大，仅显示截断内容", "File is too large; showing truncated content")}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
