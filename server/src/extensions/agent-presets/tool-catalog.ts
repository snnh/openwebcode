import type { PresetToolGroup, PresetToolInfo } from "./types.js";

/** 精简模式编辑器展示的内置工具目录。运行时装配另有用例断言实际工具名不超出本表。 */
export const PRESET_TOOLS: PresetToolInfo[] = [
  { name: "bash", label: "执行命令", labelEn: "Run command", group: "core", description: "Execute a shell command in the session workspace.", required: true, defaultEnabled: true },
  { name: "read_file", label: "读取文件", labelEn: "Read file", group: "core", description: "Read UTF-8 lines from a workspace file.", defaultEnabled: true },
  { name: "edit_file", label: "精确编辑文件", labelEn: "Edit file", group: "core", description: "Replace exact text in a UTF-8 workspace file.", defaultEnabled: true },
  { name: "web_search", label: "联网搜索", labelEn: "Web search", group: "web", description: "Search the web using the configured search provider.", optional: true, defaultEnabled: true },
  { name: "web_fetch", label: "抓取网页", labelEn: "Fetch URL", group: "web", description: "Fetch a public http/https URL and return readable text.", optional: true, defaultEnabled: true },
  { name: "read_media", label: "读取图片/视频", labelEn: "Read media", group: "media", description: "Read an image or video file and attach it for the model.", optional: true, defaultEnabled: true },
  { name: "ask_user", label: "向用户提问", labelEn: "Ask user", group: "interaction", description: "Ask structured questions mid-run and wait for answers.", defaultEnabled: true },
  { name: "git_status", label: "Git 状态", labelEn: "Git status", group: "git", description: "Show the git working-tree status." },
  { name: "git_diff", label: "Git 差异", labelEn: "Git diff", group: "git", description: "Show the git diff." },
  { name: "git_commit", label: "Git 提交", labelEn: "Git commit", group: "git", description: "Create a git commit." },
  { name: "git_worktree_create", label: "创建工作树", labelEn: "Create worktree", group: "git", description: "Create an isolated git worktree." },
  { name: "git_worktree_remove", label: "移除工作树", labelEn: "Remove worktree", group: "git", description: "Remove a session worktree." },
  { name: "git_worktree_merge", label: "合并工作树", labelEn: "Merge worktree", group: "git", description: "Merge a session worktree branch." },
  { name: "repo_map", label: "仓库地图", labelEn: "Repo map", group: "analysis", description: "Summarize the workspace repository structure." },
  { name: "code_search", label: "符号搜索", labelEn: "Symbol search", group: "analysis", description: "Search the workspace symbol index." },
  { name: "test_runner", label: "运行测试", labelEn: "Run tests", group: "analysis", description: "Run the project test suite." },
  { name: "subagent", label: "子代理", labelEn: "Sub-agent", group: "orchestration", description: "Launch a sub-agent with an isolated context." },
  { name: "spawn_swarm", label: "并行子代理", labelEn: "Parallel sub-agents", group: "orchestration", description: "Launch parallel sub-agents.", optional: true },
  { name: "task_output", label: "后台任务输出", labelEn: "Task output", group: "orchestration", description: "Read the output of a background task.", optional: true },
  { name: "task_stop", label: "停止后台任务", labelEn: "Stop task", group: "orchestration", description: "Stop a running background task.", optional: true },
  { name: "todo_write", label: "待办清单", labelEn: "Todo list", group: "workflow", description: "Replace the session task list." },
  { name: "remember", label: "写入记忆", labelEn: "Remember", group: "workflow", description: "Remember a fact when the user asks." },
  { name: "load_skill", label: "加载技能", labelEn: "Load skill", group: "workflow", description: "Load the full text of a skill.", optional: true },
  { name: "cron_create", label: "创建定时任务", labelEn: "Create cron job", group: "workflow", description: "Schedule a prompt.", optional: true },
  { name: "cron_list", label: "列出定时任务", labelEn: "List cron jobs", group: "workflow", description: "List scheduled cron jobs.", optional: true },
  { name: "cron_delete", label: "删除定时任务", labelEn: "Delete cron job", group: "workflow", description: "Delete a scheduled cron job.", optional: true },
  { name: "write_file", label: "写入文件", labelEn: "Write file", group: "core", description: "Atomically write a UTF-8 workspace file.", advancedOnly: true },
  { name: "glob", label: "文件通配", labelEn: "Glob files", group: "analysis", description: "List workspace files matching a wildcard pattern.", advancedOnly: true },
  { name: "grep", label: "文本搜索", labelEn: "Search text", group: "analysis", description: "Recursively search workspace files for literal text.", advancedOnly: true },
  { name: "read_artifact", label: "读取截断产物", labelEn: "Read artifact", group: "analysis", description: "Read a bounded slice of a tool-output artifact.", optional: true, advancedOnly: true },
];

export const PRESET_TOOL_NAMES: string[] = PRESET_TOOLS.map((tool) => tool.name);

/** UI 组定义：默认开仅 core/web/media/interaction。 */
export const PRESET_TOOL_GROUPS: PresetToolGroup[] = [
  { id: "core", label: "基础工具", labelEn: "Core", tools: ["bash", "read_file", "edit_file"], defaultEnabled: true },
  { id: "web", label: "联网", labelEn: "Web", tools: ["web_search", "web_fetch"], defaultEnabled: true },
  { id: "media", label: "媒体", labelEn: "Media", tools: ["read_media"], defaultEnabled: true },
  { id: "interaction", label: "交互", labelEn: "Interaction", tools: ["ask_user"], defaultEnabled: true },
  { id: "git", label: "Git", labelEn: "Git", tools: ["git_status", "git_diff", "git_commit", "git_worktree_create", "git_worktree_remove", "git_worktree_merge"], defaultEnabled: false },
  { id: "analysis", label: "代码分析", labelEn: "Analysis", tools: ["repo_map", "code_search", "test_runner"], defaultEnabled: false },
  { id: "orchestration", label: "子代理与后台任务", labelEn: "Sub-agents & tasks", tools: ["subagent", "spawn_swarm", "task_output", "task_stop"], defaultEnabled: false },
  { id: "workflow", label: "工作流", labelEn: "Workflow", tools: ["todo_write", "remember", "load_skill", "cron_create", "cron_list", "cron_delete"], defaultEnabled: false },
  { id: "external", label: "扩展与 MCP", labelEn: "Extensions & MCP", tools: [], defaultEnabled: false },
];
