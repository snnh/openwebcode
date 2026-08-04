import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { CostReport, ReportMetrics } from "../../lib/contracts";
import { formatCurrency, formatTokens } from "../../lib/format";
import { useI18n } from "../../i18n";

type RangeKey = "7d" | "30d" | "all";

const RANGES: Array<{ key: RangeKey; zh: string; en: string }> = [
  { key: "7d", zh: "近 7 天", en: "Last 7 days" },
  { key: "30d", zh: "近 30 天", en: "Last 30 days" },
  { key: "all", zh: "全部", en: "All time" },
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

function costCell(metrics: ReportMetrics, currency: "USD" | "CNY", t: (zh: string, en: string) => string): { label: string; title: string } {
  const usd = formatCurrency(metrics.usdMicroUnits, "USD");
  const cny = formatCurrency(metrics.cnyMicroUnits, "CNY");
  const unpriced = metrics.unpricedTokens > 0 ? t(`；另有 ${formatTokens(metrics.unpricedTokens)} tokens 未定价，成本不完整`, `; ${formatTokens(metrics.unpricedTokens)} additional tokens are unpriced, so cost is incomplete`) : "";
  return {
    label: `${currency === "CNY" ? cny : usd}${metrics.unpricedTokens > 0 ? " *" : ""}`,
    title: `USD ${usd} · CNY ${cny}${unpriced}`,
  };
}

function providerLabel(provider: string, model: string): string {
  return model ? `${provider} · ${model}` : provider;
}

function DayTable({ report, currency }: { report: CostReport; currency: "USD" | "CNY" }): ReactElement {
  const { t } = useI18n();
  return (
    <table className="pricing-table cost-table">
      <thead>
        <tr><th>{t("日期", "Date")}</th><th>{t("Provider · 模型", "Provider · Model")}</th><th>{t("调用", "Calls")}</th><th>{t("输入", "Input")}</th><th>{t("输出", "Output")}</th><th>{t("缓存读", "Cache read")}</th><th>{t("缓存写", "Cache write")}</th><th>{t("成本", "Cost")}</th></tr>
      </thead>
      <tbody>
        {report.days.flatMap((day) => {
          const rows = day.providers.length > 0 ? day.providers : [{ provider: "—", model: "", ...day }];
          return rows.map((row, index) => {
            const cost = costCell(row, currency, t);
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
  const { t } = useI18n();
  return (
    <table className="pricing-table cost-table">
      <thead>
        <tr><th>{t("会话", "Session")}</th><th>{t("Provider · 模型", "Provider · Model")}</th><th>{t("调用", "Calls")}</th><th>{t("输入", "Input")}</th><th>{t("输出", "Output")}</th><th>{t("缓存读", "Cache read")}</th><th>{t("缓存写", "Cache write")}</th><th>{t("成本", "Cost")}</th></tr>
      </thead>
      <tbody>
        {report.sessions.flatMap((session) => {
          const rows = session.providers.length > 0 ? session.providers : [{ provider: "—", model: "", ...session }];
          return rows.map((row, index) => {
            const cost = costCell(row, currency, t);
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
  const { t } = useI18n();
  const [range, setRange] = useState<RangeKey>("7d");
  const report = useQuery({
    queryKey: ["cost-report", range],
    queryFn: () => api.costReport(rangeParams(range)),
    refetchInterval: 30_000,
  });

  if (report.isPending) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("加载成本报表…", "Loading cost report…")}</p></div>;
  if (report.isError) {
    return <div className="inspector-body"><p className="panel-error" role="alert">{t("成本报表加载失败：", "Could not load cost report: ")}{report.error.message}</p></div>;
  }
  const data = report.data;
  const currency = data.preferences.currency;
  const total = costCell(data.totals, currency, t);

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
            {t(item.zh, item.en)}
          </button>
        ))}
      </div>
      {data.totals.runs === 0 ? (
        <p className="muted-empty panel-empty">{t("所选范围内还没有模型调用记录。", "There are no model calls in the selected range.")}</p>
      ) : (
        <>
          <div className="cost-cards">
            <div className="cost-card">
              <span className="cost-card-label">{t("成本", "Cost")}</span>
              <b title={total.title}>{total.label}</b>
            </div>
            <div className="cost-card">
              <span className="cost-card-label">{t("调用", "Calls")}</span>
              <b>{formatTokens(data.totals.runs)}</b>
            </div>
            <div className="cost-card">
              <span className="cost-card-label">{t("输入 / 输出", "Input / output")}</span>
              <b>{formatTokens(data.totals.inputTokens)} / {formatTokens(data.totals.outputTokens)}</b>
            </div>
            <div className="cost-card">
              <span className="cost-card-label">{t("缓存读 / 写", "Cache read / write")}</span>
              <b>{formatTokens(data.totals.cacheRead)} / {formatTokens(data.totals.cacheWrite)}</b>
            </div>
          </div>
          <h2>{t("按日", "By day")}</h2>
          <DayTable report={data} currency={currency} />
          <h2>{t("按会话", "By session")}</h2>
          <SessionTable report={data} currency={currency} />
        </>
      )}
    </div>
  );
}
