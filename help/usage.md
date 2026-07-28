# 使用帮助

日常使用 openwebcode 时最常遇到的问题与操作。FAQ 见 [`faq.md`](./faq.md)。

## 启动

1. 运行 `owc`（Windows：`owc.cmd`；Linux：安装器生成的 `<prefix>/bin/owc`）；
2. 浏览器打开 <http://127.0.0.1:3000>；
3. 首次使用先到 **设置 → 模型目录 → 模型服务商** 添加一个或多个配置，选择接口类型、Base URL、API Key 并启用；随后在同一页签刷新模型列表。

尚未配置任何服务商时，空会话页会显示三步快速上手引导，按钮直达设置对应分区；新建会话对话框里的「未配置服务商 / 无可用模型」提示也可点击跳转。服务商表单中的「测试连接」按钮可在保存前验证配置，认证失败、URL 错误、无法连接、限流会分类给出中文提示。

如果端口被占用或想换端口：设置环境变量 `OWC_PORT=4000` 后启动 `owc`（launcher 脚本默认 3000，server 自身兜底 3210）。

### 远程访问与局域网

默认只监听 `127.0.0.1`（回环）。要让手机或局域网其他机器访问：

1. 设置 `OWC_HOST=0.0.0.0`（或其他非回环地址）；
2. **必须**同时设置 `OWC_ACCESS_TOKEN`（至少 32 字符的随机串），否则 server 拒绝启动；
3. 浏览器首次打开 `http://<主机>:<端口>/?token=<OWC_ACCESS_TOKEN>`，服务端校验后写入 HttpOnly Cookie，后续访问免带 token；
4. `owc run` CLI 访问带 token 的实例时，把同一 token 放进 `OWC_ACCESS_TOKEN` 环境变量（走 Bearer 头）。

设置 → **远程访问** 分区展示当前监听地址、回环/非回环状态与 token 认证说明，监听地址/端口也在此修改（重启生效）；非回环监听期间持续展示风险提示。非回环 + token 只是准入门槛，仍建议只在受信网络使用。

### Linux 安装器交互与自动化

从 Linux tar.gz 解包后直接运行 `./install.sh`，且 stdin/stdout 都是终端时，安装器会依次询问未由命令行提供的安装前缀、端口、数据目录、监听地址、是否使用系统 Node.js，以及是否写用户级 systemd unit。直接回车保留默认值；命令行参数优先。

```sh
# 自动化、CI、管道或重定向中：--yes 保证绝不读取交互输入。
./install.sh --yes --prefix "$HOME/.local" --port 3000 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

- `--prefix` 与 `--data-dir` 必须是绝对路径；prefix 创建后会规范化并拒绝根目录。
- `--port` 只接受 1–65535；`--host` 默认 `127.0.0.1`。非回环监听启动时强制要求 `OWC_ACCESS_TOKEN`（≥32 字符），并只应放在受信网络或认证反向代理后。
- `--use-system-node` 不复制包内 `node/`，并在安装时验证 `PATH` 中的绝对路径 Node.js 为 20+；`--with-systemd` 仅写用户级 service 文件，不自动启用。
- 运行时的 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 始终覆盖安装时写入的默认值。`--system` 与 `--with-desktop-entry` 目前会明确失败，尚未提供系统级/桌面集成。

## 界面语言

- 首次打开时，浏览器语言以 `zh` 开头则使用简体中文，其余语言使用英文。
- 在 **设置 → 外观 → 语言** 中可随时切换 `简体中文` / `English`，无需重启或刷新。
- 选择存入浏览器 localStorage 的 `owc-language`，只影响当前浏览器，不修改模型的默认回复语言。
- 模型回复语言由提示词及 **设置 → 通用 → 默认语言** 控制，与界面语言相互独立。
- 切换语言会同步更新页面 `<html lang>`；日期、时间和数字按当前界面语言格式化。
- 从会话栏导出的自包含 HTML 分享页也会沿用当前界面语言。

## 工作台布局与快捷键

界面为五区布局：**活动栏**（左侧窄条：会话/文件/SCM/设置等入口）、**侧栏**、**主区**（会话轨道与输入框，永远是中心）、**底部面板**（上下文/时间线/沙盒/成本/性能等标签页）、**状态栏**。布局状态（侧栏宽度、面板开合）按工作区保存在本机。

常用默认快捷键（`mod` = Windows/Linux 的 `Ctrl`、macOS 的 `Cmd`）：

| 快捷键 | 作用 |
|---|---|
| `mod+Shift+P` | 命令面板：全部命令一个入口，可搜索，标注快捷键 |
| `mod+P` | Quick Open：模糊直达工作区文件；`#` 前缀搜符号 |
| `mod+B` / `` mod+` `` | 折叠/展开侧栏 / 底部面板 |
| `mod+Shift+E` / `F` / `G` / `M` | 切到会话 / 文件 / SCM / 问题视图 |
| `mod+,` | 打开设置 |
| `mod+L` | 聚焦输入框 |
| `mod+PageUp` / `PageDown` | 上一个 / 下一个会话 |
| `mod+Alt+N` | 新建会话 |
| `F6` | 在五个区域间轮换焦点 |
| `Esc` | 中断正在运行的 agent（弹窗、对话框、权限卡、编辑器聚焦时不抢键） |
| `Shift+?` | 快捷键速查 |

完整键位见设置 → **快捷键** 分区；暂不支持自定义键位。输入框聚焦时全局快捷键不抢键。设置对话框左侧导航带搜索框，按分区/分组/字段名（中英文）直接定位；界面各处的「前往设置」入口会深链到对应分区。

## 问题（Problems）与源代码管理（SCM）面板

- **问题面板**：`test_runner` 工具跑测试/构建/lint 后，结构化诊断（vitest/jest、pytest、go test、dotnet test）按文件分组展示，可按严重度过滤、查看来源工具；点击条目跳转到只读代码视图的对应行列。agent 运行中产生新诊断时以角标提示，不打断当前操作。
- **SCM 面板**：展示当前分支、ahead/behind 与变更文件分组；点击文件看只读 diff（大 diff 落 artifact，面板给出提示）；「生成提交信息」经对话下发 `git_commit` 工具，提交动作始终需要确认（yolo 也不例外）；无 git 仓库的会话面板会如实标注降级。worktree 的创建/合并/移除在面板内两步确认执行。
- **只读代码视图**：Shiki 高亮 + 行号 + 行列跳转的统一代码查看形态，从工具卡、问题面板、SCM diff 或 Quick Open 打开，`Esc`/关闭即回到对话。0.5.0 中工具卡文件变化、Problems 跳转、SCM diff 已可打开 Monaco 编辑器/分栏 diff（随需加载，未打开不付出体积），支持逐 hunk 接受/拒绝；加载失败或移动端降级为只读视图。

## 移动端与 PWA

- 浏览器「安装到主屏」（PWA manifest，standalone 模式）后可像应用一样打开；不做离线缓存——应用强依赖实时连接。
- 窄窗口（≤1024px）为单列布局：活动栏变顶部横条、侧栏变临时抽屉、底部面板变全屏 sheet；核心操作（权限卡、结构化交互、队列、启停 run、切换会话）均可在 3 次点击内完成，按钮点击目标 ≥44px。
- 移动端访问即非回环监听，必须先配置 `OWC_ACCESS_TOKEN`（见上文「远程访问与局域网」）。

## 创建会话

侧栏 **+** 新建会话：

- **工作目录**：agent 的 cwd，文件读写/命令执行都在此目录下（受沙盒约束）
- **模型**：从所有已启用服务商的模型列表中选择，格式为 `模型ID【服务商】`
- **沙盒模式**：
  - `AppContainer`（Windows 默认）/ `Landlock`（Linux 默认）—— 日常开发
  - `WSB`（Windows Sandbox）—— 跑不可信代码时用，一会话一 VM，关闭即蒸发
  - `Job Object`（Windows）/ 关闭 —— AppContainer 兼容兜底 / 完全不沙盒（不推荐）
- **工作区模式**：
  - `直接` —— 工作目录就是文件系统里的真实目录
  - `托管工作区` —— 项目复制进 VHDX/qcow2 稀疏镜像盘挂载点，快照走差分链（毫秒级、可分支）
- **Plan/Build 模式**：
  - `build`（默认）—— 正常执行
  - `plan` —— 只读调研，产出分步计划，不执行任何写操作；切回 build 才动手

## 输入框

输入框支持以下前缀与快捷：

| 输入 | 含义 |
|---|---|
| `普通文本` | 发给 agent 的任务描述 |
| `/技能名` | 触发 Skill（项目 `.owc/skills/` 或全局） |
| `/自定义命令` | 触发自定义斜杠命令（项目 `.owc/commands/` 或全局） |
| `/compact` | 概览压缩上下文（快速模型做结构化摘要） |
| `/compact tools` | 规则压缩（toolcalls 占位精炼） |
| `/clear` | 清空当前视图，**保留历史**（JSONL 全量在盘，可回滚） |
| `/init` | 分析当前工作区并生成/更新根目录 `AGENTS.md`（写文件走权限链） |
| `/help` | 打开快捷键速查 |
| `@路径` | 引用工作区文件，内容随消息注入（大文件截断 + artifact 指针） |
| `!命令` | shell 快捷前缀，走与 bash 工具相同的权限链执行，结果可一键「发给 agent」 |

- `@` 触发文件补全下拉（防抖 200ms，键盘上下/回车/Esc）；已建索引时索引优先、未建索引自动回退 glob，符号条目显示 kind 与位置，选中插入 `@路径:行号`
- 首行或输入为空时按 `↑`/`↓` 召回历史消息，当前草稿自动暂存、翻到底恢复
- 输入框草稿按会话持久化到浏览器 localStorage，刷新后自动恢复，删除会话时清理
- 运行中再发消息会进入 **steering 队列**，下一轮注入，不中断当前作业
- 默认 Enter 发送、Shift+Enter 换行；可在设置里改成 Ctrl+Enter 发送

## 联网工具配置

- Search 与 Fetch 使用同一套「联网服务商」配置。可以保存多个 Jina、Brave、Tavily 或 Custom 配置，每项声明 `search` / `fetch` 能力，再分别选择当前用于 Web Search 和 Web Fetch 的配置。
- Jina 与 Tavily 同时支持 Search 与 Fetch（Tavily Fetch 使用 Extract API）；Brave 仅支持 Search；Custom 可自行声明能力。Custom Fetch URL 必须包含 `{url}` 占位符，Custom Search URL 接收 `q` 与 `count` 查询参数。
- 未选中具备相应能力的配置时，对应工具不会注入模型。Tavily 的 API Key 由同一个联网服务商配置同时用于 Search 与 Fetch。
- 联网调用仍遵循会话权限模式；`ask` 下会请求确认，且内网/本地 URL 会被拒绝。

## 对话内容渲染

- 正文支持 GFM Markdown：标题、列表、任务列表、表格、引用、删除线、链接、行内代码与代码块
- 代码块悬停显示复制按钮，一键复制整块内容
- 行内公式使用 `$E=mc^2$`
- 块级公式使用独占一段的 `$$ ... $$`，由 KaTeX 渲染；过宽公式可横向滚动
- 思考过程与流式思考使用同一套 Markdown/LaTeX 渲染，默认折叠，颜色比最终正文更浅；点击「思考过程」或「正在思考」展开。完成后的思考随 assistant 消息落盘，刷新或重开会话仍保留
- 历史版本按 token 保存的正文分片会在显示时自动合并，不再逐词换行

## 运行中操作

- **中断**：顶部「中断」按钮、Esc 快捷键（或 `POST /api/sessions/:id/abort`）—— 取消当前 LLM 请求 + kill 运行中的工具进程
- **运行失败**：错误卡按类型给出可操作提示（认证失败/权限/限流/过载等），附设置深链按钮（认证/接口不存在/无效请求 → 模型目录）；可重试的错误（限流、过载等）提供「重试」按钮，一键重发上一条用户消息；toast 通知为一行摘要
- **Steering**：运行中追加消息进入队列，下一轮注入
- **权限请求**：弹出权限卡片，三选项：
  - `允许一次` —— 仅批准当前工具调用；批准响应先返回浏览器，随后才启动工具
  - `总是允许` —— 二次确认后生成持久规则（如精确的 `bash(npm test)`），随会话保存
  - `拒绝` —— 可附理由回填给 LLM
- 会话头部可选择命令后端：Windows 的 `默认` 使用 `cmd.exe`，`PowerShell 7` 强制使用 `pwsh`。该选择同时作用于前台命令、后台任务和 agent 的 bash 工具，并随会话保存。选择 `pwsh` 前需先安装 PowerShell 7。
- **后台 bash 任务**：bash 工具带 `run_in_background=true` 时立即返回 taskId，头部徽标查看运行中任务、点开看输出、随时终止；完成自动通知下一轮
- **通知中心**：活动栏铃铛汇总 toast 与后台事件（任务完成、诊断更新、SCM 更新、后台任务结束），未读角标、可逐条/全部清除、点击跳转相关会话与视图；权限请求与结构化交互不进入通知流，仍是一等卡片

## 会话生命周期（重要）

- **关闭浏览器标签页不会停止 agent** —— 服务器继续执行，结果照常落盘
- 重新打开 UI 选回该会话，断线期间的事件自动补拉回来；WebSocket 断连期间界面顶部显示「连接中断，正在重连…」横幅，恢复后自动消失
- **重命名**：侧栏双击会话标题或点编辑按钮内联改名
- **置顶**：会话菜单置顶后排在列表最前，再次操作取消
- **删除**：弹确认对话框（不再用浏览器原生确认框），删除后该会话的输入框草稿一并清理
- 主动停作业用「中断」按钮；关掉 server 进程才收尾全部会话与后台任务
- 断线期间发起的权限请求会一直挂起等你回来 respond，**无超时**

## 右侧面板

- **文件树**：懒加载，文件只读预览
- **上下文窗口**：会话头部实时显示窗口占用 `45k/128k · 38%`（≥70% 变黄、≥85% 变红）与缓存命中胶囊（悬停细分读取/写入/未缓存输入），状态栏同步显示 `窗口 N%`
- **上下文用量**：顶部「上下文窗口」区给出大号占用表、按段（消息/工具结果/repoMap/压缩摘要/系统/其他）堆叠的 token 归因条、本轮/累计缓存命中与水位提示；下方为 token/成本/预算明细，支持 lag/interval/off 策略热调、工具调用/概览压缩、条目逐出/回写/pin，以及 artifact 原文查看
- **子代理**：底部面板「子代理」标签页汇总本会话全部 `spawn_task`/`spawn_swarm`——按调用分组，swarm 显示完成/失败/运行中聚合计数与逐项实时进度，可内联展开转录；消息轨道里的子代理卡片也实时刷新（swarm 逐项状态、轮次、工具数），转录展示完整内部消息流（折叠到最近 20 轮）；刷新页面后从历史恢复
- **时间线**：检查点列表 → diff 查看 → 「完整回滚」或「仅文件」回滚（二次确认），新建检查点
- **沙盒状态**：会话头部徽标（enforced / advisory），标识当前沙盒是否生效
- **模式切换**：会话空闲时可在头部直接切换沙盒模式，以及快照的「每轮自动 / 仅手动」模式；运行中会暂时禁用切换
- **命令后端**：会话空闲时可在头部切换「默认 / PowerShell 7」；缺少 `pwsh` 时会返回明确错误，不会悄悄改用其他 shell

## 模型与成本

- **模型服务商**：可保存并独立启用多个 Anthropic Messages / OpenAI Chat Completions 接口配置；每个服务商可自动拉取或手动添加自己的模型，同名模型互不覆盖
- **会话中热切换模型**：统一列表显示为 `模型ID【服务商】`，下轮生效；账本按新窗口重算，模态不兼容的历史内容替换为占位描述
- **快速模型**：直接从同一统一模型列表中选择，用于上下文压缩与内容透镜；接口、Base URL 和密钥复用所选服务商，可单独设置 thinking、effort 与最大输出上限
- **思考与强度**：支持 reasoning 的模型在输入框下方的会话配置行使用单一选择器切换关闭/自适应/强度；模型不支持的旧值会在切换模型时自动清除
- **成本报表**：按会话/按日/按 provider，缓存读写分项，双币种（USD/CNY）汇率折算，预算触发暂停
- **模型定价**：设置 → 模型定价 → 添加条目。价格单位是“每百万 tokens 的元/美元”；输入、输出单价必填，缓存读/写可空（按 `0` 保存），生效日期默认当天并可修改
- 同一 provider/model 的生效区间不能重叠；历史价格或复杂区间可用「编辑 JSON」维护 `effectiveFrom` / `effectiveUntil`

## Headless CLI（脚本集成）

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json
```

- `--json` 输出 NDJSON 事件流（每行一个事件对象）
- `--yolo` 权限请求自动 allow（CI 场景）
- `--session <id>` 复用已有会话
- `owc --help` / `owc run --help` 输出中英双语帮助
- 退出码：`0` 完成 / `1` agent 错误或参数错误 / `2` 权限拒绝（非 `--yolo`）

## 会话导出与分享

- **导出分享页**：侧栏会话项悬停 → 「导出分享页」→ 生成 `export.html` 自包含只读页（内联样式、零外部资源、全文转义），可直接发给别人
- **导出/导入 JSONL**：会话菜单导出全量历史，另一台机器导入即恢复

## 配置文件位置

`<启动/设置目录>` 按启动方式确定：用户显式设置的 `OWC_DATA_DIR` 优先；未设置时，安装版启动器会注入平台注册默认值（Windows `%LOCALAPPDATA%\openwebcode`，Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才用相对 `server` 目录的 `../.openwebcode` 作为兜底。为避免相对路径按 `server` 目录解析，建议为 `OWC_DATA_DIR` 和设置页中的数据目录填写绝对路径。

设置页保存到 `<启动/设置目录>/server-settings.json`。其中已保存的“数据目录”会在**未设置 `OWC_DATA_DIR`**时、下次启动后决定 `<业务数据目录>`；设置文件不会随之移动。未保存覆盖时，`<业务数据目录>` 与 `<启动/设置目录>` 相同。

| 路径 | 用途 |
|---|---|
| `<启动/设置目录>/server-settings.json` | 设置页保存的服务设置 |
| `<业务数据目录>/provider-profiles.json` | 多模型/联网服务商配置与密钥（本机明文保存，界面仅脱敏显示） |
| `<业务数据目录>/sessions/<id>/` | 会话数据（meta.json + messages.jsonl + ledger.json + artifacts/） |
| `<业务数据目录>/agents/*.md` | 全局自定义子代理 |
| `<业务数据目录>/commands/*.md` | 全局自定义斜杠命令 |
| `<业务数据目录>/skills/<name>/SKILL.md` | 全局 Skills |
| `<业务数据目录>/hooks.json` | 全局 Hooks（**安全级别等同 yolo**） |
| `<业务数据目录>/mcp.json` | 全局 MCP 客户端配置 |
| `<业务数据目录>/system-prompt.md` | 全局系统提示词基线覆盖（设置页「提示词」编辑） |
| `<业务数据目录>/system-prompt-append.md` | 全局自定义追加指令 |
| `<业务数据目录>/update-check.json` | 更新检查缓存（最新版本与检查时间） |
| `<业务数据目录>/extensions/` | Extension Host 配置与第三方 `owc-ext-*` 扩展 |
| `<安装目录>/config/defaults.json` | 随发布更新的默认配置；数据目录只存用户覆盖，启动时自动组合 |
| `<cwd>/.owc/agents/`、`.owc/commands/`、`.owc/skills/`、`.owc/hooks.json`、`.owc/mcp.json`、`.owc/memory.md`、`.owc/system-prompt.md`、`.owc/system-prompt-append.md` | 项目级（同名覆盖全局） |

## 自定义系统提示词

设置 → **提示词** 可覆盖内置系统提示词基线，并追加自定义指令：

- **全局基线覆盖**：留空则使用内置 Pi 基线；填写后完整替换基线段落。
- **全局追加指令**：追加到安全约束之后的自定义指令。
- 项目级 `<cwd>/.owc/system-prompt.md` 与 `.owc/system-prompt-append.md` 存在时覆盖全局（手工维护）。

> 提示词**不是安全边界**：plan 模式、权限与沙箱由服务独立强制，不受提示词覆盖影响。「恢复内置基线」按钮可一键清空全局覆盖。

## 版本号与更新检查

- 设置 → **服务信息** 展示 Server/Core 版本与协议版本；命令行 `owc --version` 打印服务版本。执行器、存储上限/数据目录等系统级参数也在该页签的「系统与存储」分区调整。
- 设置 → **服务信息 → 更新检查**（默认关闭）：启用后周期性查询 GitHub Releases 最新版本，结果在同一页签静默展示，可点「立即检查」手动刷新，并在有新版本时给出下载链接；发现新版本时通知中心会出现按版本去重的提醒条目，点击直达设置 → 服务信息。相关环境变量：`OWC_UPDATE_CHECK_ENABLED`、`OWC_UPDATE_CHECK_URL`、`OWC_UPDATE_CHECK_INTERVAL_HOURS`。
- 发现新版本后可直接在设置页**一键在线更新**：Windows 下载 MSI 后启动安装程序并退出当前服务（安装程序完成覆盖升级）；Linux 替换安装目录 `<prefix>/lib/openwebcode/` 内容后自动重启（未以后台服务运行时需手动重启）。启动器、systemd unit 与数据目录均不受影响。
- Linux 也可用一行命令在线安装或更新（自动校验 SHA-256；已安装则走更新模式）：

  ```sh
  curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
  ```

  参数与行为详见 [packaging/README.md 的「在线安装与更新」](../packaging/README.md#在线安装与更新)。

## 自定义扩展点

### Extension Host 与官方扩展

设置 → **扩展** 可管理官方及第三方扩展。内置六项：

- `context-manager`：默认启用，负责滚动驱逐策略和上下文管理面板；停用后不会自动逐出工具结果，85% 核心水位安全网仍保留
- `attention-optimizer`：默认关闭，把关键约束/目标复制到上下文首尾锚区；`bottomOnly` 缓存影响较小，`full` 会增加输入 token
- `content-lens`：默认关闭；启用且已配置快速模型后，消息旁出现「译」与「解析选中」，结果只存 `translations/`，不进入 LLM 上下文
- `pdf-to-image`：默认启用；通过 Web 选择的 PDF 会先保存到当前工作区 `.owc/uploads/`，再将最多 4 页按 150 DPI、长边最大 2048px 转为图片附件，供支持图片输入的模型读取；停用时 Composer 仅把这个工作区相对路径引用交给主代理处理
- `owc-eval`：默认关闭；启用后底部面板出现「评测」，可选择固定 mock-provider 示例与 0.4 工具契约任务，在独立临时工作区回放 AgentRunner。报告包含断言、工具、token 与耗时；可把历史运行设为基线，与当前运行生成持久化的回归/改善对比并导出自包含 JSON。评测服务内置于 server，不读取原始 API Key；生产运行仍走正常 Core 权限与沙盒边界
- `env-sim`（环境模拟）：默认关闭；启用并选择预设后，系统提示词切换为该产品风格（身份行 + 工作方式），内置工具以该产品的命名/描述呈现（如 `Read`/`Bash`/`Edit`），底层仍走原工具实现与权限链。内置 `claude-code`/`kimi-code`/`zcode`/`codex` 四档预设；把自制预设 JSON 放入 `<业务数据目录>/env-sim/personas/` 即可添加并与他人分享（格式见该目录生成的示例或开发文档）

第三方扩展目录需包含 `manifest.json`（`apiVersion: "1"`）和 `index.js`，可在设置页输入本地绝对路径安装。v1 扩展是可信代码，安装即信任其声明权限；钩子运行超时 5 秒会跳过并告警。

### 子代理（`.owc/agents/reviewer.md`）

内置两种类型：`explore`（默认，只读探索：read_file/glob/grep/read_artifact）与 `general`（通用：可读写文件、执行 bash，工具调用经与主代理相同的权限链与沙盒）。`spawn_task agent=general prompt="..."` 即可派发可写任务；自定义 markdown 子代理仍为只读。

```markdown
---
name: reviewer
description: 代码审查专家，只读不改
tools: [read_file, glob, grep]
model: claude-sonnet-4-5
---
你是资深代码审查员。逐行核对 diff，指出：
- 逻辑错误
- 边界条件遗漏
- 命名与风格
不要修改代码，只输出审查意见。
```

调用：`spawn_task agent=reviewer prompt="审查 src/auth.ts 的最近改动"`

多个独立的同类只读任务可用 `spawn_swarm` 并行（模板 + 逐项替换，超出并发上限自动排队）：

```
spawn_swarm prompt_template="审查 {{item}} 的最近改动，输出风险点" items=["src/auth.ts", "src/api.ts", "src/pay.ts"]
```

`items` 也可逐项指定子代理：`items=[{"task": "审查 src/auth.ts", "agent": "reviewer"}, ...]`（字符串形式仍兼容，`agent` 也可填内置 `general`）。子代理结论按 `[序号/总数]` 聚合返回；派生过程在消息轨道渲染为实时卡片（swarm 逐项状态、轮次与工具数），底部面板「子代理」标签页按调用分组汇总，顶部还可手动启动子代理（任务描述 + 类型选择，`POST /api/sessions/:id/subagents`）；主窗口子代理标签页以与主对话相同的渲染展示完整转录。每次派生的完整转录存在会话数据目录 `subagents/<taskId>.json`。中断 agent 不会再启动排队中的 swarm 项，也会取消手动启动的子代理。

### 斜杠命令（`.owc/commands/review.md`）

```markdown
---
description: 审查当前改动
---
请用 git diff 查看未提交改动，逐文件给出审查意见。重点：$ARGUMENTS
```

调用：输入框 `/review 安全性` → `$ARGUMENTS` 替换为 `安全性`。

### Hooks（`.owc/hooks.json`）

```json
{
  "PreToolUse": [
    { "matcher": "write_file*", "command": "prettier --check $FILE" }
  ],
  "PostToolUse": [
    { "matcher": "bash*", "command": "notify-send '命令完成'" }
  ]
}
```

- `matcher`：精确工具名、`前缀*`、`*` 全匹配
- PreToolUse：exit 0 放行 / exit 2 否决（stderr 回填 LLM）/ 其他非零告警不阻断
- 5s 超时杀进程
- **安全级别等同 yolo**：hooks.json 里的 command 由 server 直接 spawn 执行，不经沙盒与权限链。凡是能写 hooks 配置的人即拥有等同 yolo 的执行能力。

## 常见问题

见 [`faq.md`](./faq.md)。
