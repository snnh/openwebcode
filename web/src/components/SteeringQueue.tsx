import type { ReactElement } from "react";
import type { QueueItem } from "../lib/contracts";
import { useI18n } from "../i18n";

export function SteeringQueue({ items, onRemove }: {
  items: QueueItem[];
  onRemove(itemId: string): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div className="steering-queue">
      <b>{t("运行队列", "Run queue")}</b>
      {(["steer", "follow_up"] as const).map((kind) => <section key={kind}><small>{kind === "steer" ? t("下一轮纠偏", "Next-turn steering") : t("完成后续跑", "After completion")}</small>{items.filter((item) => item.kind === kind && item.status === "queued").map((item, index) => (
        <div key={item.id}><span>{index + 1}</span><p title={item.content}>{item.content}</p><button onClick={() => onRemove(item.id)} title={t("撤销", "Remove")} aria-label={t("撤销", "Remove")}>{t("撤销", "Remove")}</button></div>
      ))}</section>)}
    </div>
  );
}
