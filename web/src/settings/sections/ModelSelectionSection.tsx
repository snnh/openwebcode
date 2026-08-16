import type { ReactElement } from "react";
import { ServerSettingsFields } from "./ServerSettingsFields";
import { MODEL_SELECTION_GROUPS, MODELS_TAB_GROUPS } from "./shared";

/** 模型选择分组字段：渲染在「模型选择」页签（会话默认 + 四档角色 + 快速模型及 thinking/effort）。 */
export function ModelSelectionSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  return (
    <ServerSettingsFields
      showGroup={(groupId) => MODEL_SELECTION_GROUPS.has(groupId)}
      note={["会话默认模型、子代理角色与快速模型设置；子代理未指定角色时默认走平衡档。密钥仅脱敏显示；保存的密钥以明文存放在本机数据目录。", "Session default, sub-agent role, and fast model settings; sub-agents default to the balanced tier when no role is given. Secrets are masked here but stored as plain text in the local data directory."]}
      onDirtyChange={onDirtyChange}
    />
  );
}

/** 模型目录与同步分组字段：渲染在「模型目录」页签，与服务商配置、模型目录同区。 */
export function ModelCatalogSyncSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  return (
    <ServerSettingsFields
      showGroup={(groupId) => MODELS_TAB_GROUPS.has(groupId)}
      note={["远程模型目录同步设置。", "Remote model catalog sync settings."]}
      onDirtyChange={onDirtyChange}
    />
  );
}
