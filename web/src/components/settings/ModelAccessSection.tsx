import type { ReactElement } from "react";
import { ServerSettingsFields } from "./ServerSettingsFields";
import { MODELS_TAB_GROUPS } from "./shared";

/** 模型选择/模型目录与同步分组字段：渲染在「模型目录」页签，与服务商配置、模型目录同区。 */
export function ModelAccessSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  return (
    <ServerSettingsFields
      showGroup={(groupId) => MODELS_TAB_GROUPS.has(groupId)}
      note={["模型选择与远程目录同步设置。密钥仅脱敏显示；保存的密钥以明文存放在本机数据目录。", "Model selection and remote catalog sync settings. Secrets are masked here but stored as plain text in the local data directory."]}
      onDirtyChange={onDirtyChange}
    />
  );
}
