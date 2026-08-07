import type { ReactElement } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import type { ProcessFoldProps } from "./types";

/**
 * 过程消息连续段的折叠组（会话空闲时）：原生 <details> 语义，默认折叠，
 * 内容常驻 DOM（会话内搜索仍命中）。failed 时组头标红提示段内有失败工具结果。
 */
export function ProcessFold({ toolCalls, failed, children }: ProcessFoldProps): ReactElement {
  const { t } = useI18n();
  return (
    <details className={`turn-process${failed ? " danger" : ""}`}>
      <summary>
        <Icon name="list" size={12} />
        {toolCalls > 0
          ? t(`执行过程 · ${toolCalls} 个工具调用`, `Process · ${toolCalls} tool calls`)
          : t("执行过程 · 思考", "Process · reasoning")}
      </summary>
      <div className="turn-process-body">{children}</div>
    </details>
  );
}
