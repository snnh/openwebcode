// 视图级懒加载（React.lazy）的 Suspense 兜底：整页切换期间的轻量加载态。
import type { ReactElement } from "react";
import { useI18n } from "../i18n";

export function LoadingFallback(): ReactElement {
  const { t } = useI18n();
  return <div className="muted-empty" role="status">{t("加载中…", "Loading…")}</div>;
}
