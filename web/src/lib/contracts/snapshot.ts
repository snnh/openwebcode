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
}
