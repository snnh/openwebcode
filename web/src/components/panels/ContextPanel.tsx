import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ContextTokenUsage, ContextUsage, ContextView, SessionDetail } from "../../lib/contracts";
import { cacheHitRate } from "../../lib/cache-stats";
import { deriveWindowInfo, windowLevel, type ContextWindowInfo } from "../../lib/context-window";
import { formatCurrency, formatTokens, formatTokensShort, microToDecimal } from "../../lib/format";
import { useI18n } from "../../i18n";

const STATE_LABELS: Record<string, [string, string]> = { full: ["保留", "Retained"], evicted: ["已逐出", "Evicted"], restored: ["已恢复", "Restored"] };

function messageSummary(session: SessionDetail | undefined, messageId: string, t: (zh: string, en: string) => string): string {
  const message = session?.messages.find((item) => item.id === messageId);
  if (!message) return messageId;
  for (const block of message.content) {
    if (block.type === "tool_call" && block.name) return t(`工具 ${block.name}`, `Tool ${block.name}`);
    if (block.type === "tool_result" && block.content?.trim()) {
      const text = block.content.trim().replace(/\s+/g, " ");
      return text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
    if (block.type === "text" && block.text?.trim()) {
      const text = block.text.trim().replace(/\s+/g, " ");
      return text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
  }
  return messageId;
}

function PolicySection({ sessionId, running, onNotice }: { sessionId: string; running: boolean; onNotice(message: string, kind?: "info" | "error"): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const context = useQuery({ queryKey: ["context", sessionId], queryFn: () => api.context(sessionId) });
  const policy = context.data?.ledger.policy;
  const [form, setForm] = useState({ enabled: true, strategy: "lag" as "lag" | "interval" | "off", evictionMode: "placeholder" as "placeholder" | "process", lag: "2", interval: "5", minRetainTokens: "256", readKeepLines: "50", pinExemptRounds: "5", restoreBudget: "20000" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!policy) return;
    setForm({ enabled: policy.enabled, strategy: policy.strategy, evictionMode: policy.evictionMode, lag: String(policy.lag), interval: String(policy.interval), minRetainTokens: String(policy.minRetainTokens), readKeepLines: String(policy.readKeepLines), pinExemptRounds: String(policy.pinExemptRounds), restoreBudget: String(policy.restoreBudget) });
  }, [policy]);
  const save = (): void => {
    const values = [form.lag, form.interval, form.minRetainTokens, form.readKeepLines, form.pinExemptRounds, form.restoreBudget];
    if (values.some((value) => !/^\d+$/.test(value))) { onNotice(t("上下文策略数值必须为非负整数", "Context policy values must be non-negative integers"), "error"); return; }
    setBusy(true);
    api.updateContextPolicy(sessionId, {
      enabled: form.enabled,
      strategy: form.strategy,
      evictionMode: form.evictionMode,
      lag: Number(form.lag),
      interval: Number(form.interval),
      minRetainTokens: Number(form.minRetainTokens),
      readKeepLines: Number(form.readKeepLines),
      pinExemptRounds: Number(form.pinExemptRounds),
      restoreBudget: Number(form.restoreBudget),
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["context", sessionId] });
      onNotice(t("上下文策略已更新", "Context policy updated"));
    }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("策略更新失败", "Policy update failed"), "error")).finally(() => setBusy(false));
  };
  return (
    <>
      <h2>{t("管理与压缩", "Management and compaction")}</h2>
      <div className="context-actions">
        <button className="btn small" disabled={running || busy} onClick={() => {
          setBusy(true); api.compactContext(sessionId, "toolcalls").then((result) => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(result.changed ? t("工具调用已压缩", "Tool calls compacted") : result.reason ?? t("无需压缩", "No compaction needed")); }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("压缩失败", "Compaction failed"), "error")).finally(() => setBusy(false));
        }}>{t("压缩工具调用", "Compact tool calls")}</button>
        <button className="btn small" disabled={running || busy} onClick={() => {
          setBusy(true); api.compactContext(sessionId, "overview").then((result) => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(result.changed ? t("已生成上下文概览", "Context overview generated") : result.reason ?? t("无需压缩", "No compaction needed")); }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("压缩失败", "Compaction failed"), "error")).finally(() => setBusy(false));
        }}>{t("概览压缩", "Overview compaction")}</button>
      </div>
      <div className="context-policy-form">
        <label><input type="checkbox" checked={form.enabled} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} /> {t("启用自动驱逐", "Enable automatic eviction")}</label>
        <label>{t("策略", "Strategy")}<select className="input" value={form.strategy} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, strategy: event.target.value as typeof value.strategy }))}><option value="lag">{t("滚动 lag", "Rolling lag")}</option><option value="interval">{t("定期 interval", "Periodic interval")}</option><option value="off">{t("仅手动", "Manual only")}</option></select></label>
        <label>{t("驱逐模式", "Eviction mode")}<select className="input" value={form.evictionMode} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, evictionMode: event.target.value as typeof value.evictionMode }))}><option value="placeholder">{t("默认节省（占位符）", "Default saver (placeholder)")}</option><option value="process">{t("超级节省（整轮过程驱逐）", "Super saver (whole-round eviction)")}</option></select></label>
        <label>{t("保留最近轮数", "Recent rounds to retain")}<input className="input" value={form.lag} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, lag: event.target.value }))} /></label>
        <label>{t("结果保留下限 tokens", "Min result tokens to retain")}<input className="input" value={form.minRetainTokens} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, minRetainTokens: event.target.value }))} /></label>
        <label>{t("read 头尾保留行数", "Read head/tail lines to keep")}<input className="input" value={form.readKeepLines} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, readKeepLines: event.target.value }))} /></label>
        <label>{t("批量间隔", "Batch interval")}<input className="input" value={form.interval} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, interval: event.target.value }))} /></label>
        <label>{t("回写保护轮数", "Restore protection rounds")}<input className="input" value={form.pinExemptRounds} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, pinExemptRounds: event.target.value }))} /></label>
        <label>{t("回写预算 tokens", "Restore budget (tokens)")}<input className="input" value={form.restoreBudget} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, restoreBudget: event.target.value }))} /></label>
        <button className="btn small" disabled={running || busy} onClick={save}>{busy ? t("处理中…", "Working…") : t("保存策略", "Save policy")}</button>
      </div>
    </>
  );
}

/** 按段 token 归因（§4.4）：展示本次上下文构建各段占用与构建耗时。 */
function SegmentStats({ stats }: { stats: NonNullable<ContextView["stats"]> }): ReactElement {
  const { t } = useI18n();
  const rows: Array<[string, string, number]> = [
    [t("压缩摘要", "Compaction summary"), "compactionSummary", stats.segments.compactionSummary],
    [t("工具结果", "Tool results"), "toolResults", stats.segments.toolResults],
    [t("对话消息", "Messages"), "messages", stats.segments.messages],
    [t("Repo map", "Repo map"), "repoMap", stats.segments.repoMap],
    [t("系统/cache 稳定段", "System / cache-stable"), "system", stats.segments.system],
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
function WindowSection({ info, latestUsage, cumulativeUsage }: {
  info: ContextWindowInfo;
  /** 最近一轮 token 用量（WS context.usage）；本轮缓存命中来源。 */
  latestUsage?: ContextUsage;
  /** 会话累计用量（ledger.usage）；累计缓存命中来源。 */
  cumulativeUsage: ContextTokenUsage;
}): ReactElement {
  const { t } = useI18n();
  const level = windowLevel(info.utilization);
  const pct = info.utilization !== undefined ? Math.round(info.utilization * 100) : undefined;
  const latestCache = latestUsage ? cacheHitRate(latestUsage) : undefined;
  const cumulativeCache = cacheHitRate(cumulativeUsage);
  // 完全无缓存活动（本轮与累计读写均为 0）时不渲染缓存行
  const hasCacheActivity =
    (latestCache !== undefined && (latestCache.cacheRead > 0 || latestCache.cacheWrite > 0)) ||
    cumulativeCache.cacheRead > 0 || cumulativeCache.cacheWrite > 0;
  const rows: Array<[string, string, number]> = [
    ["messages", t("对话消息", "Messages"), info.segments.messages],
    ["toolResults", t("工具结果", "Tool results"), info.segments.toolResults],
    ["repoMap", t("Repo map", "Repo map"), info.segments.repoMap],
    ["compactionSummary", t("压缩摘要", "Compaction summary"), info.segments.compactionSummary],
    ["system", t("系统/cache 稳定段", "System / cache-stable"), info.segments.system],
    ["other", t("其他", "Other"), info.segments.other],
  ];
  const segmentTotal = rows.reduce((sum, [, , value]) => sum + value, 0);
  const visibleRows = rows.filter(([, , value]) => value > 0);
  return (
    <>
      <h2>{t("上下文窗口", "Context window")}</h2>
      <p
        className="ctx-window-label"
        title={info.workingBudget !== undefined
          ? t(`工作预算 ${formatTokens(info.workingBudget)} tokens（窗口 − 最大输出）`, `Working budget ${formatTokens(info.workingBudget)} tokens (window − max output)`)
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
            <span>{t("本轮缓存命中", "Last-call cache hit")} {Math.round(latestCache.rate * 100)}%{t(`（读取 ${formatTokensShort(latestCache.cacheRead)} · 写入 ${formatTokensShort(latestCache.cacheWrite)}）`, `(read ${formatTokensShort(latestCache.cacheRead)} · write ${formatTokensShort(latestCache.cacheWrite)})`)}</span>
          )}
          {cumulativeCache.rate !== null && (cumulativeCache.cacheRead > 0 || cumulativeCache.cacheWrite > 0) && (
            <span
              title={t(`累计缓存读取 ${formatTokens(cumulativeCache.cacheRead)} · 写入 ${formatTokens(cumulativeCache.cacheWrite)}`, `Session cache read ${formatTokens(cumulativeCache.cacheRead)} · write ${formatTokens(cumulativeCache.cacheWrite)}`)}
            >
              {t("累计缓存命中", "Session cache hit")} {Math.round(cumulativeCache.rate * 100)}%
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

/** 选择性上下文（§4.4）：pin 不被驱逐；排除路径不进上下文。排除不是安全边界。 */
function SelectionSection({ sessionId, running, onNotice }: { sessionId: string; running: boolean; onNotice(message: string, kind?: "info" | "error"): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const context = useQuery({ queryKey: ["context", sessionId], queryFn: () => api.context(sessionId) });
  const selection = context.data?.selection ?? { pins: [], excludes: [] };
  const [pinInput, setPinInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const save = (pins: string[], excludes: string[]): void => {
    setBusy(true);
    api.updateContextSelection(sessionId, { pins, excludes })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["context", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        onNotice(t("选择性上下文已更新", "Context selection updated"));
      })
      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("更新失败", "Update failed"), "error"))
      .finally(() => setBusy(false));
  };
  const addPin = (): void => {
    const value = pinInput.trim();
    if (!value) return;
    if (selection.pins.includes(value)) { setPinInput(""); return; }
    save([...selection.pins, value], selection.excludes);
    setPinInput("");
  };
  const addExclude = (): void => {
    const value = excludeInput.trim();
    if (!value) return;
    if (selection.excludes.includes(value)) { setExcludeInput(""); return; }
    save(selection.pins, [...selection.excludes, value]);
    setExcludeInput("");
  };
  const disabled = running || busy;
  return (
    <>
      <h2>{t("选择性上下文（pin / 排除）", "Selective context (pin / exclude)")}</h2>
      <p className="panel-note">
        {t("pin 的消息或文件不被自动驱逐；排除的路径不进入上下文组装、repo map 与索引。注意：排除不是安全边界——文件访问权限仍由路径策略与沙盒保证。", "Pinned messages or files are never auto-evicted; excluded paths stay out of the context, repo map, and index. Note: exclusion is not a security boundary — file access is still governed by path policy and the sandbox.")}
      </p>
      <h3>{t("已 pin", "Pinned")}</h3>
      {selection.pins.length === 0 && <p className="muted-empty panel-empty">{t("暂无 pin。", "No pins.")}</p>}
      {selection.pins.map((pin) => (
        <div className="context-entry" key={pin}>
          <span className="entry-summary mono" title={pin}>{pin}</span>
          <button className="btn small" disabled={disabled} onClick={() => save(selection.pins.filter((item) => item !== pin), selection.excludes)}>{t("移除", "Remove")}</button>
        </div>
      ))}
      <div className="context-actions">
        <input
          value={pinInput}
          disabled={disabled}
          placeholder={t("消息 id 或文件路径", "Message id or file path")}
          onChange={(event) => setPinInput(event.target.value)}
          aria-label={t("新增 pin", "Add pin")}
        />
        <button className="btn small" disabled={disabled || !pinInput.trim()} onClick={addPin}>{t("添加 pin", "Add pin")}</button>
      </div>
      <h3>{t("排除路径", "Excluded paths")}</h3>
      {selection.excludes.length === 0 && <p className="muted-empty panel-empty">{t("暂无排除。", "No exclusions.")}</p>}
      {selection.excludes.map((exclude) => (
        <div className="context-entry" key={exclude}>
          <span className="entry-summary mono" title={exclude}>{exclude}</span>
          <button className="btn small" disabled={disabled} onClick={() => save(selection.pins, selection.excludes.filter((item) => item !== exclude))}>{t("移除", "Remove")}</button>
        </div>
      ))}
      <div className="context-actions">
        <input
          value={excludeInput}
          disabled={disabled}
          placeholder={t("路径 glob，如 **/*.log", "Path glob, for example **/*.log")}
          onChange={(event) => setExcludeInput(event.target.value)}
          aria-label={t("新增排除路径", "Add excluded path")}
        />
        <button className="btn small" disabled={disabled || !excludeInput.trim()} onClick={addExclude}>{t("添加排除", "Add exclusion")}</button>
      </div>
    </>
  );
}

function BudgetSection({ sessionId, running, onNotice }: {
  sessionId: string;
  running: boolean;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const context = useQuery({ queryKey: ["context", sessionId], queryFn: () => api.context(sessionId) });
  const policy = context.data?.ledger.policy;
  const [tokenLimit, setTokenLimit] = useState("");
  const [costLimit, setCostLimit] = useState("");
  const [costCurrency, setCostCurrency] = useState<"CNY" | "USD">("CNY");
  const [saving, setSaving] = useState(false);

  // 数据到达后回显当前上限
  useEffect(() => {
    setTokenLimit(policy?.maxSessionTokens?.toString() ?? "");
    setCostLimit(policy?.maxSessionCost ? microToDecimal(policy.maxSessionCost.microUnits) : "");
    setCostCurrency(policy?.maxSessionCost?.currency ?? context.data?.preferences.currency ?? "CNY");
  }, [context.data]);

  const save = (): void => {
    const tokens = tokenLimit.trim();
    const cost = costLimit.trim();
    if (tokens && (!/^\d+$/.test(tokens) || Number(tokens) < 1)) {
      onNotice(t("Token 上限必须为正整数", "Token limit must be a positive integer"), "error");
      return;
    }
    if (cost && (!/^\d+(\.\d+)?$/.test(cost) || Number(cost) <= 0)) {
      onNotice(t("成本上限必须为正数", "Cost limit must be a positive number"), "error");
      return;
    }
    setSaving(true);
    api.updateBudget(sessionId, {
      maxSessionTokens: tokens ? Number(tokens) : null,
      maxSessionCost: cost ? { amount: cost, currency: costCurrency } : null,
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["context", sessionId] });
        onNotice(t("预算已更新", "Budget updated"));
      })
      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("预算更新失败", "Budget update failed"), "error"))
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

export function ContextPanel({ sessionId, session, running, windowUsage, latestUsage, onNotice }: {
  sessionId?: string;
  session?: SessionDetail;
  running: boolean;
  /** 上下文窗口占用（WS 实时水位，由 App 经 BottomPanel 下发）；缺省由 REST stats + 模型档案播种。 */
  windowUsage?: ContextWindowInfo;
  /** 最近一轮 token 用量（WS context.usage，由 App 经 BottomPanel 下发）；驱动本轮缓存命中行。 */
  latestUsage?: ContextUsage;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [artifact, setArtifact] = useState<{ id: string; content: string }>();
  const context = useQuery({
    queryKey: ["context", sessionId],
    queryFn: () => api.context(sessionId!),
    enabled: Boolean(sessionId),
  });
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });

  if (!sessionId) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以查看上下文。", "Select a session to view context.")}</p></div>;
  if (context.isPending) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p></div>;
  if (context.isError || !context.data) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("暂无用量数据。", "No usage data available.")}</p></div>;

  const { usage, cost, entries } = context.data.ledger;
  const model = models.data?.find((item) => item.id === session?.model && item.provider === session?.provider);
  // 实时水位优先；缺省时由 REST stats + 模型档案播种（窗口未知则只展示 tokens，不显示百分比）
  const windowInfo = windowUsage ?? deriveWindowInfo(undefined, context.data.stats, model);

  return (
    <div className="inspector-body">
      {windowInfo && <WindowSection info={windowInfo} {...(latestUsage ? { latestUsage } : {})} cumulativeUsage={usage} />}
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
            <dd key={id} className="mono" title={id}>{messageSummary(session, id, t)}</dd>
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
      <SelectionSection sessionId={sessionId} running={running} onNotice={onNotice} />
      <BudgetSection sessionId={sessionId} running={running} onNotice={onNotice} />
      <PolicySection sessionId={sessionId} running={running} onNotice={onNotice} />
      {context.data.ledger.compacted && (
        <>
          <h2>{t("压缩", "Compaction")}</h2>
          <dl>
            <dt>{t("模式", "Mode")}</dt>
            <dd>{{ toolcalls: t("工具调用压缩", "Tool-call compaction"), overview: t("概览压缩", "Overview compaction"), truncated: t("规则截断", "Rule-based truncation") }[context.data.ledger.compacted.mode]}</dd>
            <dt>{t("范围", "Range")}</dt>
            <dd>{t(`前 ${context.data.ledger.compacted.uptoIndex} 条消息`, `First ${context.data.ledger.compacted.uptoIndex} messages`)}</dd>
            <dt>{t("时间", "Time")}</dt>
            <dd>{new Date(context.data.ledger.compacted.createdAt).toLocaleString(locale)}</dd>
            {context.data.ledger.compacted.instructions.length > 0 && (
              <>
                <dt>{t("用户明确指令（累积）", "Explicit user instructions (cumulative)")}</dt>
                <dd>{context.data.ledger.compacted.instructions.map((item) => `· ${item}`).join("\n")}</dd>
              </>
            )}
          </dl>
        </>
      )}
      <h2>{t("上下文条目", "Context entries")}</h2>
      {entries.length === 0 && !session?.messages.some((message) => message.role === "tool") && <p className="muted-empty panel-empty">{t("暂无条目。", "No entries.")}</p>}
      {entries.map((entry) => (
        <div className="context-entry" key={`${entry.messageId}-${entry.artifactId}`}>
          <span className={`entry-state entry-${entry.state}`}>{STATE_LABELS[entry.state] ? t(...STATE_LABELS[entry.state]!) : entry.state}</span>
          <span className="entry-summary" title={entry.messageId}>{messageSummary(session, entry.messageId, t)}</span>
          {entry.state === "evicted" && (
            <button
              className="btn small"
              disabled={running}
              title={running ? t("运行中不可恢复", "Cannot restore while running") : t("恢复该条目到上下文", "Restore this entry to context")}
              onClick={() => {
                api.restoreContext(sessionId, entry.messageId)
                  .then(() => {
                    void queryClient.invalidateQueries({ queryKey: ["context", sessionId] });
                    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
                    onNotice(t("已恢复上下文条目", "Context entry restored"));
                  })
                  .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("恢复失败", "Restore failed"), "error"));
              }}
            >
              {t("恢复", "Restore")}
            </button>
          )}
          {entry.state === "restored" && <>
            <button className="btn small" disabled={running} onClick={() => {
              const pinned = (entry.pinnedUntilRound ?? 0) > (context.data.ledger.round ?? 0);
              api.mutateContextEntry(sessionId, entry.messageId, pinned ? "unpin" : "pin")
                .then(() => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(pinned ? t("已取消固定", "Entry unpinned") : t("已固定条目", "Entry pinned")); })
                .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("操作失败", "Operation failed"), "error"));
            }}>{(entry.pinnedUntilRound ?? 0) > (context.data.ledger.round ?? 0) ? t("取消固定", "Unpin") : t("固定", "Pin")}</button>
            <button className="btn small" disabled={running} onClick={() => {
              api.mutateContextEntry(sessionId, entry.messageId, "evict")
                .then(() => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(t("已再次逐出条目", "Entry evicted again")); })
                .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("逐出失败", "Eviction failed"), "error"));
            }}>{t("逐出", "Evict")}</button>
          </>}
          <button className="btn small" onClick={() => {
            api.contextArtifact(sessionId, entry.artifactId)
              .then((value) => setArtifact({ id: entry.artifactId, content: value.content }))
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("原文读取失败", "Could not read original content"), "error"));
          }}>{t("原文", "Original")}</button>
        </div>
      ))}
      {session?.messages.filter((message) => message.role === "tool" && !entries.some((entry) => entry.messageId === message.id)).map((message) => (
        <div className="context-entry" key={message.id}>
          <span className="entry-state">{t("保留", "Retained")}</span>
          <span className="entry-summary" title={message.id}>{messageSummary(session, message.id, t)}</span>
          <button className="btn small" disabled={running} onClick={() => {
            api.mutateContextEntry(sessionId, message.id, "evict")
              .then(() => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(t("已手动逐出条目", "Entry manually evicted")); })
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("逐出失败", "Eviction failed"), "error"));
          }}>{t("逐出", "Evict")}</button>
        </div>
      ))}
      {artifact && (
        <details className="context-artifact" open>
          <summary>{t("Artifact 原文", "Artifact source")} · {artifact.id}</summary>
          <pre className="mono">{artifact.content}</pre>
          <button className="btn small" onClick={() => setArtifact(undefined)}>{t("关闭原文", "Close original")}</button>
        </details>
      )}
    </div>
  );
}
