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

用户显式设置的 `OWC_DATA_DIR` 优先。未设置时，安装版启动器会注入默认目录（Windows `%LOCALAPPDATA%\openwebcode`；Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才以相对 `server` 目录的 `../.openwebcode` 作为启动/设置目录兜底。设置文件为 `<启动/设置目录>/server-settings.json`；其中保存的“数据目录”会在未设置 `OWC_DATA_DIR` 时于下次启动后决定业务数据目录。会话在 `<业务数据目录>/sessions/<id>/`；自定义路径建议使用绝对路径。详见 [usage.md 的配置文件位置表](./usage.md#配置文件位置)。

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

### Q: 为什么有些模型看不到或不能调用工具？

模型目录的 `tools` 能力开关决定本轮是否下发工具。关闭时，server 不会发送内置工具 schema、工具提示、MCP 工具、技能目录或后台任务通知，模型仍可正常聊天和输出方案；即使兼容 provider 异常返回 tool call，server 也会拒绝执行并把错误结果写入会话。需要文件操作、bash、子代理或 MCP 时，切换到标为支持 tools 的模型。

### Q: 为什么没有 `web_search`？

`web_search` 只在搜索服务可用时注入：Brave 需要有效 API key；自定义服务需要有效的 `http://` 或 `https://` endpoint。未设置、空 key、畸形地址或非 HTTP(S) 地址都会自动降级为不提供搜索工具，不影响普通对话和 `web_fetch`。

### Q: thinking / reasoning 模型怎么开？

支持 thinking 的模型在输入框上方有「思考」开关与程度选择器（low/medium/high）。Anthropic 翻译为 `thinking.budget_tokens`，OpenAI 系翻译为 `reasoning_effort`。思考块默认折叠，完成后随消息持久化，思考 token 计入成本。

### Q: 对话支持 Markdown 和数学公式吗？

支持。正文与思考块都支持 GFM Markdown（表格、任务列表、删除线、代码块等）；行内公式写 `$...$`，块级公式写成独占一段的 `$$...$$`，由 KaTeX 渲染。思考块默认折叠且颜色比正文更浅。

### Q: 缓存命中省钱吗？

Anthropic 显式 `cache_control` 断点（系统提示词后、驱逐边界后、倒数第二轮用户消息后），命中后 cacheRead 价格通常是输入价的 0.1 倍。OpenAI 系自动缓存，无需配置。成本报表里「缓存读」分项可见。

## 权限与沙盒

### Q: ask / acceptEdits / yolo 有什么区别？

- `ask`（默认）：每个写操作弹权限卡片，你逐个 allow/deny
- `acceptEdits`：文件编辑类自动放行，bash 等仍需确认
- `yolo`：全部自动放行——**但沙盒仍生效**（yolo 与沙盒是两个正交机制）

`总是允许` 会生成持久规则（如精确的 `bash(npm test)`），随会话保存。

### Q: 「允许一次」和「总是允许」有什么区别？

「允许一次」只恢复当前这一项工具调用，不写权限规则；「总是允许」需要二次确认，并把当前工具及参数规则保存到会话。两者都会先完成批准接口响应，再开始工具执行，避免浏览器等待审批响应时被长命令拖住。

Windows 默认 AppContainer 会话使用 `cmd.exe`。如果批准后立即出现“不是内部或外部命令”，通常是模型生成了 PowerShell/POSIX 语法；改用 `dir`、`type`、`where` 等 cmd 命令，或显式调用已安装的 shell。

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

### Q: 怎么调整上下文驱逐与压缩？

打开底部「上下文」面板，可热切换 `lag`（滚动）、`interval`（定期批量）或 `off`（仅手动），并修改保留轮数、回写保护轮数与回写预算。面板也提供两种压缩按钮、逐条驱逐/恢复/pin 和 artifact 原文查看。会话运行中这些写操作会暂时禁用，避免与 agent 构建上下文竞态。

## 快照与回滚

会话头部的「快照」开关支持两种模式：「每轮自动」会在每次提交用户消息前创建检查点；「仅手动」不会自动创建，但仍可在时间线面板中随时新建检查点。模式按会话保存。

### Q: 检查点什么时候自动打？

默认在每轮用户消息前自动打一个（label=消息摘要前 80 字符）；切到「仅手动」模式后不再自动创建。手动打点：时间线面板「新建」按钮（或 `POST /api/sessions/:id/checkpoints`）。

### Q: 回滚会丢会话历史吗？

默认丢——文件 + 会话历史同步截断到对应消息。点「仅文件」按钮可只恢复文件、保留对话历史。账本随检查点一并回退。

### Q: 托管工作区是什么？什么时候用？

项目活在 VHDX（Windows）/ qcow2（Linux）稀疏镜像盘挂载点上，快照走差分链——毫秒级、可再分支。适合：

- 频繁回滚、想分支试验
- 不可信代码（配合 WSB 或容器）
- 想隔离多个工作区

代价：挂载需管理员权限（Windows Hyper-V Administrators 组 / Linux root helper），链长 >32 自动合并最老段。

## 子代理与扩展

### Q: 四个官方扩展分别做什么？

- `context-manager` 默认启用，承载滚动驱逐与上下文管理界面
- `attention-optimizer` 默认关闭，通过复制关键引用建立注意力锚区，不移动原消息
- `content-lens` 默认关闭，提供旁路翻译与划词解析；需要 provider2，结果不会进入上下文账本
- `pdf-to-image` 默认启用，Web 选择的 PDF 会先保存到当前工作区 `.owc/uploads/`，再将最多 4 页以 150 DPI、最长边 2048px 转为图片附件；停用后仅把这个工作区相对路径引用发送给主代理

它们可在「设置 → 扩展」启停和编辑配置。Extension Host 是独立子进程，单个钩子最多运行 5 秒。第三方 v1 扩展不是安全沙盒，只有信任其代码和权限声明时才安装。

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

默认每次创建新会话。`--session <id>` 复用已有会话（续聊）。会话 id 从 web UI 或 `<业务数据目录>/sessions/` 目录名取。

### Q: Windows 下 `owc run` 报找不到命令？

源码目录不会自动把 `owc` 加入 `PATH`。可用 `node server/dist/cli.js run ...` 直接运行，或使用发布版/打包生成的启动器。

## 故障排查

### Q: Linux 的 `install.sh` 会在 CI 或脚本里等输入吗？

不会。只有 stdin/stdout 都是 TTY 且没有传 `--yes` 时才会询问配置；重定向、管道和 CI 会直接使用默认值或命令行提供的值。自动化安装应显式传 `--yes`，例如：

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3000 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

`--prefix`、`--data-dir` 必须是绝对路径，端口必须在 1–65535。`--use-system-node` 会在安装时校验 PATH 中的 Node.js 20+；运行时 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 可覆盖安装时默认值。若指定非回环 `--host`，当前版本没有内置 HTTP 鉴权，只应在受信网络或认证反向代理后使用。

### Q: 启动后浏览器打不开 / 连接被拒？

- 确认 `owc` 进程在跑（`ps aux | grep owc` 或任务管理器）
- 确认端口未被占用、未被防火墙拦
- 默认监听 `127.0.0.1`；远程访问需设置 `OWC_HOST=0.0.0.0`（注意：当前无内置鉴权，仅建议在可信内网使用）

### Q: WebSocket 断线重连后事件丢失？

不会。重连时带 `after=<lastSeq>` 参数补拉。仅当 `after` 早于服务端历史缓冲区最旧事件（默认保留 1000 条）时返回 `resync.required`，客户端走 REST 全量重取。

### Q: 模型定价新增时报 `effectiveFrom must be a valid YYYY-MM-DD date`？

新版表单在币种后有「生效日期」，默认当天。若看不到该字段，说明浏览器仍加载旧前端：先重启 OpenWebCode，再用 `Ctrl+F5` 强制刷新；从源码或 staging 更新时确认 `web/dist/index.html` 指向最新哈希资源。缓存读/写留空会按 `0` 保存，输入/输出单价必须填写。

### Q: core（C 执行器）崩溃了怎么办？

core-client 自动重启（指数退避，≤3 次），重启后广播 error 并标记运行中工具失败。频繁崩溃看 `<业务数据目录>/logs/` 里的 core stderr。

### Q: 沙盒导致某些命令失败？

AppContainer 下 git 凭据管理器、部分 GUI 程序、需要特殊权限的工具可能异常。会话头部沙盒徽标点开看策略，或切到 `Job Object` 兼容兜底模式（会话设置中切换沙盒模式）。

### Q: 后台任务在 Linux 上 kill 后子进程还在？

已知限制。Windows Job Object `KILL_ON_JOB_CLOSE` 能杀尽孙进程树；Linux posix kill 后孙进程可能孤儿化（core 主进程被杀但孙进程未被进程组一起收掉）。建议后台任务用 `setsid` 或 `nohup` 包一层。

## 反馈与贡献

- 问题反馈：GitHub Issues
- 开发文档：`docs/`（本地，不随 git 同步——包含内部设计、实施阶段、交接记录）
- 用户文档：`help/`（本目录，随 git 同步）
