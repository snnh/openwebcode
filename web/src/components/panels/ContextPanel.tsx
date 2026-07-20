import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { SessionDetail } from "../../lib/contracts";
import { formatCurrency, formatTokens, microToDecimal } from "../../lib/format";
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
  const [form, setForm] = useState({ enabled: true, strategy: "lag" as "lag" | "interval" | "off", lag: "1", interval: "5", pinExemptRounds: "5", restoreBudget: "20000" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!policy) return;
    setForm({ enabled: policy.enabled, strategy: policy.strategy, lag: String(policy.lag), interval: String(policy.interval), pinExemptRounds: String(policy.pinExemptRounds), restoreBudget: String(policy.restoreBudget) });
  }, [policy]);
  const save = (): void => {
    const values = [form.lag, form.interval, form.pinExemptRounds, form.restoreBudget];
    if (values.some((value) => !/^\d+$/.test(value))) { onNotice(t("上下文策略数值必须为非负整数", "Context policy values must be non-negative integers"), "error"); return; }
    setBusy(true);
    api.updateContextPolicy(sessionId, {
      enabled: form.enabled,
      strategy: form.strategy,
      lag: Number(form.lag),
      interval: Number(form.interval),
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
        <label>{t("策略", "Strategy")}<select value={form.strategy} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, strategy: event.target.value as typeof value.strategy }))}><option value="lag">{t("滚动 lag", "Rolling lag")}</option><option value="interval">{t("定期 interval", "Periodic interval")}</option><option value="off">{t("仅手动", "Manual only")}</option></select></label>
        <label>{t("保留最近轮数", "Recent rounds to retain")}<input value={form.lag} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, lag: event.target.value }))} /></label>
        <label>{t("批量间隔", "Batch interval")}<input value={form.interval} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, interval: event.target.value }))} /></label>
        <label>{t("回写保护轮数", "Restore protection rounds")}<input value={form.pinExemptRounds} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, pinExemptRounds: event.target.value }))} /></label>
        <label>{t("回写预算 tokens", "Restore budget (tokens)")}<input value={form.restoreBudget} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, restoreBudget: event.target.value }))} /></label>
        <button className="btn small" disabled={running || busy} onClick={save}>{busy ? t("处理中…", "Working…") : t("保存策略", "Save policy")}</button>
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
              value={costLimit}
              onChange={(event) => setCostLimit(event.target.value)}
              placeholder={t("如 5.00，留空清除", "For example 5.00; leave empty to clear")}
              inputMode="decimal"
              disabled={running || saving}
            />
            <select
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

export function ContextPanel({ sessionId, session, running, onNotice }: {
  sessionId?: string;
  session?: SessionDetail;
  running: boolean;
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

  if (!sessionId) return <div className="inspector-body"><p className="panel-empty">{t("选择会话以查看上下文。", "Select a session to view context.")}</p></div>;
  if (context.isPending) return <div className="inspector-body"><p className="panel-empty">{t("加载中…", "Loading…")}</p></div>;
  if (context.isError || !context.data) return <div className="inspector-body"><p className="panel-empty">{t("暂无用量数据。", "No usage data available.")}</p></div>;

  const { usage, cost, entries } = context.data.ledger;

  return (
    <div className="inspector-body">
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
      {entries.length === 0 && !session?.messages.some((message) => message.role === "tool") && <p className="panel-empty">{t("暂无条目。", "No entries.")}</p>}
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
