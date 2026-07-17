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
    if (block.type === "text" && block.text?.trim()) {
      const text = block.text.trim().replace(/\s+/g, " ");
      return text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
  }
  return messageId;
}

function BudgetSection({ sessionId, running, onNotice }: {
  sessionId: string;
  running: boolean;
  onNotice(message: string): void;
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
      onNotice("Token 上限必须为正整数");
      return;
    }
    if (cost && (!/^\d+(\.\d+)?$/.test(cost) || Number(cost) <= 0)) {
      onNotice("成本上限必须为正数");
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
      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "预算更新失败"))
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
  onNotice(message: string): void;
}): ReactElement {
  const queryClient = useQueryClient();
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
      <h2>上下文条目</h2>
      {entries.length === 0 && <p className="panel-empty">暂无条目。</p>}
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
                  .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "恢复失败"));
              }}
            >
              恢复
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
