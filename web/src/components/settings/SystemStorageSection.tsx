import type { ReactElement } from "react";
import { ServerSettingsFields } from "./ServerSettingsFields";
import { INFO_TAB_GROUPS } from "./shared";

/** 执行器/存储/更新检查分组字段：渲染在「服务信息」页签（系统级参数）。 */
export function SystemStorageSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  return (
    <ServerSettingsFields
      showGroup={(groupId) => INFO_TAB_GROUPS.has(groupId)}
      note={["执行器、存储与更新检查等系统级参数；密钥仅脱敏显示。", "System-level executor, storage, and update-check options. Secrets are masked here."]}
      onDirtyChange={onDirtyChange}
    />
  );
}
