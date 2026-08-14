import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type { EvalRunComparison, EvalRunReport } from "../lib/contracts";
import { formatDuration } from "../lib/format";
import { Icon } from "../components/Icon";
import { ui } from "../app/ui-store";

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadEvalReport(report: EvalRunReport): void {
  downloadJson(report, `${report.runId}.json`);
}

/** 评测面板（owc-eval 扩展启用时出现在底部面板）：任务集回放、报告、基线对比与归档。提示走 ui.notify。 */
export function EvalPanel(): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<EvalRunReport>();
  const [baselineRunId, setBaselineRunId] = useState<string>();
  const [comparison, setComparison] = useState<EvalRunComparison>();
  const [running, setRunning] = useState(false);
  const initializedTasks = useRef(false);

  const tasks = useQuery({ queryKey: ["eval", "tasks"], queryFn: api.evalTasks });
  const runs = useQuery({ queryKey: ["eval", "runs"], queryFn: api.evalRuns });
  const comparisons = useQuery({ queryKey: ["eval", "comparisons"], queryFn: api.evalComparisons });

  useEffect(() => {
    if (!initializedTasks.current && tasks.data?.tasks.length) {
      initializedTasks.current = true;
      setSelected(new Set(tasks.data.tasks.map((task) => task.id)));
    }
  }, [tasks.data]);

  const run = async (): Promise<void> => {
    if (selected.size === 0 || running) return;
    setRunning(true);
    try {
      const next = await api.evalRun([...selected]);
      setReport(next);
      if (baselineRunId && baselineRunId !== next.runId) {
        setComparison(await api.evalCompare(baselineRunId, next.runId));
        await queryClient.invalidateQueries({ queryKey: ["eval", "comparisons"] });
      } else setComparison(undefined);
      await queryClient.invalidateQueries({ queryKey: ["eval", "runs"] });
      ui.notify(t("评测运行完成。", "Evaluation run completed."));
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setRunning(false);
    }
  };

  const compareCurrent = async (): Promise<void> => {
    if (!baselineRunId || !report || baselineRunId === report.runId) return;
    try {
      setComparison(await api.evalCompare(baselineRunId, report.runId));
      await queryClient.invalidateQueries({ queryKey: ["eval", "comparisons"] });
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const openRun = async (runId: string): Promise<void> => {
    try {
      setReport(await api.evalRunReport(runId));
      setComparison(undefined);
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const openComparison = async (comparisonId: string): Promise<void> => {
    try {
      const archived = await api.evalComparison(comparisonId);
      setComparison(archived);
      setReport(archived.candidate);
      setBaselineRunId(archived.baselineRunId);
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <div className="inspector-body eval-panel">
      <div className="panel-head">
        <div>
          <h2>{t("评测", "Evaluation")}</h2>
          <p className="muted-empty panel-empty">{t("在隔离工作区中用固定 mock provider 回放任务。", "Replay tasks with fixed mock providers in isolated workspaces.")}</p>
        </div>
        <button className="btn primary" disabled={running || selected.size === 0} onClick={() => void run()}>
          {running ? t("运行中…", "Running…") : t("运行所选任务", "Run selected")}
        </button>
      </div>

      <section className="eval-section" aria-label={t("任务集", "Task set")}>
        <h3>{t("任务集", "Task set")}</h3>
        {tasks.isPending ? <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p> : tasks.isError ? (
          <p className="panel-error" role="alert">{t("无法加载评测任务。", "Unable to load evaluation tasks.")}</p>
        ) : (
          <div className="eval-task-list">
            {tasks.data?.tasks.map((task) => (
              <label key={task.id} className="eval-task-row">
                <input
                  type="checkbox"
                  checked={selected.has(task.id)}
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(task.id); else next.delete(task.id);
                    return next;
                  })}
                />
                <span><strong>{task.name}</strong><small>{task.description}</small></span>
              </label>
            ))}
          </div>
        )}
      </section>

      {report && (
        <section className="eval-section" aria-label={t("评测报告", "Evaluation report")}>
          <div className="eval-section-head">
            <h3>{t("报告", "Report")}</h3>
            <div className="eval-actions">
              <select aria-label={t("对比基线", "Comparison baseline")} value={baselineRunId ?? ""} onChange={(event) => { setBaselineRunId(event.target.value || undefined); setComparison(undefined); }}>
                <option value="">{t("选择基线…", "Select baseline…")}</option>
                {runs.data?.runs.filter((item) => item.runId !== report.runId).map((item) => <option key={item.runId} value={item.runId}>{new Date(item.startedAt).toLocaleString(locale)} · {item.summary.passed}/{item.summary.total}</option>)}
              </select>
              <button disabled={!baselineRunId || baselineRunId === report.runId} onClick={() => void compareCurrent()}>{t("对比", "Compare")}</button>
              <button onClick={() => downloadEvalReport(report)}>{t("导出 JSON", "Export JSON")}</button>
            </div>
          </div>
          <div className="eval-summary">
            <strong>{report.summary.passed}/{report.summary.total}</strong>
            <span>{t("通过", "passed")}</span>
            <span>{formatDuration(report.summary.durationMs)}</span>
            <span>{report.summary.usage.totalTokens.toLocaleString(locale)} tokens</span>
          </div>
          <div className="eval-results">
            {report.taskResults.map((result) => (
              <details key={result.taskId} className={`eval-result ${result.status}`}>
                <summary>
                  <span>{result.taskName}</span>
                  <span>{result.status.toUpperCase()} · {formatDuration(result.durationMs)} · {result.usage.totalTokens} tokens</span>
                </summary>
                <p>{t("工具", "Tools")}: {result.toolsUsed.join(", ") || "—"} · {result.turns} turns</p>
                <ul>{result.assertions.map((assertion) => <li key={assertion.name}><span className={`eval-assertion-icon ${assertion.passed ? "pass" : "fail"}`}><Icon name={assertion.passed ? "check" : "x"} size={12} /></span>{assertion.name}: {assertion.detail}</li>)}</ul>
                {result.error && <p className="eval-error">{result.error}</p>}
              </details>
            ))}
          </div>
        </section>
      )}

      {comparison && (
        <section className="eval-section eval-comparison" aria-label={t("回归对比", "Regression comparison")}>
          <div className="eval-section-head">
            <h3>{t("回归对比", "Regression comparison")}</h3>
            <button onClick={() => downloadJson(comparison, `${comparison.comparisonId}.json`)}>{t("导出对比 JSON", "Export comparison JSON")}</button>
          </div>
          <div className="eval-summary">
            <strong className={comparison.summary.regressions > 0 ? "danger" : ""}>{comparison.summary.regressions}</strong>
            <span>{t("项回归", "regressions")}</span>
            <span>{comparison.summary.improvements} {t("项改善", "improvements")}</span>
            <span>Δ {comparison.summary.totalTokensDelta >= 0 ? "+" : ""}{comparison.summary.totalTokensDelta} tokens</span>
            <span>Δ {formatDuration(Math.abs(comparison.summary.durationMsDelta))} {comparison.summary.durationMsDelta >= 0 ? "↑" : "↓"}</span>
          </div>
          <div className="eval-results">
            {comparison.tasks.map((task) => (
              <div key={task.taskId} className={`eval-result ${task.regressed ? "error" : task.improved ? "pass" : ""}`}>
                <strong>{task.taskName}</strong>
                <span>{task.baselineStatus ?? "—"} → {task.candidateStatus ?? "—"}{task.regressed ? ` · ${t("回归", "Regression")}` : task.improved ? ` · ${t("改善", "Improved")}` : ""}</span>
                <small>Δ {task.totalTokensDelta >= 0 ? "+" : ""}{task.totalTokensDelta} tokens · tools: {task.baselineToolCalls.join(" → ") || "—"} ⇒ {task.candidateToolCalls.join(" → ") || "—"}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="eval-section" aria-label={t("历史报告", "Report history")}>
        <h3>{t("历史报告", "Report history")}</h3>
        {runs.data?.runs.length ? (
          <div className="eval-history">
            {runs.data.runs.map((item) => (
              <div className="eval-history-row" key={item.runId}>
                <button onClick={() => void openRun(item.runId)}>
                  <span>{new Date(item.startedAt).toLocaleString(locale)}</span>
                  <span>{item.summary.passed}/{item.summary.total} · {formatDuration(item.summary.durationMs)}</span>
                </button>
                <button className="eval-baseline" aria-pressed={baselineRunId === item.runId} onClick={() => { setBaselineRunId(item.runId); setComparison(undefined); }}>{t("设为基线", "Set baseline")}</button>
              </div>
            ))}
          </div>
        ) : <p className="muted-empty panel-empty">{t("暂无历史报告。", "No saved reports.")}</p>}
      </section>
      {comparisons.data?.comparisons.length ? (
        <section className="eval-section" aria-label={t("对比归档", "Comparison archive")}>
          <h3>{t("对比归档", "Comparison archive")}</h3>
          <div className="eval-history">
            {comparisons.data.comparisons.map((item) => (
              <button key={item.comparisonId} onClick={() => void openComparison(item.comparisonId)}>
                <span>{new Date(item.createdAt).toLocaleString(locale)}</span>
                <span>{item.summary.regressions} {t("项回归", "regressions")} · {item.summary.improvements} {t("项改善", "improvements")}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
