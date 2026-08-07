/**
 * 侧栏问题视图：最近一次诊断的失败项列表（按文件分组、severity 过滤），
 * 点击条目直接在编辑器分栏打开对应文件行列（auxViews.openEditor）。
 * 无诊断记录时服务端返回 404，按空态处理（不打断用户）。
 */
import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { DiagnosticFailure } from "../../lib/contracts";
import { countBySeverity, filterGroupsBySeverity, groupFailuresByFile, severityOf, type SeverityFilter } from "../../lib/diagnostics";
import { formatDuration } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import { auxViews } from "../aux-views";

const SEVERITY_TABS: SeverityFilter[] = ["all", "error", "warning"];

export function ProblemsView({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const [filter, setFilter] = useState<SeverityFilter>("all");

  const diagnostics = useQuery({
    queryKey: ["diagnostics", sessionId],
    queryFn: () => api.latestDiagnostics(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });

  if (!sessionId) {
    return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以查看诊断问题。", "Select a session to view problems.")}</p></div>;
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
    auxViews.openEditor(failure.file, {
      ...(failure.line !== undefined ? { line: failure.line } : {}),
      ...(failure.column !== undefined ? { column: failure.column } : {}),
    });
  };

  return (
    <div className="inspector-body problems-panel">
      {set && (
        <div className="panel-head">
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
        </div>
      )}
      {diagnostics.isPending ? (
        <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>
      ) : diagnostics.isError && !notFound ? (
        <p className="panel-error" role="alert">
          {t("无法读取诊断结果", "Could not load diagnostics")}
          {diagnostics.error instanceof ApiError ? `：${diagnostics.error.message}` : ""}
        </p>
      ) : !set || set.failures.length === 0 ? (
        <p className="muted-empty panel-empty">{t("暂无问题。最近一轮诊断未发现失败项。", "No problems. The latest diagnostics run reported no failures.")}</p>
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
            <p className="muted-empty panel-empty">{t("当前过滤条件下没有问题。", "No problems match the current filter.")}</p>
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
                          title={clickable ? t("点击在编辑器中打开", "Click to open in the editor") : t("该失败项未定位到文件", "This failure has no file location")}
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
  );
}
