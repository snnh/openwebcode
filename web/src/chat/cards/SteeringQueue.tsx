import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import type { SteeringQueueProps } from "../types";

/** 运行队列条：按 kind 分组（下一轮纠偏 / 完成后续跑），仅展示 queued 条目，可逐条撤销。 */
export function SteeringQueue({ items, onRemove }: SteeringQueueProps): ReactElement {
  const { t } = useI18n();
  return (
    <div className="steering-queue">
      <b>{t("运行队列", "Run queue")}</b>
      {(["steer", "follow_up"] as const).map((kind) => (
        <section key={kind}>
          <small>{kind === "steer" ? t("下一轮纠偏", "Next-turn steering") : t("完成后续跑", "Run after")}</small>
          {items.filter((item) => item.kind === kind && item.status === "queued").map((item, index) => (
            <div key={item.id} className="steering-queue-item">
              <span className="steering-queue-item-index">{index + 1}</span>
              <p className="steering-queue-item-content" title={item.content}>{item.content}</p>
              <button className="steering-queue-item-remove" onClick={() => onRemove(item.id)} title={t("撤销", "Remove")} aria-label={t("撤销", "Remove")}>{t("撤销", "Remove")}</button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
