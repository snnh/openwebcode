import type { IconName } from "../components/Icon";
import type { SidebarView } from "./useWorkbenchLayout";

/** 侧栏视图元信息（桌面活动栏与移动端导航菜单共用） */
export const VIEW_META: Record<SidebarView, { zh: string; en: string; icon: IconName }> = {
  sessions: { zh: "会话", en: "Sessions", icon: "history" },
  files: { zh: "文件", en: "Files", icon: "folder" },
  scm: { zh: "源代码管理", en: "Source Control", icon: "git" },
  problems: { zh: "问题", en: "Problems", icon: "alert" },
};
