import { useEffect, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { DiagnosticFailure } from "../../lib/contracts";
import { countBySeverity, filterGroupsBySeverity, groupFailuresByFile, severityOf, type SeverityFilter } from "../../lib/diagnostics";
import { CodeView } from "../editor/CodeView";
import { Icon } from "../Icon";
import { useI18n } from "../../i18n";

// 与 FilesPanel 一致的扩展名 → shiki 语言映射（仅用于代码视图高亮，不支持时回退纯文本）
const EXT_LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", html: "html", htm: "html", md: "markdown", markdown: "markdown",
  py: "python", sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", diff: "diff", patch: "diff",
};

const SEVERITY_TABS: SeverityFilter[] = ["all", "error", "warning"];

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function ProblemsPanel({ sessionId }: {
  sessionId?: string;
}): ReactElement {
  const { t } = useI18n();
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const [selected, setSelected] = useState<{ file: string; line?: number; column?: number }>();
  useEffect(() => {
    setSelected(undefined);
    setFilter("all");
  }, [sessionId]);

  // 无诊断记录时服务端返回 404，按空态处理（不打断用户）
  const diagnostics = useQuery({
    queryKey: ["diagnostics", sessionId],
    queryFn: () => api.latestDiagnostics(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const preview = useQuery({
    queryKey: ["file", sessionId, selected?.file],
    queryFn: () => api.readFile(sessionId!, selected!.file),
    enabled: Boolean(sessionId && selected),
  });

  if (!sessionId) {
    return <div className="inspector-body"><p className="panel-empty">{t("选择会话以查看诊断问题。", "Select a session to view problems.")}</p></div>;
  }

  const notFound = diagnostics.error instanceof ApiError && diagnostics.error.status === 404;
  const set = notFound ? undefined : diagnostics.data;
  const groups = filterGroupsBySeverity(groupFailuresByFile(set?.failures ?? []), filter);
  const counts = countBySeverity(set);
  const filterLabel = (value: SeverityFilter): string => {
    if (value === "all") return t(`全部 ${counts.error + counts.warning}`, `All ${counts.error + counts.warning}`);
    if (value === "error") return t(`错误 ${counts.error}`, `Errors ${counts.error}`);
    return t(`警告 ${counts.warning}`, `Warnings ${counts.warning}`);
  };

  const openFailure = (failure: DiagnosticFailure): void => {
    if (!failure.file) return;
    setSelected({ file: failure.file, ...(failure.line ? { line: failure.line } : {}), ...(failure.column ? { column: failure.column } : {}) });
  };

  const ext = selected?.file.split(".").pop()?.toLowerCase() ?? "";

  return (
    <div className="files-panel-wrap">
      <div className="inspector-body problems-panel">
        <div className="panel-head">
          <h2>{t("问题", "Problems")}</h2>
          {set && (
            <div className="problems-filters" role="group" aria-label={t("按严重度过滤", "Filter by severity")}>
              {SEVERITY_TABS.map((value) => (
                <button
                  key={value}
                  className={`btn small${filter === value ? " primary" : ""}`}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {filterLabel(value)}
                </button>
              ))}
            </div>
          )}
        </div>
        {diagnostics.isPending ? (
          <p className="panel-empty">{t("加载中…", "Loading…")}</p>
        ) : diagnostics.isError && !notFound ? (
          <p className="panel-empty">
            {t("无法读取诊断结果", "Could not load diagnostics")}
            {diagnostics.error instanceof ApiError ? `：${diagnostics.error.message}` : ""}
          </p>
        ) : !set || set.failures.length === 0 ? (
          <p className="panel-empty">{t("暂无问题。最近一轮诊断未发现失败项。", "No problems. The latest diagnostics run reported no failures.")}</p>
        ) : (
          <>
            <p className="problems-summary">
              {t("来源工具：", "Tool: ")}<code>{set.tool}</code>
              {" · "}
              {t(
                `通过 ${set.summary.passed} · 失败 ${set.summary.failed} · 跳过 ${set.summary.skipped} · 耗时 ${formatDuration(set.summary.durationMs)}`,
                `Passed ${set.summary.passed} · Failed ${set.summary.failed} · Skipped ${set.summary.skipped} · ${formatDuration(set.summary.durationMs)}`,
              )}
            </p>
            {groups.length === 0 ? (
              <p className="panel-empty">{t("当前过滤条件下没有问题。", "No problems match the current filter.")}</p>
            ) : (
              groups.map((group) => (
                <section key={group.file || "(unknown)"} className="problems-group">
                  <h3 className="problems-file" title={group.file || undefined}>
                    <Icon name="file" size={12} />
                    {group.file || t("（未定位到文件）", "(No file location)")}
                    <small>{group.items.length}</small>
                  </h3>
                  <ul className="problems-list">
                    {group.items.map((failure, index) => {
                      const severity = severityOf(failure);
                      const clickable = Boolean(failure.file);
                      return (
                        <li key={`${failure.name}-${index}`}>
                          <button
                            className={`problems-item ${severity}`}
                            disabled={!clickable}
                            title={clickable ? t("点击在只读代码视图中打开", "Click to open in the read-only code view") : t("该失败项未定位到文件", "This failure has no file location")}
                            onClick={() => openFailure(failure)}
                          >
                            <Icon name="alert" size={13} />
                            <span className="problems-name">{failure.name}</span>
                            {failure.line !== undefined && (
                              <span className="problems-loc">:{failure.line}{failure.column !== undefined ? `:${failure.column}` : ""}</span>
                            )}
                            <span className="problems-message">{failure.message}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </>
        )}
      </div>
      {selected && (
        <section className="file-preview" aria-label={t(`查看 ${selected.file}`, `View ${selected.file}`)}>
          <header>
            <span className="mono" title={selected.file}>
              {selected.file}{selected.line !== undefined ? `:${selected.line}${selected.column !== undefined ? `:${selected.column}` : ""}` : ""}
            </span>
            <button className="icon-btn" onClick={() => setSelected(undefined)} aria-label={t("关闭代码视图", "Close code view")}><Icon name="x" size={14} /></button>
          </header>
          {preview.isError ? (
            <p className="preview-note">
              {preview.error instanceof ApiError ? preview.error.message : t("无法读取该文件。", "Could not read this file.")}
            </p>
          ) : preview.data ? (
            <>
              <CodeView
                code={preview.data.content}
                lang={EXT_LANGS[ext]}
                {...(selected.line !== undefined ? { targetLine: selected.line } : {})}
                {...(selected.column !== undefined ? { targetColumn: selected.column } : {})}
              />
              {preview.data.truncated && <p className="preview-note">{t("内容过长，已截断。", "Content was truncated because it is too long.")}</p>}
            </>
          ) : (
            <p className="preview-note">{t("加载中…", "Loading…")}</p>
          )}
        </section>
      )}
    </div>
  );
}
