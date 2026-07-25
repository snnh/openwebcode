import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { RunPerfRecord } from "../../lib/contracts";
import { getFpsStats, startFrameSampler, stopFrameSampler, type FpsStats } from "../../lib/perf-sampler";
import { useI18n } from "../../i18n";

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** 阶段耗时条形图（相对比例） */
function StageBar({ record }: { record: RunPerfRecord }): ReactElement {
  const { stages } = record;
  const total = Math.max(1, stages.totalMs);
  const segments = [
    { label: "ctx", ms: stages.contextBuildMs, color: "var(--accent, #4fc3f7)" },
    { label: "llm", ms: stages.providerCallMs, color: "var(--success, #81c784)" },
    { label: "tool", ms: stages.toolExecMs, color: "var(--warning, #ffb74d)" },
  ];
  return (
    <div className="perf-stage-bar" title={`total: ${formatMs(stages.totalMs)}`}>
      {segments.map((seg) => (
        <div
          key={seg.label}
          className="perf-seg"
          style={{ width: `${Math.max(1, (seg.ms / total) * 100)}%`, background: seg.color }}
          title={`${seg.label}: ${formatMs(seg.ms)}`}
        />
      ))}
    </div>
  );
}

export function PerfPanel({ sessionId }: { sessionId?: string }): ReactElement {
  const { t } = useI18n();
  const [fps, setFps] = useState<FpsStats>({ fps50: 0, fps95: 0, droppedFrames: 0, sampleCount: 0 });
  const fpsTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  // 面板打开时启动帧率采样，关闭时停止
  useEffect(() => {
    startFrameSampler();
    setFps(getFpsStats());
    fpsTimer.current = setInterval(() => setFps(getFpsStats()), 1000);
    return () => {
      stopFrameSampler();
      if (fpsTimer.current) clearInterval(fpsTimer.current);
    };
  }, []);

  const perf = useQuery({
    queryKey: ["perf", sessionId],
    queryFn: () => api.sessionPerf(sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: 5000,
  });

  const metrics = useQuery({
    queryKey: ["serverMetrics"],
    queryFn: () => api.serverMetrics(),
    refetchInterval: 5000,
  });

  const concurrency = useQuery({
    queryKey: ["providerStats"],
    queryFn: () => api.providerStats(),
    refetchInterval: 5000,
  });

  const records = perf.data?.records ?? [];

  return (
    <div className="inspector-body perf-panel">
      <div className="panel-head"><h2>{t("性能", "Performance")}</h2></div>

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
          <p className="panel-empty">{t("加载中…", "Loading…")}</p>
        )}
      </section>

      {/* Turn 阶段耗时 */}
      <section className="perf-section">
        <h3>{t("Turn 阶段耗时", "Turn Stage Latency")}</h3>
        {!sessionId ? (
          <p className="panel-empty">{t("选择会话以查看性能数据。", "Select a session to view performance data.")}</p>
        ) : records.length === 0 ? (
          <p className="panel-empty">{t("暂无性能记录。运行一次对话后数据将显示在此处。", "No performance records yet. Run a conversation to see data here.")}</p>
        ) : (
          <div className="perf-records">
            <div className="perf-legend">
              <span style={{ color: "var(--accent, #4fc3f7)" }}>■ ctx</span>
              <span style={{ color: "var(--success, #81c784)" }}>■ llm</span>
              <span style={{ color: "var(--warning, #ffb74d)" }}>■ tool</span>
            </div>
            {records.slice().reverse().map((record) => (
              <div key={record.runId} className="perf-record-row">
                <span className="perf-record-meta">
                  {record.turnCount} turn{record.turnCount > 1 ? "s" : ""} · {formatMs(record.stages.totalMs)}
                </span>
                <StageBar record={record} />
                <span className="perf-record-detail">
                  ctx {formatMs(record.stages.contextBuildMs)} · llm {formatMs(record.stages.providerCallMs)} · tool {formatMs(record.stages.toolExecMs)}
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
