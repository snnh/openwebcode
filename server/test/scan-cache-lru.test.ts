import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents.js";
import { SkillRegistry } from "../src/skills.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 目录扫描缓存条数上限（skills.ts / agents.ts 同款常量）。 */
const MAX_CACHED_DIRS = 64;

/** 运行时可达的私有扫描缓存（private 只在类型层面隐藏）。 */
function cacheOf(registry: SkillRegistry | AgentRegistry): Map<string, unknown> {
  return (registry as unknown as { scanCache: Map<string, unknown> }).scanCache;
}

/** 项目级技能目录路径（与 SkillRegistry.scan 的键一致）。 */
function skillDir(cwd: string): string {
  return path.join(cwd, ".owc", "skills");
}

/** 项目级 agent 目录路径（与 AgentRegistry.scan 的键一致）。 */
function agentDir(cwd: string): string {
  return path.join(cwd, ".owc", "agents");
}

async function writeSkill(cwd: string, index: number): Promise<void> {
  const dir = path.join(skillDir(cwd), `skill-${index}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: skill-${index}\ndescription: d${index}\n---\nbody-${index}\n`, "utf8");
}

async function writeAgent(cwd: string, index: number): Promise<void> {
  const dir = agentDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `agent-${index}.md`), `---\nname: agent-${index}\ndescription: d${index}\n---\nbody-${index}\n`, "utf8");
}

/** 造 count 个项目 cwd（各写一个技能/agent 定义）。 */
async function makeProjects(root: string, count: number, seed: (cwd: string, index: number) => Promise<void>): Promise<string[]> {
  const cwds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const cwd = path.join(root, `proj-${index}`);
    await mkdir(cwd, { recursive: true });
    await seed(cwd, index);
    cwds.push(cwd);
  }
  return cwds;
}

/**
 * LRU 场景（skills/agents 同款实现同款断言）：
 * 逐个扫描到封顶 → 回访最旧目录刷新热度 → 再扫一个新目录。
 * 期望：缓存条数始终封顶，被逐出的是「最久未访问」的那个，而不是刚回访过的。
 */
async function expectLruBounded(
  registry: { listFor(cwd: string): Promise<unknown[]>; find(cwd: string, name: string): Promise<unknown> },
  cache: Map<string, unknown>,
  dirOf: (cwd: string) => string,
  cwds: string[],
  newCwd: string,
  probeName: string,
): Promise<void> {
  for (const cwd of cwds) await registry.listFor(cwd);
  expect(cache.size).toBe(MAX_CACHED_DIRS); // 按目录常驻的老行为：这里本该有 65 份正文全文
  // 回访第一个目录：命中也要刷新热度（先 delete 再 set → 回到 Map 队尾）
  await registry.listFor(cwds[0]!);
  expect(cache.size).toBe(MAX_CACHED_DIRS);
  // 再扫一个新目录：逐出最久未访问的第二个目录（第一份因刚回访而留驻）
  await registry.listFor(newCwd);
  expect(cache.size).toBe(MAX_CACHED_DIRS);
  expect(cache.has(dirOf(cwds[0]!))).toBe(true);
  expect(cache.has(dirOf(cwds[1]!))).toBe(false);
  // 逐出只是丢缓存：重新访问仍从磁盘正确重建（不因 LRU 丢定义）
  expect(await registry.find(cwds[1]!, probeName)).toMatchObject({ name: probeName });
}

describe("目录扫描缓存的 LRU 上限", () => {
  it("SkillRegistry：超过 64 个目录逐出最久未访问者，命中刷新热度", async () => {
    const root = await tempRoot("owc-skill-lru-");
    // 全局目录刻意不存在：scan 读不到即不落缓存，缓存里只剩项目目录，条数断言更直接
    const registry = new SkillRegistry(path.join(root, "no-such-global"));
    const cwds = await makeProjects(root, MAX_CACHED_DIRS, writeSkill);
    const fresh = path.join(root, "proj-fresh");
    await mkdir(fresh, { recursive: true });
    await writeSkill(fresh, 999);
    await expectLruBounded(registry, cacheOf(registry), skillDir, cwds, fresh, "skill-1");
  });

  it("AgentRegistry：超过 64 个目录逐出最久未访问者，命中刷新热度", async () => {
    const root = await tempRoot("owc-agent-lru-");
    const registry = new AgentRegistry(path.join(root, "no-such-global"));
    const cwds = await makeProjects(root, MAX_CACHED_DIRS, writeAgent);
    const fresh = path.join(root, "proj-fresh");
    await mkdir(fresh, { recursive: true });
    await writeAgent(fresh, 999);
    await expectLruBounded(registry, cacheOf(registry), agentDir, cwds, fresh, "agent-1");
  });

  it("扫描结果仍按指纹热更新：目录内容变化后立即反映，未变化时命中缓存", async () => {
    const root = await tempRoot("owc-skill-hot-");
    const registry = new SkillRegistry(path.join(root, "no-such-global"));
    const cwd = path.join(root, "proj");
    await mkdir(cwd, { recursive: true });
    await writeSkill(cwd, 0);
    expect((await registry.listFor(cwd)).map((entry) => (entry as { name: string }).name)).toEqual(["skill-0"]);
    // 新增一个技能：指纹变化 → 重扫，缓存被替换而非累加
    await writeSkill(cwd, 1);
    expect((await registry.listFor(cwd)).map((entry) => (entry as { name: string }).name)).toEqual(["skill-0", "skill-1"]);
    expect(cacheOf(registry).size).toBe(1);
  });
});
