import { useEffect, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { RunPerfRecord, SettingsView } from "../lib/contracts";
import { getFpsStats, startFrameSampler, stopFrameSampler, type FpsStats } from "../lib/perf-sampler";
import { formatBytes, formatDuration } from "../lib/format";
import { memoryBreakdown } from "./perf-memory";
import { useI18n } from "../i18n";
import { readRuntimeMode, type WebRuntimeMode } from "../lib/runtime-mode";

const MONITORING_STORAGE_KEY = "owc-perf-monitoring";

function readMonitoringPreference(): boolean {
  try {
    return window.localStorage.getItem(MONITORING_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function storeMonitoringPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(MONITORING_STORAGE_KEY, String(enabled));
  } catch {
    // 持久化失败不影响当前面板使用
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

/** 阶段耗时条形图（相对比例） */
function StageBar({ record }: { record: RunPerfRecord }): ReactElement {
  const { stages } = record;
  const total = Math.max(1, stages.totalMs);
  const segments = [
    { label: "ctx", ms: stages.contextBuildMs, color: "var(--accent)" },
    { label: "llm", ms: stages.providerCallMs, color: "var(--ok)" },
    { label: "tool", ms: stages.toolExecMs, color: "var(--amber)" },
  ];
  return (
    <div className="perf-stage-bar" title={`total: ${formatDuration(stages.totalMs)}`}>
      {segments.map((seg) => (
        <div
          key={seg.label}
          className="perf-seg"
          style={{ width: `${Math.max(1, (seg.ms / total) * 100)}%`, background: seg.color }}
          title={`${seg.label}: ${formatDuration(seg.ms)}`}
        />
      ))}
    </div>
  );
}

function browserHeap(): { used: number; total: number; limit: number } | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null;
}

function ModeSwitch({ mode, onChange, t }: { mode: WebRuntimeMode; onChange: (mode: WebRuntimeMode) => void; t: (zh: string, en: string) => string }): ReactElement {
  const options: Array<{ value: WebRuntimeMode; zh: string; en: string }> = [
    { value: "performance", zh: "性能", en: "Speed" },
    { value: "balanced", zh: "平衡", en: "Balanced" },
    { value: "memory", zh: "省内存", en: "Memory" },
  ];
  return (
    <div className="perf-mode-switch" role="radiogroup" aria-label={t("运行模式", "Runtime mode")}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={mode === option.value}
          className={mode === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {t(option.zh, option.en)}
        </button>
      ))}
    </div>
  );
}

/** 性能面板：模式、KPI、执行队列、内存、渲染/加载与多轮耗时汇总。 */
export function PerfPanel({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [fps, setFps] = useState<FpsStats>({ fps50: 0, fps95: 0, droppedFrames: 0, sampleCount: 0 });
  const [monitoring, setMonitoring] = useState(readMonitoringPreference);
  const [heap, setHeap] = useState<{ used: number; total: number; limit: number } | null>(null);
  const [domNodes, setDomNodes] = useState(0);
  const fpsTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    storeMonitoringPreference(monitoring);
    if (!monitoring) {
      stopFrameSampler();
      if (fpsTimer.current) clearInterval(fpsTimer.current);
      fpsTimer.current = undefined;
      return;
    }
    startFrameSampler();
    setFps(getFpsStats());
    fpsTimer.current = setInterval(() => setFps(getFpsStats()), 1000);
    return () => {
      stopFrameSampler();
      if (fpsTimer.current) clearInterval(fpsTimer.current);
      fpsTimer.current = undefined;
    };
  }, [monitoring]);

  useEffect(() => {
    if (!monitoring) return undefined;
    const update = () => {
      setHeap(browserHeap());
      setDomNodes(typeof document === "undefined" ? 0 : document.querySelectorAll("*").length);
    };
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, [monitoring]);

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const mode = readRuntimeMode(settings.data as SettingsView | undefined);
  const modeMutation = useMutation({
    mutationFn: (next: WebRuntimeMode) => api.saveSettings({ runtimeMode: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["serverMetrics"] });
    },
  });

  const perf = useQuery({
    queryKey: ["perf", sessionId],
    queryFn: () => api.sessionPerf(sessionId!),
    enabled: monitoring && Boolean(sessionId),
    refetchInterval: monitoring ? 5000 : false,
  });

  const metrics = useQuery({
    queryKey: ["serverMetrics"],
    queryFn: () => api.serverMetrics(),
    enabled: monitoring,
    refetchInterval: monitoring ? 5000 : false,
  });

  const concurrency = useQuery({
    queryKey: ["providerStats"],
    queryFn: () => api.providerStats(),
    enabled: monitoring,
    refetchInterval: monitoring ? 5000 : false,
  });

  const cancelExec = useMutation({
    mutationFn: ({ sessionId: target, execId }: { sessionId: string; execId: string }) => api.cancelExec(target, execId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["serverMetrics"] }); },
  });

  const records = perf.data?.records ?? [];
  const memory = metrics.data ? memoryBreakdown(metrics.data.memory) : null;
  const budget = metrics.data?.memoryBudget;
  const exec = metrics.data?.exec;
  const turnP95 = percentile(records.map((record) => record.stages.totalMs), 95);
  const ctxP95 = percentile(records.map((record) => record.stages.contextBuildMs), 95);
  const llmP95 = percentile(records.map((record) => record.stages.providerCallMs), 95);
  const toolP95 = percentile(records.map((record) => record.stages.toolExecMs), 95);

  return (
    <div className="inspector-body perf-panel">
      <div className="panel-head perf-panel-head">
        <h2>{t("性能", "Performance")}</h2>
        <div className="perf-head-actions">
          <ModeSwitch mode={mode} onChange={(next) => modeMutation.mutate(next)} t={t} />
          <button
            type="button"
            className="perf-monitor-toggle"
            role="switch"
            aria-checked={monitoring}
            aria-label={t("实时性能监控", "Live performance monitoring")}
            onClick={() => setMonitoring((enabled) => !enabled)}
          >
            <span>{monitoring ? t("监控中", "Monitoring") : t("已暂停", "Paused")}</span>
            <span className="perf-toggle-track" aria-hidden="true"><span /></span>
          </button>
        </div>
      </div>

      {!monitoring && <p className="perf-paused">{t("实时采样与数据刷新已暂停。", "Live sampling and data refresh are paused.")}</p>}

      <section className="perf-kpis">
        <div className="perf-kpi">
          <span>{t("总内存", "Total memory")}</span>
          <strong>{memory ? formatBytes(memory.total) : "—"}</strong>
          <small>{budget?.budgetMB ? `${t("上限", "Limit")} ${budget.budgetMB} MB` : t("无进阶上限", "No budget")}</small>
        </div>
        <div className="perf-kpi">
          <span>{t("执行队列", "Exec queue")}</span>
          <strong>{exec ? `${exec.running}/${exec.maxConcurrent}` : "—"}</strong>
          <small>{exec && exec.queued > 0 ? t(`${exec.queued} 个排队`, `${exec.queued} queued`) : t("无排队", "No queue")}</small>
        </div>
        <div className="perf-kpi">
          <span>{t("Turn p95", "Turn p95")}</span>
          <strong>{records.length > 0 ? formatDuration(turnP95) : "—"}</strong>
          <small>{records.length > 0 ? t(`ctx ${formatDuration(ctxP95)}`, `ctx ${formatDuration(ctxP95)}`) : t("暂无记录", "No records")}</small>
        </div>
        <div className="perf-kpi">
          <span>FPS p50</span>
          <strong className={fps.fps50 > 0 && fps.fps50 < 50 ? "warn" : ""}>{fps.fps50 || "—"}</strong>
          <small>{t(`掉帧 ${fps.droppedFrames}`, `${fps.droppedFrames} dropped`)}</small>
        </div>
      </section>

      <details className="perf-details" open={Boolean(exec && (exec.running > 0 || exec.queued > 0))}>
        <summary>{t("执行队列", "Exec queue")} {exec && exec.queued > 0 ? <span className="perf-badge">{exec.queued}</span> : null}</summary>
        {!exec || exec.items.length === 0 ? (
          <p className="muted-empty panel-empty">{t("当前没有长命令在执行或排队。", "No long command is running or queued.")}</p>
        ) : (
          <div className="perf-queue">
            {exec.items.map((item) => (
              <div key={`${item.sessionId}:${item.execId}`} className="perf-queue-row">
                <span className={`perf-badge ${item.state === "running" ? "running" : "queued"}`}>{item.state === "running" ? t("运行", "Run") : t("排队", "Queue")}</span>
                <span className="perf-queue-session">{item.sessionId.slice(0, 8)}</span>
                <span className="perf-queue-wait">{formatDuration(item.waitMs)}</span>
                <button type="button" className="perf-cancel" onClick={() => cancelExec.mutate({ sessionId: item.sessionId, execId: item.execId })}>
                  {t("取消", "Cancel")}
                </button>
              </div>
            ))}
          </div>
        )}
      </details>

      <details className="perf-details" open>
        <summary>{t("内存", "Memory")} {budget?.compressed ? <span className="perf-badge warn">{t("回收中", "Compacting")}</span> : null}</summary>
        {memory ? (
          <>
            <div className="perf-total">
              <span className="perf-label">{t("总占用", "Total")}</span>
              <span className="perf-value">{formatBytes(memory.total)}</span>
              {budget?.totalMB ? <span className="perf-record-meta">{t(`预算口径 ${budget.totalMB} MB`, `Budget gauge ${budget.totalMB} MB`)}</span> : null}
            </div>
            <div className="perf-grid">
              <span className="perf-label">{t("server 主线程", "Server main")}</span>
              <span className="perf-value">{formatBytes(memory.serverRss)}</span>
              <span className="perf-label">C core</span>
              <span className="perf-value">{memory.coreRss === null ? "—" : formatBytes(memory.coreRss)}</span>
              <span className="perf-label">{t("扩展宿主", "Extension host")}</span>
              <span className="perf-value">{memory.extensionRss === null ? "—" : formatBytes(memory.extensionRss)}</span>
              <span className="perf-label">{t("浏览器堆", "Browser heap")}</span>
              <span className="perf-value">{heap ? `${formatBytes(heap.used)} / ${formatBytes(heap.limit)}` : "—"}</span>
              <span className="perf-label">DOM</span>
              <span className="perf-value">{domNodes || "—"}</span>
            </div>
            <span className="perf-record-meta">
              {t(
                `主线程 heap ${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)} · external ${formatBytes(memory.external)} · 总占用 = server + core + 扩展宿主`,
                `Main heap ${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)} · external ${formatBytes(memory.external)} · total = server + core + extension host`,
              )}
            </span>
            {budget?.enabled ? (
              <span className="perf-record-meta">
                {t(
                  `进阶上限 ${budget.budgetMB ?? "—"} MB · 当前 ${budget.totalMB ?? "—"} MB · 级别 ${budget.level}`,
                  `Budget ${budget.budgetMB ?? "—"} MB · current ${budget.totalMB ?? "—"} MB · level ${budget.level}`,
                )}
              </span>
            ) : null}
          </>
        ) : (
          <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>
        )}
      </details>

      <details className="perf-details" open={records.length > 0}>
        <summary>{t("多轮耗时", "Turn latency")} <span className="perf-record-meta">{t(`最近 ${records.length} 轮`, `last ${records.length} runs`)}</span></summary>
        {!sessionId ? (
          <p className="muted-empty panel-empty">{t("选择会话以查看性能数据。", "Select a session to view performance data.")}</p>
        ) : records.length === 0 ? (
          <p className="muted-empty panel-empty">{t("暂无性能记录。运行一次对话后数据将显示在此处。", "No performance records yet. Run a conversation to see data here.")}</p>
        ) : (
          <>
            <div className="perf-grid">
              <span className="perf-label">ctx p95</span><span className="perf-value">{formatDuration(ctxP95)}</span>
              <span className="perf-label">llm p95</span><span className="perf-value">{formatDuration(llmP95)}</span>
              <span className="perf-label">tool p95</span><span className="perf-value">{formatDuration(toolP95)}</span>
              <span className="perf-label">total p95</span><span className="perf-value">{formatDuration(turnP95)}</span>
            </div>
            <details className="perf-subdetails">
              <summary>{t("展开单轮明细", "Show per-run details")}</summary>
              <div className="perf-records">
                {records.slice().reverse().map((record) => (
                  <div key={record.runId} className="perf-record-row">
                    <span className="perf-record-meta">
                      {record.turnCount} turn{record.turnCount > 1 ? "s" : ""} · {formatDuration(record.stages.totalMs)}
                    </span>
                    <StageBar record={record} />
                    <span className="perf-record-detail">
                      ctx {formatDuration(record.stages.contextBuildMs)} · llm {formatDuration(record.stages.providerCallMs)} · tool {formatDuration(record.stages.toolExecMs)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </details>

      <details className="perf-details">
        <summary>{t("渲染与诊断", "Rendering & diagnostics")}</summary>
        <div className="perf-grid">
          <span className="perf-label">FPS p50 / p95</span>
          <span className="perf-value">{fps.fps50 || "—"} / {fps.fps95 || "—"}</span>
          <span className="perf-label">{t("采样帧", "Samples")}</span>
          <span className="perf-value">{fps.sampleCount}</span>
          <span className="perf-label">{t("事件已发布", "Events published")}</span>
          <span className="perf-value">{metrics.data?.events.published ?? "—"}</span>
          <span className="perf-label">{t("事件保留", "Events retained")}</span>
          <span className="perf-value">{metrics.data ? `${metrics.data.events.retained} · ${formatBytes(metrics.data.events.retainedBytes)}` : "—"}</span>
          <span className="perf-label">WS {t("客户端", "clients")}</span>
          <span className="perf-value">{metrics.data?.websocket.clients ?? "—"}</span>
        </div>
        {concurrency.data && Object.keys(concurrency.data).length > 0 && (
          <div className="perf-grid">
            {Object.entries(concurrency.data).map(([name, stats]) => (
              <span key={name} className="perf-value perf-provider-stat">
                {name}: {stats.active}/{stats.maxConcurrent} {t("活跃", "active")}
                {stats.queued > 0 ? ` · ${stats.queued} ${t("排队", "queued")}` : ""}
              </span>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
