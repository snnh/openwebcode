import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// tempRootRetry 已收口到 temp-roots.ts；此处再导出以保留既有 import 路径。
export { tempRootRetry } from "./temp-roots.js";

/** 写项目级 <cwd>/.owc/hooks.json */
export async function writeProjectHooks(cwd: string, config: unknown): Promise<void> {
  await mkdir(path.join(cwd, ".owc"), { recursive: true });
  await writeFile(path.join(cwd, ".owc", "hooks.json"), JSON.stringify(config), "utf8");
}
