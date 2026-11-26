export type SnapshotMode = "auto" | "manual";

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
  /** 创建检查点时的活动叶子；旧检查点可能缺失。 */
  activeLeafId?: string;
}

export interface SnapshotCapabilityInfo {
  backend: string;
  costHint: "instant" | "linear";
  requiresAdmin: boolean;
  detail?: string;
  /** 是否支持逐个删除检查点；缺省 true（差分链后端为 false）。 */
  supportsDelete?: boolean;
}
