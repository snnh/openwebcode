import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { RunPerfRecord } from "../lib/contracts";
import { getFpsStats, startFrameSampler, stopFrameSampler, type FpsStats } from "../lib/perf-sampler";
import { formatBytes, formatDuration } from "../lib/format";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

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

/** 性能面板：渲染帧率（perf-sampler）+ 事件吞吐 + Turn 阶段耗时 + Provider 并发；监控开关持久化 localStorage。 */
export function PerfPanel({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const [fps, setFps] = useState<FpsStats>({ fps50: 0, fps95: 0, droppedFrames: 0, sampleCount: 0 });
  const [monitoring, setMonitoring] = useState(readMonitoringPreference);
  const fpsTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  // 面板打开且监控开关启用时采样；关闭面板或开关时立即停止。
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

  const records = perf.data?.records ?? [];

  return (
    <div className="inspector-body perf-panel">
      <div className="panel-head perf-panel-head">
        <h2>{t("性能", "Performance")}</h2>
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

      {!monitoring && <p className="perf-paused">{t("实时采样与数据刷新已暂停。", "Live sampling and data refresh are paused.")}</p>}

      {/* 渲染帧率 */}
      <section className="perf-section">
        <h3>{t("渲染帧率", "Frame Rate")}</h3>
        <div className="perf-grid">
          <span className="perf-label">FPS p50</span>
          <span className={`perf-value${fps.fps50 > 0 && fps.fps50 < 50 ? " warn" : ""}`}>{fps.fps50 || "—"}</span>
          <span className="perf-label">FPS p95</span>
          <span className="perf-value">{fps.fps95 || "—"}</span>
          <span className="perf-label">{t("掉帧", "Dropped")}</span>
          <span className={`perf-value${fps.droppedFrames > 10 ? " warn" : ""}`}>{fps.droppedFrames}</span>
          <span className="perf-label">{t("采样帧", "Samples")}</span>
          <span className="perf-value">{fps.sampleCount}</span>
        </div>
      </section>

      {/* 事件吞吐 */}
      <section className="perf-section">
        <h3>{t("事件吞吐", "Event Throughput")}</h3>
        {metrics.data ? (
          <div className="perf-grid">
            <span className="perf-label">{t("已发布", "Published")}</span>
            <span className="perf-value">{metrics.data.events.published}</span>
            <span className="perf-label">{t("保留", "Retained")}</span>
            <span className="perf-value">{metrics.data.events.retained}</span>
            <span className="perf-label">{t("保留体积", "Retained Size")}</span>
            <span className="perf-value">{formatBytes(metrics.data.events.retainedBytes)}</span>
            <span className="perf-label">WS {t("客户端", "Clients")}</span>
            <span className="perf-value">{metrics.data.websocket.clients}</span>
          </div>
        ) : (
          <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>
        )}
      </section>

      {/* Turn 阶段耗时 */}
      <section className="perf-section">
        <h3>{t("Turn 阶段耗时", "Turn Stage Latency")}</h3>
        {!sessionId ? (
          <p className="muted-empty panel-empty">{t("选择会话以查看性能数据。", "Select a session to view performance data.")}</p>
        ) : records.length === 0 ? (
          <p className="muted-empty panel-empty">{t("暂无性能记录。运行一次对话后数据将显示在此处。", "No performance records yet. Run a conversation to see data here.")}</p>
        ) : (
          <div className="perf-records">
            <div className="perf-legend">
              <span className="perf-legend-item ctx"><Icon name="square" size={10} /> ctx</span>
              <span className="perf-legend-item llm"><Icon name="square" size={10} /> llm</span>
              <span className="perf-legend-item tool"><Icon name="square" size={10} /> tool</span>
            </div>
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
        )}
      </section>

      {/* Provider 并发诊断 */}
      {concurrency.data && Object.keys(concurrency.data).length > 0 && (
        <section className="perf-section">
          <h3>{t("Provider 并发", "Provider Concurrency")}</h3>
          <div className="perf-grid">
            {Object.entries(concurrency.data).map(([name, stats]) => (
              <span key={name} className="perf-value perf-provider-stat">
                {name}: {stats.active}/{stats.maxConcurrent} {t("活跃", "active")}
                {stats.queued > 0 ? ` · ${stats.queued} ${t("排队", "queued")}` : ""}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
