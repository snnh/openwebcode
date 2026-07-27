/**
 * `/init` 内置斜杠命令展开后的用户消息提示词。
 * app.ts 在消息入口拦截 `/init` 并用本文替换原文，随后走正常 agent.run() 路径，
 * 因此写 AGENTS.md 天然经过权限链与自动快照；生成后下一轮 buildMemorySection() 自动读取生效。
 */
export const INIT_COMMAND_PROMPT = `Analyze this workspace and create (or update) an AGENTS.md file at the workspace root. It is written for AI coding agents that will work in this repository and start with zero context.

Procedure:
1. Explore the repository: manifests and build files (package.json, CMakeLists.txt, Cargo.toml, go.mod, pyproject.toml, ...), directory layout, README/docs, CI configuration, and the main entry points. Do not read everything — sample enough to be accurate.
2. If AGENTS.md already exists, read it first: preserve accurate hand-written content, update outdated parts, and fill gaps. Do not discard user content wholesale.
3. Write AGENTS.md covering, in this order, each only as far as it is verifiable from the repository:
   - Project overview: what it is, architecture at one glance (one short paragraph or a small diagram).
   - Build and test commands: exact commands per component, including prerequisites (toolchain versions).
   - Code organization: the main directories/modules and their responsibilities.
   - Conventions and boundaries: coding style, testing conventions, commit conventions, and any hard rules an agent must not break.
4. Keep it concise and factual — aim for under 150 lines. Write everything in the same language as the repository's existing documentation (default to the language of its README).
5. Finish with a one-paragraph summary of what you wrote or changed.`;
