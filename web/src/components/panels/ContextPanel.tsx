import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { SessionDetail } from "../../lib/contracts";
import { formatCurrency, formatTokens, microToDecimal } from "../../lib/format";

const STATE_LABELS: Record<string, string> = { full: "保留", evicted: "已逐出", restored: "已恢复" };

function messageSummary(session: SessionDetail | undefined, messageId: string): string {
  const message = session?.messages.find((item) => item.id === messageId);
  if (!message) return messageId;
  for (const block of message.content) {
    if (block.type === "tool_call" && block.name) return `工具 ${block.name}`;
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
    if (values.some((value) => !/^\d+$/.test(value))) { onNotice("上下文策略数值必须为非负整数", "error"); return; }
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
      onNotice("上下文策略已更新");
    }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "策略更新失败", "error")).finally(() => setBusy(false));
  };
  return (
    <>
      <h2>管理与压缩</h2>
      <div className="context-actions">
        <button className="btn small" disabled={running || busy} onClick={() => {
          setBusy(true); api.compactContext(sessionId, "toolcalls").then((result) => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(result.changed ? "工具调用已压缩" : result.reason ?? "无需压缩"); }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "压缩失败", "error")).finally(() => setBusy(false));
        }}>压缩工具调用</button>
        <button className="btn small" disabled={running || busy} onClick={() => {
          setBusy(true); api.compactContext(sessionId, "overview").then((result) => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(result.changed ? "已生成上下文概览" : result.reason ?? "无需压缩"); }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "压缩失败", "error")).finally(() => setBusy(false));
        }}>概览压缩</button>
      </div>
      <div className="context-policy-form">
        <label><input type="checkbox" checked={form.enabled} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} /> 启用自动驱逐</label>
        <label>策略<select value={form.strategy} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, strategy: event.target.value as typeof value.strategy }))}><option value="lag">滚动 lag</option><option value="interval">定期 interval</option><option value="off">仅手动</option></select></label>
        <label>保留最近轮数<input value={form.lag} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, lag: event.target.value }))} /></label>
        <label>批量间隔<input value={form.interval} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, interval: event.target.value }))} /></label>
        <label>回写保护轮数<input value={form.pinExemptRounds} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, pinExemptRounds: event.target.value }))} /></label>
        <label>回写预算 tokens<input value={form.restoreBudget} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, restoreBudget: event.target.value }))} /></label>
        <button className="btn small" disabled={running || busy} onClick={save}>{busy ? "处理中…" : "保存策略"}</button>
      </div>
    </>
  );
}

function BudgetSection({ sessionId, running, onNotice }: {
  sessionId: string;
  running: boolean;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
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
      onNotice("Token 上限必须为正整数", "error");
      return;
    }
    if (cost && (!/^\d+(\.\d+)?$/.test(cost) || Number(cost) <= 0)) {
      onNotice("成本上限必须为正数", "error");
      return;
    }
    setSaving(true);
    api.updateBudget(sessionId, {
      maxSessionTokens: tokens ? Number(tokens) : null,
      maxSessionCost: cost ? { amount: cost, currency: costCurrency } : null,
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["context", sessionId] });
        onNotice("预算已更新");
      })
      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "预算更新失败", "error"))
      .finally(() => setSaving(false));
  };

  return (
    <>
      <h2>预算上限</h2>
      <dl>
        <dt>Token 上限</dt>
        <dd>{policy?.maxSessionTokens ? formatTokens(policy.maxSessionTokens) : "未设置"}</dd>
        <dt>成本上限</dt>
        <dd>{policy?.maxSessionCost ? formatCurrency(policy.maxSessionCost.microUnits, policy.maxSessionCost.currency) : "未设置"}</dd>
      </dl>
      <div className="budget-form">
        <label>
          Token 上限
          <input
            value={tokenLimit}
            onChange={(event) => setTokenLimit(event.target.value)}
            placeholder="如 200000，留空清除"
            inputMode="numeric"
            disabled={running || saving}
          />
        </label>
        <label>
          成本上限
          <span className="budget-cost-row">
            <input
              value={costLimit}
              onChange={(event) => setCostLimit(event.target.value)}
              placeholder="如 5.00，留空清除"
              inputMode="decimal"
              disabled={running || saving}
            />
            <select
              value={costCurrency}
              onChange={(event) => setCostCurrency(event.target.value as "CNY" | "USD")}
              disabled={running || saving}
              aria-label="成本币种"
            >
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
          </span>
        </label>
        <button className="btn small" disabled={running || saving} onClick={save}>
          {saving ? "保存中…" : "保存预算"}
        </button>
        {running && <p className="panel-note">运行中不可修改预算，待当前轮结束。</p>}
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
  const queryClient = useQueryClient();
  const [artifact, setArtifact] = useState<{ id: string; content: string }>();
  const context = useQuery({
    queryKey: ["context", sessionId],
    queryFn: () => api.context(sessionId!),
    enabled: Boolean(sessionId),
  });

  if (!sessionId) return <div className="inspector-body"><p className="panel-empty">选择会话以查看上下文。</p></div>;
  if (context.isPending) return <div className="inspector-body"><p className="panel-empty">加载中…</p></div>;
  if (context.isError || !context.data) return <div className="inspector-body"><p className="panel-empty">暂无用量数据。</p></div>;

  const { usage, cost, entries } = context.data.ledger;

  return (
    <div className="inspector-body">
      <h2>上下文用量</h2>
      <dl>
        <dt>输入 tokens</dt>
        <dd>{formatTokens(usage.inputTokens)}</dd>
        <dt>输出 tokens</dt>
        <dd>{formatTokens(usage.outputTokens)}</dd>
        <dt>合计</dt>
        <dd>{formatTokens(usage.inputTokens + usage.outputTokens)}</dd>
        <dt>缓存读 / 写</dt>
        <dd>{formatTokens(usage.cacheRead)} / {formatTokens(usage.cacheWrite)}</dd>
      </dl>
      <h2>成本</h2>
      <dl>
        <dt>人民币</dt>
        <dd>{formatCurrency(cost.cnyMicroUnits, "CNY")}</dd>
        <dt>美元</dt>
        <dd>{formatCurrency(cost.usdMicroUnits, "USD")}</dd>
        {cost.unpricedTokens > 0 && (
          <>
            <dt>未计价 tokens</dt>
            <dd>{formatTokens(cost.unpricedTokens)}</dd>
          </>
        )}
      </dl>
      <BudgetSection sessionId={sessionId} running={running} onNotice={onNotice} />
      <PolicySection sessionId={sessionId} running={running} onNotice={onNotice} />
      {context.data.ledger.compacted && (
        <>
          <h2>压缩</h2>
          <dl>
            <dt>模式</dt>
            <dd>{{ toolcalls: "工具调用压缩", overview: "概览压缩", truncated: "规则截断" }[context.data.ledger.compacted.mode]}</dd>
            <dt>范围</dt>
            <dd>前 {context.data.ledger.compacted.uptoIndex} 条消息</dd>
            <dt>时间</dt>
            <dd>{new Date(context.data.ledger.compacted.createdAt).toLocaleString()}</dd>
            {context.data.ledger.compacted.instructions.length > 0 && (
              <>
                <dt>用户明确指令（累积）</dt>
                <dd>{context.data.ledger.compacted.instructions.map((item) => `· ${item}`).join("\n")}</dd>
              </>
            )}
          </dl>
        </>
      )}
      <h2>上下文条目</h2>
      {entries.length === 0 && !session?.messages.some((message) => message.role === "tool") && <p className="panel-empty">暂无条目。</p>}
      {entries.map((entry) => (
        <div className="context-entry" key={`${entry.messageId}-${entry.artifactId}`}>
          <span className={`entry-state entry-${entry.state}`}>{STATE_LABELS[entry.state] ?? entry.state}</span>
          <span className="entry-summary" title={entry.messageId}>{messageSummary(session, entry.messageId)}</span>
          {entry.state === "evicted" && (
            <button
              className="btn small"
              disabled={running}
              title={running ? "运行中不可恢复" : "恢复该条目到上下文"}
              onClick={() => {
                api.restoreContext(sessionId, entry.messageId)
                  .then(() => {
                    void queryClient.invalidateQueries({ queryKey: ["context", sessionId] });
                    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
                    onNotice("已恢复上下文条目");
                  })
                  .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "恢复失败", "error"));
              }}
            >
              恢复
            </button>
          )}
          {entry.state === "restored" && <>
            <button className="btn small" disabled={running} onClick={() => {
              const pinned = (entry.pinnedUntilRound ?? 0) > (context.data.ledger.round ?? 0);
              api.mutateContextEntry(sessionId, entry.messageId, pinned ? "unpin" : "pin")
                .then(() => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice(pinned ? "已取消固定" : "已固定条目"); })
                .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "操作失败", "error"));
            }}>{(entry.pinnedUntilRound ?? 0) > (context.data.ledger.round ?? 0) ? "取消固定" : "固定"}</button>
            <button className="btn small" disabled={running} onClick={() => {
              api.mutateContextEntry(sessionId, entry.messageId, "evict")
                .then(() => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice("已再次逐出条目"); })
                .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "逐出失败", "error"));
            }}>逐出</button>
          </>}
          <button className="btn small" onClick={() => {
            api.contextArtifact(sessionId, entry.artifactId)
              .then((value) => setArtifact({ id: entry.artifactId, content: value.content }))
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "原文读取失败", "error"));
          }}>原文</button>
        </div>
      ))}
      {session?.messages.filter((message) => message.role === "tool" && !entries.some((entry) => entry.messageId === message.id)).map((message) => (
        <div className="context-entry" key={message.id}>
          <span className="entry-state">保留</span>
          <span className="entry-summary" title={message.id}>{messageSummary(session, message.id)}</span>
          <button className="btn small" disabled={running} onClick={() => {
            api.mutateContextEntry(sessionId, message.id, "evict")
              .then(() => { void queryClient.invalidateQueries({ queryKey: ["context", sessionId] }); onNotice("已手动逐出条目"); })
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "逐出失败", "error"));
          }}>逐出</button>
        </div>
      ))}
      {artifact && (
        <details className="context-artifact" open>
          <summary>Artifact 原文 · {artifact.id}</summary>
          <pre className="mono">{artifact.content}</pre>
          <button className="btn small" onClick={() => setArtifact(undefined)}>关闭原文</button>
        </details>
      )}
    </div>
  );
}
