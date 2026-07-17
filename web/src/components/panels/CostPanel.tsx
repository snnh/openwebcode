import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { CostReport, ReportMetrics } from "../../lib/contracts";
import { formatCurrency, formatTokens } from "../../lib/format";

type RangeKey = "7d" | "30d" | "all";

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "all", label: "全部" },
];

const pad = (value: number): string => String(value).padStart(2, "0");
const localKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function rangeParams(key: RangeKey): { from?: string; to?: string } {
  if (key === "all") return {};
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (key === "7d" ? 6 : 29));
  return { from: localKey(from), to: localKey(to) };
}

function costCell(metrics: ReportMetrics, currency: "USD" | "CNY"): { label: string; title: string } {
  const usd = formatCurrency(metrics.usdMicroUnits, "USD");
  const cny = formatCurrency(metrics.cnyMicroUnits, "CNY");
  const unpriced = metrics.unpricedTokens > 0 ? `；另有 ${formatTokens(metrics.unpricedTokens)} tokens 未定价，成本不完整` : "";
  return {
    label: `${currency === "CNY" ? cny : usd}${metrics.unpricedTokens > 0 ? " *" : ""}`,
    title: `USD ${usd} · CNY ${cny}${unpriced}`,
  };
}

function providerLabel(provider: string, model: string): string {
  return model ? `${provider} · ${model}` : provider;
}

function DayTable({ report, currency }: { report: CostReport; currency: "USD" | "CNY" }): ReactElement {
  return (
    <table className="pricing-table cost-table">
      <thead>
        <tr><th>日期</th><th>Provider · 模型</th><th>调用</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>成本</th></tr>
      </thead>
      <tbody>
        {report.days.flatMap((day) => {
          const rows = day.providers.length > 0 ? day.providers : [{ provider: "—", model: "", ...day }];
          return rows.map((row, index) => {
            const cost = costCell(row, currency);
            return (
              <tr key={`${day.date}-${row.provider}-${row.model}`}>
                {index === 0 && <td rowSpan={rows.length}>{day.date}</td>}
                <td>{providerLabel(row.provider, row.model)}</td>
                <td>{formatTokens(row.runs)}</td>
                <td>{formatTokens(row.inputTokens)}</td>
                <td>{formatTokens(row.outputTokens)}</td>
                <td>{formatTokens(row.cacheRead)}</td>
                <td>{formatTokens(row.cacheWrite)}</td>
                <td title={cost.title}>{cost.label}</td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

function SessionTable({ report, currency }: { report: CostReport; currency: "USD" | "CNY" }): ReactElement {
  return (
    <table className="pricing-table cost-table">
      <thead>
        <tr><th>会话</th><th>Provider · 模型</th><th>调用</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>成本</th></tr>
      </thead>
      <tbody>
        {report.sessions.flatMap((session) => {
          const rows = session.providers.length > 0 ? session.providers : [{ provider: "—", model: "", ...session }];
          return rows.map((row, index) => {
            const cost = costCell(row, currency);
            return (
              <tr key={`${session.sessionId}-${row.provider}-${row.model}`}>
                {index === 0 && (
                  <td rowSpan={rows.length} title={session.sessionId}>
                    {session.title ?? `${session.sessionId.slice(0, 8)}…`}
                  </td>
                )}
                <td>{providerLabel(row.provider, row.model)}</td>
                <td>{formatTokens(row.runs)}</td>
                <td>{formatTokens(row.inputTokens)}</td>
                <td>{formatTokens(row.outputTokens)}</td>
                <td>{formatTokens(row.cacheRead)}</td>
                <td>{formatTokens(row.cacheWrite)}</td>
                <td title={cost.title}>{cost.label}</td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

/** 全局成本报表：按日/按会话聚合，含 provider 与缓存读写分项；数据来自 server 的 usage-events 日志。 */
export function CostPanel(): ReactElement {
  const [range, setRange] = useState<RangeKey>("7d");
  const report = useQuery({
    queryKey: ["cost-report", range],
    queryFn: () => api.costReport(rangeParams(range)),
    refetchInterval: 30_000,
  });

  if (report.isPending) return <div className="inspector-body"><p className="panel-empty">加载成本报表…</p></div>;
  if (report.isError) {
    return <div className="inspector-body"><p className="panel-empty">成本报表加载失败：{report.error.message}</p></div>;
  }
  const data = report.data;
  const currency = data.preferences.currency;
  const total = costCell(data.totals, currency);

  return (
    <div className="inspector-body cost-panel">
      <div className="cost-toolbar">
        {RANGES.map((item) => (
          <button
            key={item.key}
            className={`btn small${range === item.key ? " primary" : ""}`}
            aria-pressed={range === item.key}
            onClick={() => setRange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {data.totals.runs === 0 ? (
        <p className="panel-empty">所选范围内还没有模型调用记录。</p>
      ) : (
        <>
          <div className="cost-cards">
            <div className="cost-card">
              <span className="cost-card-label">成本</span>
              <b title={total.title}>{total.label}</b>
            </div>
            <div className="cost-card">
              <span className="cost-card-label">调用</span>
              <b>{formatTokens(data.totals.runs)}</b>
            </div>
            <div className="cost-card">
              <span className="cost-card-label">输入 / 输出</span>
              <b>{formatTokens(data.totals.inputTokens)} / {formatTokens(data.totals.outputTokens)}</b>
            </div>
            <div className="cost-card">
              <span className="cost-card-label">缓存读 / 写</span>
              <b>{formatTokens(data.totals.cacheRead)} / {formatTokens(data.totals.cacheWrite)}</b>
            </div>
          </div>
          <h2>按日</h2>
          <DayTable report={data} currency={currency} />
          <h2>按会话</h2>
          <SessionTable report={data} currency={currency} />
        </>
      )}
    </div>
  );
}
