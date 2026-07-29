# 常见问题（FAQ）

## 通用

### Q: 关闭浏览器标签页后，agent 还在跑吗？

**在跑。** 服务器端继续执行，结果照常落盘。重新打开 UI 选回该会话，断线期间的事件自动补拉回来。

要主动停作业：顶部「中断」按钮，或 `POST /api/sessions/:id/abort`。只有退出 server 进程才收尾全部会话与后台任务。

### Q: 端口 3000 被占用怎么办？

设置环境变量 `OWC_PORT=4000` 后启动 `owc`（launcher 脚本默认 3000，server 自身兜底 3210）。

### Q: 支持 Windows / Linux / macOS 吗？

Windows 与 Linux 原生支持（沙盒分别走 AppContainer/Landlock）。macOS 暂不支持。

### Q: 数据存在哪里？

用户显式设置的 `OWC_DATA_DIR` 优先。未设置时，安装版启动器会注入默认目录（Windows `%LOCALAPPDATA%\openwebcode`；Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才以相对 `server` 目录的 `../.openwebcode` 作为启动/设置目录兜底。设置文件为 `<启动/设置目录>/server-settings.json`；其中保存的“数据目录”会在未设置 `OWC_DATA_DIR` 时于下次启动后决定业务数据目录。会话在 `<业务数据目录>/sessions/<id>/`；自定义路径建议使用绝对路径。详见 [usage.md 的配置文件位置表](./usage.md#配置文件位置)。

### Q: 如何升级？

Windows：重新下载 MSI 双击安装（major upgrade 原地升级，用户数据保留）。Linux：重新解压 tar.gz 覆盖安装目录。卸载保留用户数据，可选全删。

### Q: 怎么知道有没有新版本？

设置 → **服务信息** 会显示当前 Server/Core 版本。启用设置 → **服务信息 → 更新检查** 后，服务会周期性查询 GitHub Releases 并在「服务信息」静默提示最新版本与下载链接（默认关闭，不发起外部请求）；发现新版本时通知中心也会出现按版本去重的提醒条目，点击直达服务信息。命令行可用 `owc --version` 查看服务版本。发现新版本后可直接在设置页一键在线更新；Linux 也可用一行命令完成安装/更新：`curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash`。

### Q: 能自定义系统提示词吗？

可以。设置 → **提示词** 可覆盖内置基线并追加自定义指令；项目级 `<cwd>/.owc/system-prompt.md` 覆盖全局。注意提示词不是安全边界——plan 模式、权限与沙箱由服务独立强制，不会因提示词而放开。

### Q: 升级后我的设置会被覆盖吗？

不会。默认配置随安装目录 `config/defaults.json` 更新，数据目录的 `server-settings.json` 只保存你改过的项；启动时按「环境变量 > 你的覆盖 > 安装默认」自动组合。你没改过的项会采用新默认，改过的项保留；若某项的安装默认发生变化，设置页会提示「采纳新默认」。

### Q: 如何分叉或重新生成一段对话？

会话历史是树形存储，旧分支消息始终保留。悬停任意一条用户消息会出现三个操作：**编辑重发**（内容回填输入框，发送后从该处另起分支）、**重新生成**（直接回退到该条重跑）、**分叉**（复制到该条为止的对话进新会话）。时间线面板顶部的会话树展示全部消息节点（非活动分支淡化），悬停节点也可「从此处继续」或「分叉」为新会话。详见 [usage.md 的右侧面板一节](./usage.md#右侧面板)。

### Q: 下载的发布包怎么校验完整性？

每个 GitHub Release 附带 `SHA256SUMS.txt`（MSI 与 tar.gz 的 SHA-256 校验和）。Linux：`sha256sum --check SHA256SUMS.txt`；Windows：`Get-FileHash <msi> -Algorithm SHA256` 后与文件内对应值比对。一行在线安装脚本（`install-online.sh`）会自动下载并校验，失败即中止。详见 [usage.md 的版本号与更新检查](./usage.md#版本号与更新检查) 与 [packaging/README.md](../packaging/README.md#在线安装与更新)。

## 模型与 Provider

### Q: 支持哪些 LLM provider？

支持 Anthropic Messages 与 OpenAI Chat Completions 两种接口类型（DeepSeek/Qwen/Ollama/GLM 等兼容端点均可）。设置页可保存多个具名服务商配置，逐个选择接口类型、Base URL、API Key 和是否启用；每个已启用服务商的模型会合并显示为 `模型ID【服务商】`。

### Q: 模型列表是空的 / 刷新不出来？

- 检查服务商是否已启用，以及接口类型、Base URL 与 API Key 是否正确
- 用服务商表单里的「测试连接」按钮快速定位：错误会按认证失败、URL 错误、无法连接、限流分类给出中文提示（5 秒超时）
- 部分 provider（如 Ollama 本地）不实现 `/v1/models`，可直接手填模型 id（如 `qwen2.5-coder:14b`），上下文窗口/定价等元数据可后补
- 拉取失败不阻塞使用，保守默认 + UI 提示完善

### Q: 会话中途能换模型吗？

能。输入框下方会话配置行的模型选择器随时切换，下轮生效。账本按新模型上下文窗口重算；若目标模型不支持当前思考模式/强度，界面会在同一次切换中自动清除不兼容值。若新模型不支持图片而历史里有图片，那些图片会替换为占位描述。

### Q: 为什么有些模型看不到或不能调用工具？

模型目录的 `tools` 能力开关决定本轮是否下发工具。关闭时，server 不会发送内置工具 schema、工具提示、MCP 工具、技能目录或后台任务通知，模型仍可正常聊天和输出方案；即使兼容 provider 异常返回 tool call，server 也会拒绝执行并把错误结果写入会话。需要文件操作、bash、子代理或 MCP 时，切换到标为支持 tools 的模型。

### Q: 为什么没有 `web_fetch` 或 `web_search`？

联网工具不会默认注入，避免模型在未配置服务时反复调用必然失败的工具。先在「设置 → 模型目录 → 联网服务商」保存一个或多个配置；每项声明 Search / Fetch 能力，再分别选择当前配置。Jina 和 Tavily 支持两项能力（Tavily Fetch 使用 Extract API），Brave 仅支持 Search，Custom 可自行声明能力且 Fetch URL 必须含 `{url}`。未选择对应能力时不会提供该工具或提示词，不影响普通对话。

`https://mcp.tavily.com/mcp/?tavilyApiKey=...` 是 Tavily 的远程 MCP 地址；如需直接使用 Tavily MCP 的完整工具集，请把它写到 `<业务数据目录>/mcp.json`，不要填进搜索 Base URL。

### Q: thinking / reasoning 模型怎么开？

支持 reasoning 的模型在输入框下方有合并后的「思考」选择器，可直接选关闭、自适应或模型声明的强度。Anthropic 翻译为 `thinking.budget_tokens`，OpenAI 系翻译为 `reasoning_effort`。思考块默认折叠，完成后随消息持久化，思考 token 计入成本。

### Q: 对话支持 Markdown 和数学公式吗？

支持。正文与思考块都支持 GFM Markdown（表格、任务列表、删除线、代码块等）；行内公式写 `$...$`，块级公式写成独占一段的 `$$...$$`，由 KaTeX 渲染。思考块默认折叠且颜色比正文更浅。

### Q: agent 运行报错（认证失败 / 限流 / 过载）怎么办？

错误事件会分类为 authentication / permission / not_found / invalid_request / rate_limit / overloaded，运行错误卡按类型给出可操作提示，并附设置深链按钮（认证/接口问题直达「模型目录」）。限流、过载等可重试错误会提供「重试」按钮，一键重发上一条用户消息；toast 只显示一行摘要，完整信息看错误卡。

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

Windows 默认 AppContainer 会话使用 `cmd.exe`。如果批准后立即出现“不是内部或外部命令”，通常是模型生成了 PowerShell/POSIX 语法；可在会话头部把命令后端切到 `PowerShell 7`（需安装 `pwsh`），或改用 `dir`、`type`、`where` 等 cmd 命令。

### Q: yolo 了还会被沙盒拦吗？

会。yolo 只跳过权限确认，沙盒（AppContainer/Landlock）照常约束文件读写与网络。要完全解除沙盒需在会话创建时将沙盒模式设为 `off`（不推荐）。

### Q: agent 要写沙盒外的路径怎么办？

沙盒拒绝（EACCES）→ 错误结果回填 LLM → LLM 看到拒绝后通常会换个路径或告知用户。如果需要放宽沙盒范围，在会话设置里切换沙盒模式（如 `off`）或调整工作目录。

### Q: 跑不可信代码怎么配置？

Windows：会话创建选 `WSB` 沙盒模式——一会话一 VM，关闭即蒸发，仅工作目录留存。Linux：用托管工作区（qcow2）+ Landlock，或直接在容器里跑。

## 上下文管理

### Q: 上下文满了怎么办？

会话头部实时显示窗口占用（`45k/128k · 38%`，≥70% 变黄、≥85% 变红）与缓存命中；上下文面板顶部「上下文窗口」区可查看分段 token 归因与水位提示。接近上限时三层防御自动介入：

1. **结果预算截断**：bash 输出 8k、read 16k、grep 4k，超出截断 + artifact 指针
2. **滚动驱逐**：默认 lag=1，每轮完成即把 N-1 轮的 toolcall 压成一行占位符（`[tool: bash "npm test" → exit 0, 2.1k tokens, artifact:a3f2]`），全量落盘 artifacts/
3. **85% 水位强制压缩**：快速模型做结构化概览摘要

手动介入：`/compact`（概览摘要）/ `/compact tools`（toolcalls 精炼）/ `/clear`（清视图留历史）。

### Q: 驱逐掉的内容还能找回来吗？

能。右侧「上下文用量」面板的条目列表中，已逐出条目旁有「恢复」按钮（或 `POST /api/sessions/:id/context/restore`），把 artifact 全文恢复到 LLM 视图。前端渲染始终用全量历史，不受驱逐影响。

### Q: `/clear` 会丢历史吗？

不会。`/clear` 只清空当前 LLM 视图，messages.jsonl 全量保留，账本记 `cleared` 边界。回滚检查点会同步回退清空界。

### Q: 快速模型是什么？必须配置吗？

快速模型是用于压缩、标题生成、翻译等旁路任务的低延迟模型。它直接从已启用服务商的统一模型目录选择，并复用该服务商的接口、Base URL 与密钥；设置页可单独配置 thinking、effort 和最大输出上限。**非必须**——不配置时压缩走纯规则截断+占位，概览压缩不可用并提示。选择一个便宜、响应快的模型体验更好。

### Q: 怎么调整上下文驱逐与压缩？

打开底部「上下文」面板，可热切换 `lag`（滚动）、`interval`（定期批量）或 `off`（仅手动），并修改保留轮数、回写保护轮数与回写预算。面板也提供两种压缩按钮、逐条驱逐/恢复/pin 和 artifact 原文查看。会话运行中这些写操作会暂时禁用，避免与 agent 构建上下文竞态。

## 快照与回滚

会话头部的「快照」开关支持两种模式：「每轮自动」会在每次提交用户消息前创建检查点；「仅手动」不会自动创建，但仍可在时间线面板中随时新建检查点。模式按会话保存。

### Q: 检查点什么时候自动打？

默认在每轮用户消息前自动打一个（label=消息摘要前 80 字符）；切到「仅手动」模式后不再自动创建。手动打点：时间线面板「新建」按钮（或 `POST /api/sessions/:id/checkpoints`）。

### Q: 回滚会丢会话历史吗？

默认丢——文件 + 会话历史同步截断到对应消息。点「仅文件」按钮可只恢复文件、保留对话历史。账本随检查点一并回退。

### Q: 托管工作区是什么？什么时候用？

项目活在 VHDX（Windows）/ qcow2（Linux）稀疏镜像盘挂载点上，快照走差分链——毫秒级、可再分支。Windows 的 VHDX 以不含点号的目录名挂载在源工作目录旁边（例如 `work-openwebcode-<会话ID>`），镜像文件和链状态仍保存在 OpenWebCode 私有数据目录。适合：

- 频繁回滚、想分支试验
- 不可信代码（配合 WSB 或容器）
- 想隔离多个工作区

代价：挂载需管理员权限（Windows Hyper-V Administrators 组 / Linux root helper）。为避免在仍挂载的差分祖先链上执行破坏性合并，当前每个托管工作区最多保留 32 个检查点；达到上限会明确拒绝新建而不会损坏已有链。

## 子代理与扩展

### Q: 六个官方扩展分别做什么？

- `context-manager` 默认启用，承载滚动驱逐与上下文管理界面
- `attention-optimizer` 默认关闭，通过复制关键引用建立注意力锚区，不移动原消息
- `content-lens` 默认关闭，提供旁路翻译与划词解析；需要快速模型，结果不会进入上下文账本
- `pdf-to-image` 默认启用，Web 选择的 PDF 会先保存到当前工作区 `.owc/uploads/`，再将最多 4 页以 150 DPI、最长边 2048px 转为图片附件；停用后仅把这个工作区相对路径引用发送给主代理
- `owc-eval` 默认关闭，提供内置回归评测面板；固定 mock 任务在隔离工作区回放，运行报告和基线/候选对比均可归档为 JSON，不使用用户的模型 API Key
- `env-sim`（环境模拟）默认关闭，启用并选择预设后系统提示词与内置工具命名切换为该产品风格（如 `Read`/`Bash`/`Edit`），底层仍走原工具实现与权限链；内置 `claude-code`/`kimi-code`/`zcode`/`codex` 四档预设

它们可在「设置 → 扩展」启停和编辑配置。Extension Host 是独立子进程，单个钩子最多运行 5 秒。第三方 v1 扩展不是安全沙盒，只有信任其代码和权限声明时才安装。

### Q: 子代理能写文件吗？

分类型。内置 `explore`（默认）与自定义 markdown 子代理是只读的，只放行 `read_file/glob/grep/read_artifact`；内置 `general` 是可写通用子代理——文件读写、bash、test_runner 都可用，但每次工具调用仍走与主代理相同的权限链与沙盒（`spawn_task agent=general prompt="..."`）。自定义子代理 frontmatter 声明的写工具会被忽略并在清单附注。详见 [usage.md 的子代理一节](./usage.md#自定义扩展点)。

### Q: 怎么手动启动一个子代理？explore 和 general 选哪个？

底部面板「子代理」标签页顶部可手动启动：填任务描述并选择类型。选 `explore`（默认）做只读探索——查代码、找引用、总结结构，不会动任何文件；选 `general` 派发可写任务——能改文件、跑 bash，但每次操作仍弹权限卡（ask 模式下）并受沙盒约束。主窗口的子代理标签页以与主对话相同的渲染展示完整转录；中断 agent 会同时取消手动启动的子代理。详见 [usage.md 的子代理一节](./usage.md#自定义扩展点)。

### Q: 环境模拟（env-sim）预设怎么用？能自制吗？

设置 → **扩展** 启用 `env-sim` 并在其配置里选择预设：系统提示词与内置工具的命名/描述即切换为该产品风格，底层实现与权限链不变。自制预设：把预设 JSON（必填 `id`/`name`/`identity`/`basePrompt`，可选 `productSections`/`hideBuiltIns`/`aliases`）放入 `<业务数据目录>/env-sim/personas/`，一个文件一个预设，即出现在预设下拉里，拷给他人也可用。详见 [usage.md 的官方扩展一节](./usage.md#extension-host-与官方扩展)。

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
- 退出码：`0` 完成 / `1` agent 错误或参数错误 / `2` 权限拒绝（非 `--yolo` 时遇到权限请求即退出）

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

`--prefix`、`--data-dir` 必须是绝对路径，端口必须在 1–65535。`--use-system-node` 会在安装时校验 PATH 中的 Node.js 24+；运行时 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 可覆盖安装时默认值。非回环 `--host` 要求启动时提供 `OWC_ACCESS_TOKEN`（≥32 字符），仍建议只在受信网络或认证反向代理后使用。

### Q: 启动后浏览器打不开 / 连接被拒？

- 确认 `owc` 进程在跑（`ps aux | grep owc` 或任务管理器）
- 确认端口未被占用、未被防火墙拦
- 默认监听 `127.0.0.1`；远程/局域网访问需设置 `OWC_HOST=0.0.0.0` 且**必须**同时设置 `OWC_ACCESS_TOKEN`（≥32 字符），否则 server 拒绝启动。浏览器首次用 `http://<主机>:<端口>/?token=<token>` 换取 HttpOnly Cookie；`owc run` 用 `OWC_ACCESS_TOKEN` 环境变量走 Bearer 头

### Q: 手机上能用吗？

可以。窄窗口（≤1024px）是单列布局：对话下发任务、看运行状态、处理权限卡与结构化交互、队列操作、启停 run、切换会话都完整可用；侧栏作为临时抽屉，不会改写桌面展开偏好。代码审查等重活建议回桌面。浏览器「安装到主屏」后有 PWA 壳；不做离线缓存。手机访问意味着非回环监听，必须先配好 `OWC_ACCESS_TOKEN`（见上一条）。

### Q: 命令面板和快捷键有哪些？

`Ctrl/Cmd+Shift+P` 打开命令面板（全部命令可搜索），`Ctrl/Cmd+P` Quick Open 直达文件（`#` 前缀搜符号），`Shift+?` 查看快捷键速查。默认集对齐 VSCode 习惯（`mod+B` 侧栏、`` mod+` `` 底部面板、`mod+,` 设置、`F6` 区域轮换等），完整清单在设置 → 快捷键；暂不支持自定义键位。

### Q: 怎么在对话里搜索内容、快速换模型？

`Ctrl/Cmd+F` 打开会话内搜索：浮动搜索条显示命中计数，`↑`/`↓` 在命中间跳转并高亮，可勾选「仅搜索已加载消息」。输入框聚焦时按 `Ctrl+P` 在最近使用的模型间循环切换（最近模型列表随本机保存）。详见 [usage.md 的工作台布局与快捷键](./usage.md#工作台布局与快捷键)。

### Q: agent 提交 git 提交需要我确认吗？

始终需要。`git_commit` 工具默认不开放自动执行，yolo 模式下也需确认，且拒绝 `--no-verify` 等绕过参数；提交信息建议经 SCM 面板「生成提交信息 → 确认」流程，全部走权限链并记录审计。

### Q: test_runner 支持哪些测试框架？

结构化解析覆盖 vitest/jest、pytest、go test、dotnet test 四类；项目类型按 package.json/pyproject/go.mod/*.sln 自动检测生成默认命令。解析失败时回退原文尾部（不丢输出），失败摘要有界注入 agent 上下文，完整结果落会话 artifact 并在问题面板可视化。

### Q: 索引没建或损坏时 agent 还能搜代码吗？

能。`code_search` 在未建索引时明确回退 grep 路径；索引只是加速缓存，文件系统永远是真相。索引损坏可在服务端整体重建（`POST /api/workspaces/index/rebuild`），不会进入会话历史。

### Q: WebSocket 断线重连后事件丢失？

不会。断连期间界面顶部显示「连接中断，正在重连…」横幅；重连时带 `after=<lastSeq>` 参数补拉。仅当 `after` 早于服务端历史缓冲区最旧事件（默认保留 1000 条）时返回 `resync.required`，客户端走 REST 全量重取。

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
