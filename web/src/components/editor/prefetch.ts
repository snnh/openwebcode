/**
 * 编辑器/差异视图的「意图预取」。
 *
 * 首次打开编辑器需要下载 Monaco（独立 chunk，约 4 MB，gzip 约 1 MB）与语言模式 chunk，
 * 这部分只能等用户点击后才开始下载。这里在用户**悬停或聚焦**「在编辑器中打开」入口时提前
 * 触发同样的动态 import（只做一次性预热，不创建编辑器实例），把首字节等待提前到点击之前。
 * 失败静默：真正打开时仍走原路径，错误照常展示。
 */

let warmed = false;

export function prefetchEditor(): void {
  if (warmed) return;
  warmed = true;
  void import("./EditorPane").catch(() => undefined);
  void import("./DiffPane").catch(() => undefined);
}
