import os from "node:os";
import path from "node:path";

/**
 * Linux 部署以 systemd / Docker 等最小环境为基准适配：这类环境常不带 HOME
 * （或 PATH 不含用户级 bin），而子进程都依赖它——沙盒/持久 shell 的 ~/.bashrc
 *（uv 安装器写入的 `. "$HOME/.local/bin/env"` 在 HOME 为空时展开成 `/.local/bin/env`
 * 报错且 PATH 追加失效）、git 读 ~/.git-credentials、uv/fnm 的用户级安装位置。
 * 启动时把 HOME 补齐为 passwd 记录的真实家目录（os.homedir() 在 HOME 未设时
 * POSIX 回落 getpwuid），后续所有 spawn 经 process.env 继承，一处修复全局生效。
 * POSIX only：Windows 的 home 语义走 USERPROFILE，贸然设 HOME 会改变 Git Bash 等
 * 子进程行为。
 */
export function ensureHomeEnv(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") return;
  if (env.HOME) return;
  const home = homedir();
  if (home) env.HOME = home;
}

/**
 * 版本管理器（uv/fnm 等）的常见绝对安装位置候选：最小环境里 PATH 不含用户级
 * bin（systemd unit、env -i、非登录 shell 拉起的服务），PATH 查找失败时按序回退
 * 探测。POSIX only（Windows 返回空数组，调用方保持原报错路径）。
 */
export function wellKnownBinPaths(
  command: string,
  homedir: () => string = os.homedir,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") return [];
  const home = homedir();
  // 目标平台是 POSIX，统一按 POSIX 分隔符拼接（测试在 Windows 上注入 POSIX 平台时同样成立）
  const candidates = [
    // uv 官方安装器默认 ~/.local/bin；经 cargo 安装的在 ~/.cargo/bin
    ...(home ? [path.posix.join(home, ".local", "bin", command), path.posix.join(home, ".cargo", "bin", command)] : []),
    path.posix.join("/usr/local/bin", command),
    path.posix.join("/usr/bin", command),
  ];
  if (platform === "darwin") candidates.push(path.posix.join("/opt/homebrew/bin", command));
  return candidates;
}
