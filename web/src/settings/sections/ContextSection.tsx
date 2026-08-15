import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { ServerSettingsFields } from "./ServerSettingsFields";

/** 「上下文」页签：自动压缩水位 + agent 运行参数（server context 组）。 */
export function ContextSection({ onDirtyChange }: {
  onDirtyChange?(dirty: boolean): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <>
      <p className="settings-note">
        {t(
          "上下文占用达到水位时自动压缩（核心安全网，不随扩展开关）；建议压缩水位低 15 个百分点。滚动驱逐、上下文条目管理与选择性上下文由「上下文节省」扩展提供，开关在「扩展」页签。",
          "The context is compacted automatically when usage reaches the threshold (a core safety net, independent of extensions); the recommendation threshold is 15 points lower. Rolling eviction, context entries, and selective context are provided by the Context Saver extension, toggled in the Extensions tab.",
        )}
      </p>
      <ServerSettingsFields
        showGroup={(groupId) => groupId === "context"}
        onDirtyChange={onDirtyChange}
      />
    </>
  );
}
