import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CostReport, ReportMetrics } from "../lib/contracts";
import { formatCurrency, formatTokens, formatTokensShort } from "../lib/format";
import { useI18n } from "../i18n";

type RangeKey = "7d" | "30d" | "all";

const RANGES: Array<{ key: RangeKey; zh: string; en: string }> = [
  { key: "7d", zh: "近 7 天", en: "Last 7 days" },
  { key: "30d", zh: "近 30 天", en: "Last 30 days" },
  { key: "all", zh: "全部", en: "All time" },
];

/** 表格按组（天/会话）分页的每页候选；默认 10 组 */
const PAGE_SIZES = [10, 20, 50] as const;

const pad = (value: number): string => String(value).padStart(2, "0");
const localKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function rangeParams(key: RangeKey): { from?: string; to?: string } {
  if (key === "all") return {};
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (key === "7d" ? 6 : 29));
  return { from: localKey(from), to: localKey(to) };
}

/** 行级缓存命中率（与 lib/cache-stats 同口径：cacheRead / (未缓存输入 + 缓存读取)）。 */
function rowHitRate(row: ReportMetrics): number | null {
  const total = row.inputTokens + row.cacheRead;
  return total > 0 ? row.cacheRead / total : null;
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

/** 缓存节省展示：按报表偏好币种取值，缺则回退另一币种（title 注明估算口径与不完整标记）。 */
function savingsCell(metrics: ReportMetrics, currency: "USD" | "CNY", t: (zh: string, en: string) => string): { label: string; title: string } | undefined {
  const savings = metrics.cacheSavings;
  if (!savings) return undefined;
  const preferred = currency === "CNY" ? savings.cnyMicroUnits : savings.usdMicroUnits;
  const fallback = currency === "CNY" ? savings.usdMicroUnits : savings.cnyMicroUnits;
  const microUnits = preferred ?? fallback;
  if (microUnits === undefined) return undefined;
  const shownCurrency = preferred !== undefined ? currency : (currency === "CNY" ? "USD" : "CNY");
  const label = `≈${formatCurrency(microUnits, shownCurrency)}${metrics.cacheSavingsIncomplete ? " *" : ""}`;
  const incomplete = metrics.cacheSavingsIncomplete
    ? t("；部分缓存读取无定价，估算不完整", "; some cached reads are unpriced, so the estimate is incomplete")
    : "";
  return {
    label,
    title: t(
      `缓存读取若按全价输入计费的差额（定价目录价差估算）${incomplete}`,
      `What the cached reads would have cost at full input price, minus the cache rate (pricing-catalog estimate)${incomplete}`,
    ),
  };
}

function providerLabel(provider: string, model: string): string {
  return model ? `${provider} · ${model}` : provider;
}

/** 组级分页器：‹ › 翻页 + 每页组数 + 总数；范围/页大小变化由调用方重置页码。 */
function Pager({ page, pageCount, pageSize, total, onPage, onPageSize, t }: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPage(page: number): void;
  onPageSize(size: number): void;
  t: (zh: string, en: string) => string;
}): ReactElement | null {
  if (total <= PAGE_SIZES[0]) return null;
  return (
    <div className="cost-pager">
      <button type="button" className="btn small" disabled={page <= 0} aria-label={t("上一页", "Previous page")} onClick={() => onPage(page - 1)}>‹</button>
      <span className="cost-pager-status">{t(`第 ${page + 1} / ${pageCount} 页 · 共 ${total} 组`, `Page ${page + 1} / ${pageCount} · ${total} groups`)}</span>
      <button type="button" className="btn small" disabled={page >= pageCount - 1} aria-label={t("下一页", "Next page")} onClick={() => onPage(page + 1)}>›</button>
      <select
        className="cost-pager-size"
        value={pageSize}
        aria-label={t("每页组数", "Groups per page")}
        onChange={(event) => onPageSize(Number(event.target.value))}
      >
        {PAGE_SIZES.map((size) => <option key={size} value={size}>{t(`每页 ${size}`, `${size} / page`)}</option>)}
      </select>
    </div>
  );
}

/** 组分页状态：range 或页大小变化回到第一页；组数收缩时钳制页码。 */
function useGroupPager(groupCount: number, resetKey: string): {
  page: number; pageCount: number; pageSize: number; from: number; to: number;
  setPage(page: number): void; setPageSize(size: number): void;
} {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  useEffect(() => { setPage(0); }, [resetKey, pageSize]);
  const pageCount = Math.max(1, Math.ceil(groupCount / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return { page: safePage, pageCount, pageSize, from: safePage * pageSize, to: Math.min(groupCount, (safePage + 1) * pageSize), setPage, setPageSize };
}

function HitCell({ row }: { row: ReportMetrics }): ReactElement {
  const rate = rowHitRate(row);
  return <td className="num">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</td>;
}

function DayTable({ report, currency, from, to }: { report: CostReport; currency: "USD" | "CNY"; from: number; to: number }): ReactElement {
  const { t } = useI18n();
  return (
    <div className="cost-table-scroll">
      <table className="pricing-table cost-table">
        <thead>
          <tr><th>{t("日期", "Date")}</th><th>{t("Provider · 模型", "Provider · Model")}</th><th className="num">{t("调用", "Calls")}</th><th className="num">{t("输入", "Input")}</th><th className="num">{t("输出", "Output")}</th><th className="num">{t("缓存读", "Cache read")}</th><th className="num">{t("缓存写", "Cache write")}</th><th className="num">{t("命中%", "Hit %")}</th><th className="num">{t("成本", "Cost")}</th></tr>
        </thead>
        <tbody>
          {report.days.slice(from, to).flatMap((day) => {
            const rows = day.providers.length > 0 ? day.providers : [{ provider: "—", model: "", ...day }];
            return rows.map((row, index) => {
              const cost = costCell(row, currency, t);
              return (
                <tr key={`${day.date}-${row.provider}-${row.model}`}>
                  {index === 0 && <td rowSpan={rows.length}>{day.date}</td>}
                  <td>{providerLabel(row.provider, row.model)}</td>
                  <td className="num">{formatTokens(row.runs)}</td>
                  <td className="num">{formatTokens(row.inputTokens)}</td>
                  <td className="num">{formatTokens(row.outputTokens)}</td>
                  <td className="num">{formatTokens(row.cacheRead)}</td>
                  <td className="num">{formatTokens(row.cacheWrite)}</td>
                  <HitCell row={row} />
                  <td className="num" title={cost.title}>{cost.label}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionTable({ report, currency, from, to }: { report: CostReport; currency: "USD" | "CNY"; from: number; to: number }): ReactElement {
  const { t } = useI18n();
  return (
    <div className="cost-table-scroll">
      <table className="pricing-table cost-table">
        <thead>
          <tr><th>{t("会话", "Session")}</th><th>{t("Provider · 模型", "Provider · Model")}</th><th className="num">{t("调用", "Calls")}</th><th className="num">{t("输入", "Input")}</th><th className="num">{t("输出", "Output")}</th><th className="num">{t("缓存读", "Cache read")}</th><th className="num">{t("缓存写", "Cache write")}</th><th className="num">{t("命中%", "Hit %")}</th><th className="num">{t("成本", "Cost")}</th></tr>
        </thead>
        <tbody>
          {report.sessions.slice(from, to).flatMap((session) => {
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
                  <td className="num">{formatTokens(row.runs)}</td>
                  <td className="num">{formatTokens(row.inputTokens)}</td>
                  <td className="num">{formatTokens(row.outputTokens)}</td>
                  <td className="num">{formatTokens(row.cacheRead)}</td>
                  <td className="num">{formatTokens(row.cacheWrite)}</td>
                  <HitCell row={row} />
                  <td className="num" title={cost.title}>{cost.label}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
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
  const dayCount = report.data?.days.length ?? 0;
  const sessionCount = report.data?.sessions.length ?? 0;
  const dayPager = useGroupPager(dayCount, `day-${range}`);
  const sessionPager = useGroupPager(sessionCount, `session-${range}`);

  // 命中率卡读数（totals 口径）；无缓存活动时整卡不渲染
  const totals = report.data?.totals;
  const hitRate = totals ? rowHitRate(totals) : null;
  const hasCacheActivity = Boolean(totals && (totals.cacheRead > 0 || totals.cacheWrite > 0));
  const savings = totals ? savingsCell(totals, report.data?.preferences.currency ?? "CNY", t) : undefined;

  // 组级行模型在数据/页码变化外不重建（30s 轮询同数据由 react-query 结构共享直接短路）
  const dayRange = useMemo(() => ({ from: dayPager.from, to: dayPager.to }), [dayPager.from, dayPager.to]);
  const sessionRange = useMemo(() => ({ from: sessionPager.from, to: sessionPager.to }), [sessionPager.from, sessionPager.to]);

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
              <b>{formatTokensShort(data.totals.inputTokens)} / {formatTokensShort(data.totals.outputTokens)}</b>
              <span className="cost-card-sub">{t("精确", "exact")} {formatTokens(data.totals.inputTokens)} / {formatTokens(data.totals.outputTokens)}</span>
            </div>
            {hasCacheActivity && hitRate !== null && (
              <div className="cost-card" data-testid="cache-hit-card">
                <span className="cost-card-label">{t("缓存命中", "Cache hit")}</span>
                <b>{Math.round(hitRate * 100)}%</b>
                <span className="cost-card-sub">{t(`读 ${formatTokensShort(data.totals.cacheRead)} · 写 ${formatTokensShort(data.totals.cacheWrite)}`, `read ${formatTokensShort(data.totals.cacheRead)} · write ${formatTokensShort(data.totals.cacheWrite)}`)}</span>
              </div>
            )}
            {savings && (
              <div className="cost-card" data-testid="cache-savings-card">
                <span className="cost-card-label">{t("缓存节省", "Cache savings")}</span>
                <b title={savings.title}>{savings.label}</b>
              </div>
            )}
          </div>
          <h2>{t("按日", "By day")}（{t(`${data.days.length} 天`, `${data.days.length} days`)}）</h2>
          <DayTable report={data} currency={currency} from={dayRange.from} to={dayRange.to} />
          <Pager page={dayPager.page} pageCount={dayPager.pageCount} pageSize={dayPager.pageSize} total={data.days.length} onPage={dayPager.setPage} onPageSize={dayPager.setPageSize} t={t} />
          <h2>{t("按会话", "By session")}（{t(`${data.sessions.length} 个`, `${data.sessions.length} sessions`)}）</h2>
          <SessionTable report={data} currency={currency} from={sessionRange.from} to={sessionRange.to} />
          <Pager page={sessionPager.page} pageCount={sessionPager.pageCount} pageSize={sessionPager.pageSize} total={data.sessions.length} onPage={sessionPager.setPage} onPageSize={sessionPager.setPageSize} t={t} />
        </>
      )}
    </div>
  );
}
