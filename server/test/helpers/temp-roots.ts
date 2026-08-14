import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

/** rm 带重试：agent/hook 子进程（cmd.exe 被 SIGKILL 后 node 变孤儿）的 cwd 锁住临时目录，
 * Windows 上文件句柄释放滞后导致 ENOTEMPTY，需等进程退出后重试。 */
async function rmWithRetry(target: string, retries = 15, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const roots: Array<{ path: string; retry: boolean }> = [];

// 模块加载时注册（vitest 只认收集期注册的 hook，测试体内注册会被静默丢弃）。
// afterEach 为 LIFO：import 本模块早于测试文件正文里的 afterEach，故文件级
// 清理（如 app.close()）先跑，临时目录清理最后跑。
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) =>
    // 普通路径也带短重试：测试结尾触发的异步 run（如无 provider 立即失败的那种）
    // 在清理时可能仍在写会话文件，直接 rm 会撞 ENOTEMPTY（Linux 同有此竞态）；
    // retry 标记的重试窗口留给 agent/hook 子进程锁目录的长尾场景。
    root.retry ? rmWithRetry(root.path) : rmWithRetry(root.path, 6, 200))),
);

/**
 * mkdtemp 到系统临时目录并登记 afterEach 递归清理（Windows ENOTEMPTY 竞态惯例）。
 * 每个测试文件使用自己的 prefix。
 */
export async function tempRoot(prefix = "owc-test-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push({ path: root, retry: false });
  return root;
}

/** 同 tempRoot，但 afterEach 清理走 rmWithRetry（hooks/agent 落盘竞态场景）。 */
export async function tempRootRetry(prefix = "owc-test-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push({ path: root, retry: true });
  return root;
}
