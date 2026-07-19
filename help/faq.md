# 常见问题（FAQ）

## 通用

### Q: 关闭浏览器标签页后，agent 还在跑吗？

**在跑。** 服务器端继续执行，结果照常落盘。重新打开 UI 选回该会话，断线期间的事件自动补拉回来。

要主动停作业：顶部「中断」按钮，或 `POST /api/sessions/:id/abort`。只有退出 server 进程才收尾全部会话与后台任务。

### Q: 端口 3000 被占用怎么办？

设置环境变量 `OWC_PORT=4000` 后启动 `owc`（launcher 脚本默认 3000，server 自身兜底 3210）。

### Q: 支持 Windows / Linux / macOS 吗？

Windows 与 Linux 原生支持（沙盒分别走 AppContainer/Landlock）。macOS 暂无原生沙盒后端，可以跑但沙盒为 advisory 降级（UI 会警示）。

### Q: 数据存在哪里？

默认 `~/.openwebcode/`（Windows 为 `%USERPROFILE%\.openwebcode\`）。会话在 `sessions/<id>/`，配置在 `config.json`。详见 [usage.md 的配置文件位置表](./usage.md#配置文件位置)。

### Q: 如何升级？

Windows：重新下载 MSI 双击安装（major upgrade 原地升级，用户数据保留）。Linux：重新解压 tar.gz 覆盖安装目录。卸载保留用户数据，可选全删。

## 模型与 Provider

### Q: 支持哪些 LLM provider？

Anthropic（Claude）与 OpenAI 兼容协议（DeepSeek/Qwen/Ollama/GLM 等皆可）。设置页配置 baseUrl + apiKey 即可。

### Q: 模型列表是空的 / 刷新不出来？

- 检查 baseUrl 与 apiKey 是否正确
- 部分 provider（如 Ollama 本地）不实现 `/v1/models`，可直接手填模型 id（如 `qwen2.5-coder:14b`），上下文窗口/定价等元数据可后补
- 拉取失败不阻塞使用，保守默认 + UI 提示完善

### Q: 会话中途能换模型吗？

能。输入框上方模型选择器随时切换，下轮生效。账本按新模型上下文窗口重算；若新模型不支持图片而历史里有图片，那些图片会替换为占位描述。

### Q: thinking / reasoning 模型怎么开？

支持 thinking 的模型在输入框上方有「思考」开关与程度选择器（low/medium/high）。Anthropic 翻译为 `thinking.budget_tokens`，OpenAI 系翻译为 `reasoning_effort`。思考块默认折叠，思考 token 计入成本。

### Q: 缓存命中省钱吗？

Anthropic 显式 `cache_control` 断点（系统提示词后、驱逐边界后、倒数第二轮用户消息后），命中后 cacheRead 价格通常是输入价的 0.1 倍。OpenAI 系自动缓存，无需配置。成本报表里「缓存读」分项可见。

## 权限与沙盒

### Q: ask / acceptEdits / yolo 有什么区别？

- `ask`（默认）：每个写操作弹权限卡片，你逐个 allow/deny
- `acceptEdits`：文件编辑类自动放行，bash 等仍需确认
- `yolo`：全部自动放行——**但沙盒仍生效**（yolo 与沙盒是两个正交机制）

`总是允许` 会生成持久规则（如 `bash(npm test:*)`），随会话保存。

### Q: yolo 了还会被沙盒拦吗？

会。yolo 只跳过权限确认，沙盒（AppContainer/Landlock）照常约束文件读写与网络。要完全解除沙盒需在会话创建时将沙盒模式设为 `off`（不推荐）。

### Q: agent 要写沙盒外的路径怎么办？

沙盒拒绝（EACCES）→ 错误结果回填 LLM → LLM 看到拒绝后通常会换个路径或告知用户。如果需要放宽沙盒范围，在会话设置里切换沙盒模式（如 `off`）或调整工作目录。

### Q: 跑不可信代码怎么配置？

Windows：会话创建选 `WSB` 沙盒模式——一会话一 VM，关闭即蒸发，仅工作目录留存。Linux：用托管工作区（qcow2）+ Landlock，或直接在容器里跑。

## 上下文管理

### Q: 上下文满了怎么办？

三层防御自动介入：

1. **结果预算截断**：bash 输出 8k、read 16k、grep 4k，超出截断 + artifact 指针
2. **滚动驱逐**：默认 lag=1，每轮完成即把 N-1 轮的 toolcall 压成一行占位符（`[tool: bash "npm test" → exit 0, 2.1k tokens, artifact:a3f2]`），全量落盘 artifacts/
3. **85% 水位强制压缩**：provider2 做结构化概览摘要

手动介入：`/compact`（概览摘要）/ `/compact tools`（toolcalls 精炼）/ `/clear`（清视图留历史）。

### Q: 驱逐掉的内容还能找回来吗？

能。右侧「上下文用量」面板的条目列表中，已逐出条目旁有「恢复」按钮（或 `POST /api/sessions/:id/context/restore`），把 artifact 全文恢复到 LLM 视图。前端渲染始终用全量历史，不受驱逐影响。

### Q: `/clear` 会丢历史吗？

不会。`/clear` 只清空当前 LLM 视图，messages.jsonl 全量保留，账本记 `cleared` 边界。回滚检查点会同步回退清空界。

### Q: provider2 是什么？必须配置吗？

provider2 是快速廉价的辅助模型，做压缩/标题生成/翻译等旁路任务。**非必须**——不配置时压缩走纯规则截断+占位，概览压缩不可用并提示。配一个便宜的（haiku/deepseek-chat）体验更好。

## 快照与回滚

### Q: 检查点什么时候自动打？

每轮用户消息前自动打一个（label=消息摘要前 80 字符）。手动打点：时间线面板「新建」按钮（或 `POST /api/sessions/:id/checkpoints`）。

### Q: 回滚会丢会话历史吗？

默认丢——文件 + 会话历史同步截断到对应消息。点「仅文件」按钮可只恢复文件、保留对话历史。账本随检查点一并回退。

### Q: 托管工作区是什么？什么时候用？

项目活在 VHDX（Windows）/ qcow2（Linux）稀疏镜像盘挂载点上，快照走差分链——毫秒级、可再分支。适合：

- 频繁回滚、想分支试验
- 不可信代码（配合 WSB 或容器）
- 想隔离多个工作区

代价：挂载需管理员权限（Windows Hyper-V Administrators 组 / Linux root helper），链长 >32 自动合并最老段。

## 子代理与扩展

### Q: 子代理能写文件吗？

v1 不能。`SUB_AGENT_TOOL_NAMES` 只放行 `read_file/glob/grep/read_artifact` 四件只读工具。自定义子代理 frontmatter 声明的写工具会被忽略并在清单附注。这是有意限制——子代理是探索用途，写操作回主循环走完整权限链。

### Q: Hooks 安全吗？

**Hooks 配置等同 yolo。** `.owc/hooks.json` 里的 command 由 server 直接 spawn 执行，不经沙盒与权限链。凡是能写 hooks 配置的人即拥有等同 yolo 的执行能力。只在自己信任的项目里配 hooks，不要在共享/不可信仓库里启用。

### Q: MCP 工具能写文件吗？

能。MCP 工具按 `mcp__<server>__<tool>` 命名注入，走与内置工具相同的权限链（默认 ask）。plan 模式下 v1 一律拦截所有 mcp__ 工具（无法判定读写性）。

## CLI 与脚本集成

### Q: `owc run` 怎么在 CI 里用？

```sh
owc run "跑测试并修复失败的用例" --cwd . --yolo --json | tee events.ndjson
```

- `--yolo`：权限请求自动 allow（CI 不能交互）
- `--json`：NDJSON 事件流，便于解析
- 退出码：`0` 完成 / `1` agent 错误 / `2` 权限拒绝（非 `--yolo` 时遇到权限请求即退出）

### Q: `owc run` 会创建新会话吗？

默认每次创建新会话。`--session <id>` 复用已有会话（续聊）。会话 id 从 web UI 或 `~/.openwebcode/sessions/` 目录名取。

### Q: Windows 下 `owc run` 报找不到命令？

`packaging/owc.cmd` 被 `.gitignore` 忽略（`*.cmd` 规则），从源码直接跑时可能缺失。用 `node server/dist/cli.js run ...` 替代，或从 Releases 下载已打包的发行版。

## 故障排查

### Q: 启动后浏览器打不开 / 连接被拒？

- 确认 `owc` 进程在跑（`ps aux | grep owc` 或任务管理器）
- 确认端口未被占用、未被防火墙拦
- 默认监听 `127.0.0.1`；远程访问需设置 `OWC_HOST=0.0.0.0`（注意：当前无内置鉴权，仅建议在可信内网使用）

### Q: WebSocket 断线重连后事件丢失？

不会。重连时带 `after=<lastSeq>` 参数补拉。仅当 `after` 早于服务端历史缓冲区最旧事件（默认保留 1000 条）时返回 `resync.required`，客户端走 REST 全量重取。

### Q: core（C 执行器）崩溃了怎么办？

core-client 自动重启（指数退避，≤3 次），重启后广播 error 并标记运行中工具失败。频繁崩溃看 `~/.openwebcode/logs/` 里的 core stderr。

### Q: 沙盒导致某些命令失败？

AppContainer 下 git 凭据管理器、部分 GUI 程序、需要特殊权限的工具可能异常。会话头部沙盒徽标点开看策略，或切到 `Job Object` 兼容兜底模式（会话设置中切换沙盒模式）。

### Q: 后台任务在 Linux 上 kill 后子进程还在？

已知限制。Windows Job Object `KILL_ON_JOB_CLOSE` 能杀尽孙进程树；Linux posix kill 后孙进程可能孤儿化（core 主进程被杀但孙进程未被进程组一起收掉）。建议后台任务用 `setsid` 或 `nohup` 包一层。

## 反馈与贡献

- 问题反馈：GitHub Issues
- 开发文档：`docs/`（本地，不随 git 同步——包含内部设计、实施阶段、交接记录）
- 用户文档：`help/`（本目录，随 git 同步）
