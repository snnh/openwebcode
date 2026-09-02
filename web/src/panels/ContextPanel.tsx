import { useEffect, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ContextTokenUsage, ContextUsage, ContextView } from "../lib/contracts";
import { cacheHitRate } from "../lib/cache-stats";
import { deriveWindowInfo, windowLevel, compactionThresholdPercent, type ContextWindowInfo } from "../lib/context-window";
import { formatCurrency, formatDateTime, formatTokens, formatTokensShort, microToDecimal } from "../lib/format";
import { compactionModeNameText } from "../lib/compaction";
import { cacheTone, formatCacheTitle } from "../lib/cache-stats";
import { useStore } from "../app/store";
import { sessionStore } from "../app/session-store";
import { qk, useContextViewQuery, useExtensionsQuery, useModelsQuery, useServerSettingsQuery, useSessionQuery } from "../app/queries";
import { ui } from "../app/ui-store";
import { useI18n } from "../i18n";
import { messageSummary } from "./context-entry-summary";
import { ContextSaverSections } from "./ContextSaverSections";

/** 按段 token 归因（§4.4）：展示本次上下文构建各段占用与构建耗时。 */
function SegmentStats({ stats }: { stats: NonNullable<ContextView["stats"]> }): ReactElement {
  const { t } = useI18n();
  const rows: Array<[string, string, number]> = [
    [t("系统提示词", "System prompt"), "system", stats.segments.system],
    [t("输入", "Input"), "input", stats.segments.input],
    [t("工具调用", "Tool calls"), "toolCalls", stats.segments.toolCalls],
    [t("正式输出", "Output"), "output", stats.segments.output],
    [t("其它", "Other"), "other", stats.segments.other],
  ];
  return (
    <>
      <h2>{t("按段 token 归因", "Token usage by segment")}</h2>
      <dl>
        {rows.map(([label, key, value]) => (
          <FragmentRow key={key} label={label} value={value} />
        ))}
        <dt>{t("本次构建", "Last build")}</dt>
        <dd>
          {stats.buildMs.toFixed(1)}ms · {stats.incremental ? t("增量复用", "Incremental") : t("全量重建", "Full rebuild")}
        </dd>
        {stats.pinnedTokens > 0 && (
          <>
            <dt>{t("pin 占用", "Pinned tokens")}</dt>
            <dd>{formatTokens(stats.pinnedTokens)}</dd>
          </>
        )}
      </dl>
    </>
  );
}

/** 上下文窗口占用（§水位）：占用 meter + 缓存命中行 + 分段堆叠条 + 压缩水位提示。 */
function WindowSection({ info, latestUsage, cumulativeUsage, evicted, thresholdPercent = 85 }: {
  info: ContextWindowInfo;
  /** 最近一轮 token 用量（session-store usages，WS context.usage 写入）；本轮缓存命中来源。 */
  latestUsage?: ContextUsage | undefined;
  /** 会话累计用量（ledger.usage）；累计缓存命中来源。 */
  cumulativeUsage: ContextTokenUsage;
  /** 驱逐态工具结果聚合（stats.evicted）；无驱逐条目时默认不渲染 */
  evicted?: { tokens: number; count: number } | undefined;
  /** 自动压缩水位（%，设置页可调）；meter 配色阈值随动 */
  thresholdPercent?: number;
}): ReactElement {
  const { t } = useI18n();
  const level = windowLevel(info.utilization, thresholdPercent);
  const pct = info.utilization !== undefined ? Math.round(info.utilization * 100) : undefined;
  const latestCache = latestUsage ? cacheHitRate(latestUsage) : undefined;
  const cumulativeCache = cacheHitRate(cumulativeUsage);
  // 完全无缓存活动（本轮与累计读写均为 0）时不渲染缓存行
  const hasCacheActivity =
    (latestCache !== undefined && (latestCache.cacheRead > 0 || latestCache.cacheWrite > 0)) ||
    cumulativeCache.cacheRead > 0 || cumulativeCache.cacheWrite > 0;
  const rows: Array<[string, string, number]> = [
    ["system", t("系统提示词", "System prompt"), info.segments.system],
    ["input", t("输入", "Input"), info.segments.input],
    ["toolCalls", t("工具调用", "Tool calls"), info.segments.toolCalls],
    ["output", t("正式输出", "Output"), info.segments.output],
    ["other", t("其它", "Other"), info.segments.other],
  ];
  const segmentTotal = rows.reduce((sum, [, , value]) => sum + value, 0);
  const visibleRows = rows.filter(([, , value]) => value > 0);
  return (
    <>
      <h2>{t("上下文窗口", "Context window")}</h2>
      <p
        className="ctx-window-label"
        title={info.workingBudget !== undefined
          ? t(`工作预算 ${formatTokens(info.workingBudget)} tokens（上下文窗口扣除系统侧占用与输出预留）`, `Working budget ${formatTokens(info.workingBudget)} tokens (context window minus system-side usage and output reserve)`)
          : undefined}
      >
        {info.contextWindow !== undefined && pct !== undefined
          ? `${formatTokens(info.estimatedTokens)} / ${formatTokens(info.contextWindow)} · ${pct}%`
          : `${formatTokens(info.estimatedTokens)} tokens`}
      </p>
      {pct !== undefined && (
        <div
          className={`ctx-window-bar${level !== "normal" ? ` level-${level}` : ""}`}
          role="meter"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("上下文窗口占用", "Context window usage")}
        >
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {hasCacheActivity && (
        <p className="ctx-cache-row" data-testid="ctx-cache">
          {latestCache && latestCache.rate !== null && (latestCache.cacheRead > 0 || latestCache.cacheWrite > 0) && (
            <span
              className="pill small"
              title={formatCacheTitle(latestCache, { cumulative: false }, t, formatTokensShort)}
            >
              {t("本轮", "Last call")} {Math.round(latestCache.rate * 100)}%
            </span>
          )}
          {cumulativeCache.rate !== null && (cumulativeCache.cacheRead > 0 || cumulativeCache.cacheWrite > 0) && (
            <span
              className="pill small accent"
              data-tone={cacheTone(cumulativeCache)}
              title={formatCacheTitle(cumulativeCache, { cumulative: true }, t, formatTokens)}
            >
              {t("累计", "Session")} {Math.round(cumulativeCache.rate * 100)}%
            </span>
          )}
        </p>
      )}
      {segmentTotal > 0 && (
        <>
          <div className="segment-bar" aria-hidden>
            {visibleRows.map(([key, , value]) => (
              <i key={key} className={`seg-${key}`} style={{ width: `${(value / segmentTotal) * 100}%` }} />
            ))}
          </div>
          <ul className="segment-legend">
            {visibleRows.map(([key, label, value]) => (
              <li key={key}><span className={`seg-dot seg-${key}`} aria-hidden />{label} {formatTokens(value)}</li>
            ))}
            {info.pinnedTokens > 0 && <li>{t("pin 占用", "Pinned")} {formatTokens(info.pinnedTokens)}</li>}
          </ul>
        </>
      )}
      {evicted && (
        <p
          className="ctx-evicted-row"
          data-testid="ctx-evicted"
          title={t("被驱逐的工具结果原文已移出视图、存为 artifact；agent 可用 read_artifact 按需召回", "Evicted tool results were moved out of the view into artifacts; the agent can recall them on demand with read_artifact")}
        >
          {t(`已驱逐 ${formatTokens(evicted.tokens)} tokens（${evicted.count} 条工具结果）`, `${formatTokens(evicted.tokens)} tokens evicted (${evicted.count} tool results)`)}
        </p>
      )}
      {info.warning === "compact_recommended" && (
        <p className="panel-note">{t("上下文接近上限，建议压缩", "Context is nearing its limit; compaction is recommended.")}</p>
      )}
      {info.warning === "force_compact" && (
        <p className="panel-note danger">{t("已达强制压缩水位，本轮已自动压缩", "Force-compact threshold reached; this turn was compacted automatically.")}</p>
      )}
    </>
  );
}

function FragmentRow({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd>{formatTokens(value)}</dd>
    </>
  );
}

function BudgetSection({ sessionId, running, context }: {
  sessionId: string;
  running: boolean;
  context: ContextView;
}): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const policy = context.ledger.policy;
  const [tokenLimit, setTokenLimit] = useState("");
  const [costLimit, setCostLimit] = useState("");
  const [costCurrency, setCostCurrency] = useState<"CNY" | "USD">("CNY");
  const [saving, setSaving] = useState(false);

  // 数据到达后回显当前上限
  useEffect(() => {
    setTokenLimit(policy?.maxSessionTokens?.toString() ?? "");
    setCostLimit(policy?.maxSessionCost ? microToDecimal(policy.maxSessionCost.microUnits) : "");
    setCostCurrency(policy?.maxSessionCost?.currency ?? context.preferences.currency ?? "CNY");
  }, [context, policy]);

  const save = (): void => {
    const tokens = tokenLimit.trim();
    const cost = costLimit.trim();
    if (tokens && (!/^\d+$/.test(tokens) || Number(tokens) < 1)) {
      ui.notify(t("Token 上限必须为正整数", "Token limit must be a positive integer"), "error");
      return;
    }
    if (cost && (!/^\d+(\.\d+)?$/.test(cost) || Number(cost) <= 0)) {
      ui.notify(t("成本上限必须为正数", "Cost limit must be a positive number"), "error");
      return;
    }
    setSaving(true);
    api.updateBudget(sessionId, {
      maxSessionTokens: tokens ? Number(tokens) : null,
      maxSessionCost: cost ? { amount: cost, currency: costCurrency } : null,
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) });
        ui.notify(t("预算已更新", "Budget updated"));
      })
      .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("预算更新失败", "Budget update failed"), "error"))
      .finally(() => setSaving(false));
  };

  return (
    <>
      <h2>{t("预算上限", "Budget limits")}</h2>
      <dl>
        <dt>{t("Token 上限", "Token limit")}</dt>
        <dd>{policy?.maxSessionTokens ? formatTokens(policy.maxSessionTokens) : t("未设置", "Not set")}</dd>
        <dt>{t("成本上限", "Cost limit")}</dt>
        <dd>{policy?.maxSessionCost ? formatCurrency(policy.maxSessionCost.microUnits, policy.maxSessionCost.currency) : t("未设置", "Not set")}</dd>
      </dl>
      <div className="budget-form">
        <label>
          {t("Token 上限", "Token limit")}
          <input
            className="input"
            value={tokenLimit}
            onChange={(event) => setTokenLimit(event.target.value)}
            placeholder={t("如 200000，留空清除", "For example 200000; leave empty to clear")}
            inputMode="numeric"
            disabled={running || saving}
          />
        </label>
        <label>
          {t("成本上限", "Cost limit")}
          <span className="budget-cost-row">
            <input
              className="input"
              value={costLimit}
              onChange={(event) => setCostLimit(event.target.value)}
              placeholder={t("如 5.00，留空清除", "For example 5.00; leave empty to clear")}
              inputMode="decimal"
              disabled={running || saving}
            />
            <select
              className="input"
              value={costCurrency}
              onChange={(event) => setCostCurrency(event.target.value as "CNY" | "USD")}
              disabled={running || saving}
              aria-label={t("成本币种", "Cost currency")}
            >
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
          </span>
        </label>
        <button className="btn small" disabled={running || saving} onClick={save}>
          {saving ? t("保存中…", "Saving…") : t("保存预算", "Save budget")}
        </button>
        {running && <p className="panel-note">{t("运行中不可修改预算，待当前轮结束。", "The budget cannot be changed while running. Wait for the current turn to finish.")}</p>}
      </div>
    </>
  );
}

/** 压缩（核心功能，不随 context-saver 扩展开关）：手动压缩入口 + 最近一次压缩信息。 */
function CompactionSection({ sessionId, running, context }: {
  sessionId: string;
  running: boolean;
  context: ContextView;
}): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [compacting, setCompacting] = useState<"toolcalls" | "overview" | null>(null);
  const compacted = context.ledger.compacted;
  const compact = (mode: "toolcalls" | "overview"): void => {
    setCompacting(mode);
    api.compactContext(sessionId, mode).then((result) => {
      void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) });
      ui.notify(result.changed
        ? (mode === "toolcalls" ? t("工具调用已压缩", "Tool calls compacted") : t("已生成上下文概览", "Context overview generated"))
        : result.reason ?? t("无需压缩", "No compaction needed"));
    }).catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("压缩失败", "Compaction failed"), "error")).finally(() => setCompacting(null));
  };
  return (
    <>
      <h2>{t("压缩", "Compaction")}</h2>
      <div className="context-actions">
        <button className="btn small" disabled={running || compacting !== null} onClick={() => compact("toolcalls")}>{compacting === "toolcalls" ? t("压缩中…", "Compacting…") : t("压缩工具调用", "Compact tool calls")}</button>
        <button className="btn small" disabled={running || compacting !== null} onClick={() => compact("overview")}>{compacting === "overview" ? t("压缩中…", "Compacting…") : t("概览压缩", "Overview compaction")}</button>
      </div>
      {compacted && (
        <dl>
          <dt>{t("模式", "Mode")}</dt>
          <dd>{t(...compactionModeNameText(compacted.mode))}</dd>
          {compacted.replacedTokens !== undefined && (
            <>
              <dt>{t("被替换段估算", "Replaced estimate")}</dt>
              <dd>{t(`约 ${formatTokensShort(compacted.replacedTokens)} tokens`, `~${formatTokensShort(compacted.replacedTokens)} tokens`)}</dd>
            </>
          )}
          <dt>{t("范围", "Range")}</dt>
          <dd>{t(`前 ${compacted.uptoIndex} 条消息`, `First ${compacted.uptoIndex} messages`)}</dd>
          <dt>{t("时间", "Time")}</dt>
          <dd>{formatDateTime(compacted.createdAt, locale)}</dd>
          {compacted.instructions.length > 0 && (
            <>
              <dt>{t("用户明确指令（累积）", "Explicit user instructions (cumulative)")}</dt>
              <dd className="kv-text">{compacted.instructions.map((item) => `· ${item}`).join("\n")}</dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

/** 上下文面板：窗口水位/用量/成本/压缩/预算；驱逐策略、选择性上下文与条目管理是
 *  context-saver 扩展能力，仅扩展启用时渲染（ContextSaverSections）。 */
export function ContextPanel({ sessionId, running }: {
  sessionId?: string | undefined;
  running: boolean;
}): ReactElement {
  const { t } = useI18n();
  const context = useContextViewQuery(sessionId);
  const session = useSessionQuery(sessionId);
  const models = useModelsQuery();
  const extensions = useExtensionsQuery();
  const serverSettings = useServerSettingsQuery();
  // WS 实时水位/本轮用量（事件路由写 session-store）；默认时由 REST stats + 模型档案播种
  const watermark = useStore(sessionStore, (state) => (sessionId ? state.watermarks[sessionId] : undefined));
  const latestUsage = useStore(sessionStore, (state) => (sessionId ? state.usages[sessionId] : undefined));

  if (!sessionId) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以查看上下文。", "Select a session to view context.")}</p></div>;
  if (context.isPending) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p></div>;
  if (context.isError || !context.data) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("暂无用量数据。", "No usage data available.")}</p></div>;

  const detail = session.data;
  const summarize = (messageId: string): string => messageSummary(detail?.messages, messageId, t);
  const { usage, cost } = context.data.ledger;
  const model = models.data?.find((item) => item.id === detail?.model && item.provider === detail?.provider);
  // 实时水位优先；默认时由 REST stats + 模型档案播种（窗口未知则只展示 tokens，不显示百分比）
  const windowInfo = deriveWindowInfo(watermark, context.data.stats, model);
  // 扩展清单未加载完成时按默认开启处理（defaultEnabled: true），加载后以实际开关为准
  const saverEnabled = !extensions.data || extensions.data.some((extension) => extension.id === "context-saver" && extension.enabled);

  return (
    <div className="inspector-body">
      {windowInfo && <WindowSection info={windowInfo} latestUsage={latestUsage} cumulativeUsage={usage} evicted={context.data.stats?.evicted} thresholdPercent={compactionThresholdPercent(serverSettings.data)} />}
      <h2>{t("上下文用量", "Context usage")}</h2>
      <dl>
        <dt>{t("输入 tokens", "Input tokens")}</dt>
        <dd>{formatTokens(usage.inputTokens)}</dd>
        <dt>{t("输出 tokens", "Output tokens")}</dt>
        <dd>{formatTokens(usage.outputTokens)}</dd>
        <dt>{t("合计", "Total")}</dt>
        <dd>{formatTokens(usage.inputTokens + usage.outputTokens)}</dd>
        <dt>{t("缓存读 / 写", "Cache read / write")}</dt>
        <dd>{formatTokens(usage.cacheRead)} / {formatTokens(usage.cacheWrite)}</dd>
      </dl>
      <h2>{t("Prompt cache 断点", "Prompt cache breakpoints")}</h2>
      {(context.data.ledger.cacheBreakpoints ?? []).length === 0 ? (
        <p className="muted-empty panel-empty">{t("本回合还没有记录断点；Anthropic 兼容 Provider 会在工具定义、稳定系统段与消息前缀上打显式断点，OpenAI 兼容 Provider 由服务端自动缓存。", "No breakpoints recorded this run yet. Anthropic-compatible providers place explicit breakpoints on tool definitions, the stable system prefix, and message prefixes; OpenAI-compatible providers cache automatically server-side.")}</p>
      ) : (
        <dl>
          <dt>{t("消息级断点数", "Message breakpoints")}</dt>
          <dd>{context.data.ledger.cacheBreakpoints!.length}</dd>
          {context.data.ledger.cacheBreakpoints!.map((id) => (
            <dd key={id} className="mono kv-text" title={id}>{summarize(id)}</dd>
          ))}
        </dl>
      )}
      <h2>{t("成本", "Cost")}</h2>
      <dl>
        <dt>{t("人民币", "Chinese yuan")}</dt>
        <dd>{formatCurrency(cost.cnyMicroUnits, "CNY")}</dd>
        <dt>{t("美元", "US dollars")}</dt>
        <dd>{formatCurrency(cost.usdMicroUnits, "USD")}</dd>
        {cost.unpricedTokens > 0 && (
          <>
            <dt>{t("未计价 tokens", "Unpriced tokens")}</dt>
            <dd>{formatTokens(cost.unpricedTokens)}</dd>
          </>
        )}
      </dl>
      {context.data.stats && <SegmentStats stats={context.data.stats} />}
      <CompactionSection sessionId={sessionId} running={running} context={context.data} />
      <BudgetSection sessionId={sessionId} running={running} context={context.data} />
      {saverEnabled && <ContextSaverSections sessionId={sessionId} running={running} context={context.data} messages={detail?.messages} />}
    </div>
  );
}
