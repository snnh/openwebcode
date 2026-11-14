import type { CoreClientLike } from "../core-client.js";
import type { SandboxMode } from "../sessions/types.js";

/**
 * 创建/切换会话时预检沙盒后端可用性：失败前移到用户做决定的时刻，
 * 而不是首次执行命令时由 core 以 exit 126 报错。
 *
 * 仅检查能可靠探测的后端：
 * - bubblewrap：core.info.features.bwrap.available
 * - landlock：core.info.features.landlock.available（旧 core 未上报时不阻塞）
 * - wsb：validateSandboxMode 已用 detectWsb 检查
 * - appcontainer/jobobject/off：无额外探测
 *
 * 测试注入的简版 core 可能没有 ping：此时跳过预检，不伪造失败。
 */
export async function validateSandboxRuntime(mode: SandboxMode | undefined, core: Pick<CoreClientLike, "ping">): Promise<string | undefined> {
  if (!mode || mode === "off" || mode === "appcontainer" || mode === "jobobject") return undefined;
  if (typeof core.ping !== "function") return undefined;
  let info: Awaited<ReturnType<CoreClientLike["ping"]>>;
  try {
    info = await core.ping();
  } catch {
    return `sandboxMode ${mode} 不可用：无法连接执行器以确认沙盒能力`;
  }
  if (mode === "bubblewrap") {
    const bwrap = info?.features?.bwrap;
    // 旧 core 未上报 features.bwrap：不阻塞创建，执行期仍由 core fail closed。
    if (bwrap && !bwrap.available) {
      return `sandboxMode bubblewrap 不可用：${bwrap.reason ?? "请安装 bubblewrap 或显式选择 off"}`;
    }
    return undefined;
  }
  if (mode === "landlock") {
    const landlock = info?.features?.landlock;
    // 旧 core 未上报 features.landlock：不阻塞创建，执行期由 core fail closed。
    if (landlock && !landlock.available) {
      return `sandboxMode landlock 不可用：${landlock.reason ?? "内核缺少 Landlock 支持，请改用 bubblewrap 或 off"}`;
    }
  }
  return undefined;
}
