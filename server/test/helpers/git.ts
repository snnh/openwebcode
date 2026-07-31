import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CoreClientLike } from "../../src/core-client.js";

const execFileAsync = promisify(execFile);

/** 真实 git 执行器（注入 ScmService.exec；生产默认走 Core job）。 */
export async function realGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

/** 假 core：仅用于未注入 exec 时的构造路径，这些用例都注入真实 git。 */
export function unusedCore(): CoreClientLike {
  const core = { on() { return core; } } as unknown as CoreClientLike;
  return core;
}

/** 初始化单文件 git 仓库（main 分支，a.txt 初始提交），返回 repo 路径。 */
export async function initGitRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await realGit(["init", "-b", "main", repo], root);
  await realGit(["config", "user.email", "test@example.com"], repo);
  await realGit(["config", "user.name", "Test"], repo);
  await realGit(["config", "commit.gpgsign", "false"], repo);
  await realGit(["config", "core.autocrlf", "false"], repo);
  await writeFile(path.join(repo, "a.txt"), "hello\n");
  await realGit(["add", "a.txt"], repo);
  await realGit(["commit", "-m", "initial"], repo);
  return repo;
}
