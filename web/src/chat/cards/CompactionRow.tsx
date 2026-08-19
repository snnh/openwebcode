import { useState, type ReactElement } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../components/Icon";
import { Markdown } from "../../components/Markdown";
import { formatTokensShort, formatDateTime } from "../../lib/format";
import { compactionModeText, type CompactionMarker } from "../../lib/compaction";
import { live } from "../../app/live-store";
import { useChatActions } from "../types";

/**
 * 上下文压缩检查点行（/compact 与 85% 水位强制压缩在消息流中的常驻投影）：
 * - running：压缩进行中的占位行（spinner + 模式/强制标注），沉降时被同位替换；
 * - settled：折叠态显示图标 + 标题 + 徽标（手动/强制 85% + 模式）+ 被替换条数与 token 估算，
 *   带摘要的记录可展开查看（摘要走统一 Markdown 渲染，附指令清单与时间）；无摘要保持可见不可展开；
 * - failed：常驻行内错误（role="alert"），可关闭。
 */
export function CompactionRow({ marker }: { marker: CompactionMarker }): ReactElement {
  const { t, locale } = useI18n();
  const { sessionId } = useChatActions();
  const [expanded, setExpanded] = useState(false);

  if (marker.status === "running") {
    return (
      <div className="compaction-row compaction-running" role="status">
        <span className="live-activity-spinner" aria-hidden />
        <span>{t("正在压缩上下文", "Compacting context")}（{t(...compactionModeText(marker.mode))}）…</span>
        {marker.forced && <span className="pill compaction-badge">{t("强制 85%", "forced 85%")}</span>}
      </div>
    );
  }

  if (marker.status === "failed") {
    return (
      <div className="panel-error compaction-row compaction-failed" role="alert">
        <Icon name="alert" size={13} />
        <span className="compaction-error-text">
          {t("上下文压缩失败", "Context compaction failed")}{marker.error ? `：${marker.error}` : ""}
        </span>
        <button
          type="button"
          className="icon-btn compaction-dismiss"
          aria-label={t("关闭", "Dismiss")}
          title={t("关闭", "Dismiss")}
          onClick={() => live.dismissCompaction(sessionId, marker.id)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    );
  }

  const expandable = marker.summary !== undefined;
  const meta = t(
    `压缩前 ${marker.uptoIndex} 条消息${marker.replacedTokens !== undefined ? ` · 约 ${formatTokensShort(marker.replacedTokens)} tokens` : ""}`,
    `${marker.uptoIndex} messages compacted${marker.replacedTokens !== undefined ? ` · ~${formatTokensShort(marker.replacedTokens)} tokens` : ""}`,
  );

  return (
    <div className={`compaction-row compaction-settled${expanded ? " open" : ""}`}>
      <button
        type="button"
        className="collapse-row compaction-head"
        aria-expanded={expandable ? expanded : undefined}
        aria-disabled={!expandable || undefined}
        title={expandable
          ? t("查看压缩摘要", "View compaction summary")
          : t("该次压缩的摘要不可用（页面生命周期内的较早记录）", "Summary for this compaction is unavailable (earlier record in this page's lifetime)")}
        onClick={() => {
          if (expandable) setExpanded((value) => !value);
        }}
      >
        <Icon name="compress" size={13} />
        <span className="compaction-title">{t("上下文已压缩", "Context compacted")}</span>
        <span className="pill compaction-badge">{marker.forced ? t("强制 85%", "forced 85%") : t("手动", "manual")}</span>
        <span className="pill compaction-badge">{t(...compactionModeText(marker.mode))}</span>
        <span className="compaction-meta">{meta}</span>
        {expandable && (
          <span className="compaction-chevron" aria-hidden>
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} />
          </span>
        )}
      </button>
      {expanded && expandable && (
        <div className="compaction-detail">
          {marker.instructions && marker.instructions.length > 0 && (
            <div className="compaction-instructions">
              <p className="compaction-detail-label">{t("用户明确指令（跨段累积）", "Explicit user instructions (accumulated)")}</p>
              <ul>
                {marker.instructions.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
          )}
          <p className="compaction-detail-label">{t("压缩摘要", "Compaction summary")}</p>
          <Markdown>{marker.summary!}</Markdown>
          <p className="compaction-time">{formatDateTime(marker.createdAt, locale)}</p>
        </div>
      )}
    </div>
  );
}
