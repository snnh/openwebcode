import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

/** rm 带重试：agent/hook 子进程（cmd.exe 被 SIGKILL 后 node 变孤儿）的 cwd 锁住临时目录，
 * Windows 上文件句柄释放滞后导致 ENOTEMPTY，需等进程退出后重试。 */
export async function rmWithRetry(target: string, retries = 15, delayMs = 500): Promise<void> {
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

const roots: string[] = [];
let registered = false;

/**
 * 同 temp-roots.tempRoot，但 afterEach 清理走 rmWithRetry（hooks/agent 落盘竞态场景）。
 * 每个测试文件使用自己的 prefix；afterEach 在首次调用时注册一次。
 */
export async function tempRootRetry(prefix = "owc-test-"): Promise<string> {
  if (!registered) {
    registered = true;
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rmWithRetry(root))));
  }
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 写项目级 <cwd>/.owc/hooks.json */
export async function writeProjectHooks(cwd: string, config: unknown): Promise<void> {
  await mkdir(path.join(cwd, ".owc"), { recursive: true });
  await writeFile(path.join(cwd, ".owc", "hooks.json"), JSON.stringify(config), "utf8");
}
