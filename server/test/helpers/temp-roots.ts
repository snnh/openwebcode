import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const roots: string[] = [];
let registered = false;

/**
 * mkdtemp 到系统临时目录并登记 afterEach 递归清理（Windows ENOTEMPTY 竞态惯例）。
 * 每个测试文件使用自己的 prefix；afterEach 在首次调用时注册一次。
 */
export async function tempRoot(prefix = "owc-test-"): Promise<string> {
  if (!registered) {
    registered = true;
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
  }
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
