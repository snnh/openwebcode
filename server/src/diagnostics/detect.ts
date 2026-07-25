import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 项目类型检测 → 默认测试命令（0.4.0 Phase 3a）。
 * agent 传入的自定义命令优先；否则按 package.json → pyproject.toml → go.mod → *.sln 顺序检测。
 * host fs 直读 cwd（与 memory/CLAUDE.md 注入同一约定），读失败一律按不存在处理。
 */
export async function detectTestCommand(cwd: string): Promise<{ command: string; source: string } | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    if ("vitest" in deps) return { command: "npx vitest run", source: "package.json (vitest)" };
    const test = manifest.scripts?.test;
    if (test && !/no test specified/i.test(test)) return { command: "npm test", source: "package.json scripts.test" };
  } catch {
    // 无 package.json 或不可解析：继续检测下一类
  }
  try {
    await readFile(path.join(cwd, "pyproject.toml"), "utf8");
    return { command: "pytest", source: "pyproject.toml" };
  } catch {
    // 继续
  }
  try {
    await readFile(path.join(cwd, "go.mod"), "utf8");
    return { command: "go test ./...", source: "go.mod" };
  } catch {
    // 继续
  }
  try {
    const entries = await readdir(cwd);
    if (entries.some((entry) => entry.endsWith(".sln"))) return { command: "dotnet test", source: "*.sln" };
  } catch {
    // 继续
  }
  return undefined;
}
