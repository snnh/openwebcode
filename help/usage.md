# 使用帮助

日常使用 openwebcode 的操作说明与常见场景。FAQ 见 [`faq.md`](./faq.md)。

**目录**：[启动](#启动) · [界面语言](#界面语言) · [工作台布局与快捷键](#工作台布局与快捷键) · [问题与 SCM 面板](#问题problems与源代码管理scm面板) · [移动端与 PWA](#移动端与-pwa) · [创建会话](#创建会话) · [输入框](#输入框) · [联网工具配置](#联网工具配置) · [定时任务（cron）](#定时任务cron) · [对话内容渲染](#对话内容渲染) · [运行中操作](#运行中操作) · [真终端](#真终端) · [会话生命周期](#会话生命周期重要) · [面板与状态显示](#面板与状态显示) · [模型与成本](#模型与成本) · [Headless CLI](#headless-cli脚本集成) · [会话导出与分享](#会话导出与分享) · [配置文件位置](#配置文件位置) · [自定义系统提示词](#自定义系统提示词) · [版本号与更新检查](#版本号与更新检查) · [自定义扩展点](#自定义扩展点) · [常见问题](#常见问题)

## 启动

1. 运行 `owc`（Windows：`owc.cmd`；Linux：安装器生成的 `<prefix>/bin/owc`）；
2. 浏览器打开 <http://127.0.0.1:3000>；
3. 首次使用先到 **设置 → 模型目录 → 模型服务商** 添加一个或多个配置，选择接口类型、Base URL、API Key 并启用；随后在同一页签刷新模型列表。

尚未配置任何服务商时，空会话页会显示三步快速上手引导，按钮直达设置对应分区；新建会话对话框里的「未配置服务商 / 无可用模型」提示也可点击跳转。服务商表单中的「测试连接」按钮可在保存前验证配置，认证失败、URL 错误、无法连接、限流会分类给出中文提示。

如果端口被占用或想换端口：设置环境变量 `OWC_PORT=4000` 后启动 `owc`（launcher 脚本默认 3000，server 自身兜底 3210）。

### 远程访问与局域网

默认只监听 `127.0.0.1`（回环）。要让手机或局域网其他机器访问，把监听地址改为非回环即可——访问令牌由服务端首次启动时自动生成并持久化（`<业务数据目录>/access-token`，0600），无需手工配置：

- **Windows / 已装机**：设置 → **远程访问** 把监听地址改为 `0.0.0.0`（重启生效）；该分区随即展示带令牌的一键访问链接（可复制、可扫码），服务端启动时也会把链接打印到控制台。Windows 首次监听 `0.0.0.0` 时防火墙会弹窗，需选择允许。
- **Linux 新装**：`./install.sh --lan`（等价 `--host 0.0.0.0`）；搭配 `--enable-service` 时安装结束会直接打印访问链接，root 系统级安装可再加 `--open-firewall` 自动放行防火墙端口（见下文「Linux 安装器交互与自动化」）。

访问方式：

1. 在局域网设备的浏览器打开访问链接 `http://<主机>:<端口>/?token=<令牌>`，服务端校验后写入 HttpOnly Cookie，后续访问免带令牌；
2. `owc run` CLI 访问带令牌的实例时，把同一令牌放进 `OWC_ACCESS_TOKEN` 环境变量（走 Bearer 头）；
3. 设置 → **远程访问** 可随时重新生成令牌（旧链接与已登录设备立即失效）；令牌由环境变量显式配置时不出现在该分区，需在环境中轮换。

显式覆盖：`OWC_ACCESS_TOKEN`（≥32 字符）固定令牌；`OWC_ALLOWED_ORIGINS`（逗号分隔的 http(s) 源）限定浏览器来源，缺省放行与访问地址同源的请求。非回环 + 令牌只是准入门槛，仍建议只在受信网络使用。

同一分区还提供 **TOTP 全局登录** 向导。启用后所有浏览器访问都需先输入认证器 App 的 6 位动态码（RFC 6238，30 秒步长）才能进入界面：

- 向导生成 base32 密钥，可扫码或手动录入认证器；启用时展示 **10 个一次性恢复码**（服务端只存哈希，用完即删），请离线保存
- 登录票据有效期 12 小时、随有效请求滑动续期，只驻留内存——重启 server 后所有浏览器需重新登录；每个 IP 连续 5 次失败锁定 60 秒
- 凭据存于 `<业务数据目录>/totp.json`（权限 0600）；向导中可停用或重新生成密钥
- `OWC_ACCESS_TOKEN` 的 Bearer 通道继续保留给 `owc run` 等机器访问，与 TOTP 并存，任一通过即可

### Linux 安装器交互与自动化

从 Linux tar.gz 解包后直接运行 `./install.sh`，且 stdin/stdout 都是终端时，安装器会依次询问未由命令行提供的安装前缀、端口、数据目录、是否开启局域网访问、是否使用系统 Node.js，以及 systemd 服务（是否写入、是否立即启用启动；root 且开启局域网访问时还会询问是否放行防火墙端口）。直接回车保留默认值；命令行参数优先。

```sh
# 自动化、CI、管道或重定向中：--yes 保证绝不读取交互输入。
./install.sh --yes --prefix "$HOME/.local" --port 3000 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1

# 服务器一键安装（root）：系统级路径 + 局域网访问 + systemd 开机自启 + 防火墙放行，
# 安装结束直接打印带令牌的访问链接。
sudo ./install.sh --yes --system --lan --enable-service --open-firewall
```

- `--prefix` 与 `--data-dir` 必须是绝对路径；prefix 创建后会规范化并拒绝根目录。默认按用户分层：普通用户 `~/.local` + `${XDG_DATA_HOME:-~/.local/share}/openwebcode`；root（或显式 `--system`，需 root）`/usr/local` + `/var/lib/openwebcode`。
- `--port` 只接受 1–65535；`--host` 默认 `127.0.0.1`，`--lan` 是 `--host 0.0.0.0` 的快捷方式（互斥）。非回环监听只应放在受信网络或认证反向代理后。
- `--with-systemd` 写服务文件但不启用（root 写 `/etc/systemd/system/openwebcode.service`，否则写用户级 unit）；`--enable-service` 隐含写入并立即 `systemctl enable --now`。用户级服务要开机自启（未登录也运行）需再执行 `loginctl enable-linger $USER`。
- `--open-firewall` 仅在 root + 非回环监听时可用，检测 firewalld/ufw 放行端口；未检测到时打印手动放行提示。
- `--use-system-node` 不复制包内 `node/`，并在安装时验证 `PATH` 中的绝对路径 Node.js 为 24+。
- 运行时的 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 始终覆盖安装时写入的默认值。`--with-desktop-entry` 目前会明确失败，尚未提供桌面集成。
- 服务以 root 运行时，agent 工具执行的命令同样是 root 权限（沙盒不降低这一风险），请只运行可信任务。
- 卸载：运行安装时落盘的 `<prefix>/bin/owc-uninstall`（发行包根目录也有 `uninstall.sh`），会停止并移除 systemd 服务、删除运行时与启动器；数据目录默认保留，`--purge-data` 一并删除，`--remove-firewall`（root）移除防火墙规则。

## 界面语言

- 首次打开时，浏览器语言以 `zh` 开头则使用简体中文，其余语言使用英文。
- 在 **设置 → 外观 → 语言** 中可随时切换 `简体中文` / `English`，无需重启或刷新。
- 选择存入浏览器 localStorage 的 `owc-language`，只影响当前浏览器，不修改模型的默认回复语言。
- 模型回复语言由提示词及 **设置 → 通用 → 默认语言** 控制，与界面语言相互独立。
- 切换语言会同步更新页面 `<html lang>`；日期、时间和数字按当前界面语言格式化。
- 从会话栏导出的自包含 HTML 分享页也会沿用当前界面语言。

## 工作台布局与快捷键

界面为五区布局：**活动栏**（左侧窄条：会话/文件/SCM/设置等入口）、**侧栏**、**主区**（会话轨道与输入框）、**底部面板**（上下文/时间线/子代理/沙盒/成本/性能等标签页）、**页签状态区**。会话状态信息（状态、模式、模型、窗口占用、成本）并入底部面板页签条右侧，桌面端显示完整项，移动端精简为状态点+模式+模型；打开会话时先显示骨架屏，避免欢迎页闪烁。布局状态（侧栏宽度、面板开合等）保存在本机浏览器。

常用默认快捷键（`mod` = Windows/Linux 的 `Ctrl`、macOS 的 `Cmd`）：

| 快捷键 | 作用 |
|---|---|
| `mod+Shift+P` | 命令面板：全部命令一个入口，可搜索，标注快捷键 |
| `mod+P` | Quick Open：模糊直达工作区文件 |
| `mod+B` / `` mod+` `` | 折叠/展开侧栏 / 底部面板 |
| `mod+Shift+E` / `F` / `G` / `M` | 切到会话 / 文件 / SCM / 问题视图 |
| `mod+,` | 打开设置 |
| `mod+L` | 聚焦输入框 |
| `mod+PageUp` / `PageDown` | 上一个 / 下一个会话 |
| `mod+Alt+N` | 新建会话 |
| `F6` | 在活动栏/侧栏/主区/底部面板四个区域间轮换焦点 |
| `Esc` | 中断正在运行的 agent（弹窗、对话框、权限卡、编辑器/diff 打开时不抢键） |
| `mod+F` | 会话内搜索（命中计数，Enter / Shift+Enter 跳转高亮；仅搜索已加载消息） |
| `Ctrl+P`（输入框内） | 在最近使用的模型间循环切换 |
| `Shift+?` | 快捷键速查 |

完整键位见设置 → **快捷键** 分区；暂不支持自定义键位。输入框聚焦时全局快捷键不抢键。设置对话框左侧导航带搜索框，按分区/分组/字段名（中英文）直接定位；界面各处的设置入口（如「前往模型目录」「打开模型设置」）会深链到对应分区。

## 问题（Problems）与源代码管理（SCM）面板

- **问题面板**：`test_runner` 工具跑测试/构建/lint 后，结构化诊断（vitest/jest、pytest、go test、dotnet test）按文件分组展示，可按严重度过滤、查看来源工具；点击条目跳转到只读代码视图的对应行列。agent 运行中产生新诊断时以角标提示，不打断当前操作。
- **SCM 面板**：展示当前分支、ahead/behind 与变更文件分组；点击文件看只读 diff（大 diff 落 artifact，面板给出提示）；填写提交信息后点「提交（需确认）」会经对话下发 `git_commit` 工具，提交动作始终需要确认（yolo 也不例外）；无 git 仓库的会话面板会如实标注降级。worktree 创建一键执行、移除需两步确认。
- **只读代码视图**：Shiki 高亮 + 行号 + 行列跳转的统一代码查看形态，从工具卡、问题面板、SCM diff 或 Quick Open 打开，`Esc`/关闭即回到对话。工具卡文件变化、Problems 跳转、SCM diff 还可打开 Monaco 编辑器/分栏 diff（随需加载，未打开不占用包体积），支持逐 hunk 接受/拒绝；加载失败或移动端降级为只读视图。

## 移动端与 PWA

- 浏览器「安装到主屏」（PWA manifest，standalone 模式）后可像应用一样打开；不做离线缓存——应用强依赖实时连接。
- 窄窗口（≤1024px）为单列布局：活动栏变顶部横条、侧栏变临时抽屉、底部面板变全屏 sheet；核心操作（权限卡、结构化交互、队列、启停 run、切换会话）均可在 3 次点击内完成，按钮点击目标 ≥44px。
- 移动端访问即非回环监听，访问令牌与一键访问链接见上文「远程访问与局域网」。

## 创建会话

侧栏 **+** 新建会话：

- **工作目录**：agent 的 cwd，文件读写/命令执行都在此目录下（受沙盒约束）
- **模型**：从所有已启用服务商的模型列表中选择，格式为 `模型ID【服务商】`
- **沙盒模式**：
  - `Job Object`（Windows 默认）/ `Landlock`（Linux 默认）—— 日常开发
  - `WSB`（Windows Sandbox）—— 跑不可信代码时用，一会话一 VM，关闭即销毁
  - `AppContainer`（Windows）/ 关闭 —— 更强隔离（兼容性较差）/ 完全不沙盒（不推荐）
- **工作区模式**：
  - `直接` —— 工作目录就是文件系统里的真实目录
  - `托管工作区` —— 项目复制进 VHDX/qcow2 稀疏镜像盘挂载点，快照走差分链（毫秒级、可分支）
- **Bind Link 目录绑定**（可选，Windows 11 24H2+）：创建会话的 REST 入参 `bindLinks`（数组，≤16 项，每项 `virtPath`/`backingPath`/`readOnly?`）可把会话工作区内的虚拟路径绑定到工作区外的真实目录，面向 `Job Object` 沙盒模式——agent 进程经虚拟路径透明读写外部目录（`readOnly` 时只读），常用于共享依赖缓存。约束：`virtPath` 必须在会话可写根内、`backingPath` 必须是已存在目录；创建绑定需要 server **以管理员权限运行**，且 core 上报 `features.bindLink`（`GET /api/core` 可见）；不满足时创建会话直接报错，不静默降级。绑定是全系统可见的命名空间映射，会话清理/删除时撤销，异常退出最迟重启失效；不支持 WSB 模式。目前仅 REST 配置入口，UI 配置归后续
- **Plan/Code 模式**：创建后可随时在输入区「模式」弹层切换，plan 与 goal 互斥：
  - `code`（默认）—— 正常执行
  - `plan`（计划）—— 只读调研，产出分步计划，经结构化批准后才切回执行（见「运行中操作」的 plan 批准流）
  - `goal`（目标）—— 目标模式：主模型每轮自评目标达成度，未达成（GOAL_INCOMPLETE）自动续跑，最多 10 次后停止
  - 同层 `Swarm` 为独立开关，可与任一模式叠加 —— 提示词鼓励 agent 用 `spawn_swarm` 并行派生同类子任务

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
- 图片附件最多 4 张、每张 ≤5MB（png/jpeg/webp/gif）；PDF 附件 ≤20MB（由 pdf-to-image 扩展转为图片，见「自定义扩展点」）；`@` 引用每条消息最多 10 个；运行中带附件的消息不能进 steering 队列，需等运行结束
- 首行或输入为空时按 `↑`/`↓` 召回历史消息，当前草稿自动暂存、翻到底恢复
- 输入框草稿按会话持久化到浏览器 localStorage，刷新后自动恢复，删除会话时清理
- 运行中再发消息会进入 **steering 队列**，下一轮注入，不中断当前作业
- 默认 Enter 发送、Shift+Enter 换行；可在设置里改成 Ctrl+Enter 发送

## 联网工具配置

Web Search / Web Fetch 两个工具的数据来源在 **设置 → 模型目录 → 联网服务商** 配置：

- Search 与 Fetch 使用同一套「联网服务商」配置。可以保存多个 Jina、Brave、Tavily 或 Custom 配置，每项声明 `search` / `fetch` 能力，再分别选择当前用于 Web Search 和 Web Fetch 的配置。
- Jina 与 Tavily 同时支持 Search 与 Fetch（Tavily Fetch 使用 Extract API）；Brave 仅支持 Search；Custom 可自行声明能力。Custom Fetch URL 必须包含 `{url}` 占位符，Custom Search URL 接收 `q` 与 `count` 查询参数。
- 未选中具备相应能力的配置时，对应工具不会注入模型。Tavily 的 API Key 由同一个联网服务商配置同时用于 Search 与 Fetch。
- 联网调用仍遵循会话权限模式；`ask` 下会请求确认，且内网/本地 URL 会被拒绝。

## 定时任务（cron）

会话内可创建定时任务，到点把一段 prompt 自动注入会话（作为 follow-up 消息继续跑）：

- 由 agent 用 `cron_create` / `cron_list` / `cron_delete` 工具管理（也可走 REST `/api/sessions/:id/cron`）；输入框上方「定时 (N)」芯片实时显示本会话任务数，点开可查看与删除
- 5 字段迷你 cron 语法：`分 时 日 月 周`，支持 `*`、`*/n`、`a-b`、`a-b/n`、`a,b` 列表；按 server 本地时区，非法表达式创建时即拒绝并给出可读错误
- recurring 任务创建 7 天后触发最后一次（标记 stale）并自动删除；one-shot 触发一次即删；停机期间错过的多次触发只补一次
- 每会话上限 50 个；任务持久化在 `<业务数据目录>/cron.json`，重启 server 后自动恢复重排；删除会话会级联删除其全部任务

## 对话内容渲染

消息正文、思考过程与工具结果共用同一套 Markdown/LaTeX 渲染：

- 正文支持 GFM Markdown：标题、列表、任务列表、表格、引用、删除线、链接、行内代码与代码块
- 代码块悬停显示复制按钮，一键复制整块内容
- 行内公式使用 `$E=mc^2$`
- 块级公式使用独占一段的 `$$ ... $$`，由 KaTeX 渲染；过宽公式可横向滚动
- 思考过程与流式思考使用同一套 Markdown/LaTeX 渲染，默认折叠，颜色比最终正文更浅；点击「思考过程」或「正在思考」展开。完成后的思考随 assistant 消息落盘，刷新或重开会话仍保留
- 思考、正文与工具调用按真实产生顺序交织渲染；相邻的连续工具调用（≥2 个）自动合并为「N 个工具调用」折叠组，组内一调用一行，点击展开
- 流式正文按增量平滑追加，不整段重排；历史版本按 token 保存的正文分片会在显示时自动合并，不再逐词换行

## 运行中操作

agent 运行期间可用的状态指示与干预手段：

- **运行活动条**：运行时对话轨道底部吸附一条实时活动条，显示运行状态、已耗时（秒级跳动）与当前工具；空闲或结束后自动隐藏
- **中断**：顶部「中断」按钮、Esc 快捷键（或 `POST /api/sessions/:id/abort`）—— 取消当前 LLM 请求 + kill 运行中的工具进程
- **运行失败**：错误卡按类型给出可操作提示（认证失败/权限/限流/过载等），附设置深链按钮（认证/接口不存在/无效请求 → 模型目录）；可重试的错误（限流、过载等）提供「重试」按钮，一键重发上一条用户消息；toast 通知为一行摘要
- **Steering**：运行中追加消息进入队列，下一轮注入
- **权限模式（四档）**：输入区权限弹层切换，随会话保存：
  - `ask` 逐次确认（默认）—— 每个写操作弹权限卡片逐个确认
  - `acceptEdits` 接受编辑 —— 文件编辑类自动放行，bash 等仍需确认
  - `review` 模型审核 —— 需确认的调用先由审核模型评判风险：`fast`（快速模型，未配置则一律转人工）或 `main`（会话当前模型，可选）；判 LOW 自动放行并记录 `permission.reviewed` 审计事件，判 HIGH、审核失败或结果无法解析一律转人工；`git_commit` 永远强制人工
  - `yolo` 完全自主 —— 全部自动放行（**沙盒仍生效**）
- **权限请求**：弹出权限卡片，三选项：
  - `允许一次` —— 仅批准当前工具调用；批准响应先返回浏览器，随后才启动工具
  - `总是允许` —— 二次确认后生成持久规则（如 `bash(npm test)`，按词边界前缀匹配：`npm test -- --watch` 放行、`npm testx` 不放行），随会话保存
  - `拒绝` —— 可附理由回填给 LLM
- 会话头部可选择命令后端：`默认` 按平台探测顺序取第一个可用项——Windows 为 `pwsh > Git Bash > cmd.exe`（Git Bash 解析为 Git for Windows 的 bash.exe 绝对路径，不会命中 WSL 的 `System32\bash.exe`），Linux 为 `bash > pwsh > $SHELL`（`/bin/sh` 兜底）；`PowerShell 7` 强制使用 `pwsh`。该选择同时作用于前台命令、后台任务和 agent 的 bash 工具，并随会话保存。选择 `pwsh` 前需先安装 PowerShell 7。
- **后台 bash 任务**：bash 工具带 `run_in_background=true` 时立即返回 taskId，头部徽标查看运行中任务、点开看输出、随时终止；完成自动通知下一轮
- **通知中心**：活动栏铃铛汇总 toast 与后台事件（任务完成、诊断更新、SCM 更新、后台任务结束），未读角标、可逐条/全部清除、点击跳转相关会话与视图；权限请求与结构化交互不进入通知流，仍是一等卡片
- **结构化提问**：agent 可通过 `ask_user` 工具在运行中向你提问——确认、单选、多选、自由文本四种卡片（一次 1–4 问，选择题 2–4 个选项），挂在对话轨道中等待回答（agent 暂停在「等待确认」状态），回答后 agent 带着答案继续；中断运行自动取消未答问题
- **plan 批准流**：plan 模式下 agent 通过 `exit_plan_mode` 提交完整计划，弹出计划批准卡，三分支——`批准`（按原文切回 build 执行）/ `编辑后批准`（按你改后的文本执行）/ `拒绝`（可附意见，保持 plan 模式继续研究修订）。计划批准不走权限自动放行，yolo 也不会跳过
- **持久 shell**：agent 的 bash 工具默认复用每会话一个持久 shell（沙盒内 pty），`cd` 切换的目录、设置的环境变量跨调用保持；pty 不可用（如旧版 core）或 shell 起不来（如 AppContainer 沙盒下的 pwsh / Git Bash）时透明回退一次性执行，不报错。`run_in_background` 后台任务仍走一次性 job
- **桌面通知**：设置 → 通用开启（默认关，首次需浏览器授权通知权限）；页面失焦时，权限待批、结构化交互待答与 run 终态会弹系统通知，点击跳回对应会话

## 真终端

会话可打开真正的宿主机终端（xterm.js 随需加载，未打开不占用包体积）：server 经 core 的 `pty.*` RPC 桥接（Windows ConPTY / Linux openpty），WebSocket 双向 JSON 帧直连。

- **启用门槛（两条同时满足）**：已开启 TOTP 全局登录；且 server 监听地址为回环或局域网字面量（`0.0.0.0` / `::` 通配监听不满足）。不满足时入口禁用
- 徽章「**宿主机终端 · 以应用身份运行 · 不经沙盒**」：终端进程以 server 应用身份直接运行在宿主机，不走 agent 权限链与沙盒——与输入框 `!` 命令（走与 bash 工具相同的权限链与沙盒）是两条严格区分的通道
- 终端独立于 agent 运行：中断会话不影响终端；页面关闭（WS 断开）即销毁 pty

## 会话生命周期（重要）

会话运行在服务端，不在浏览器里：

- **关闭浏览器标签页不会停止 agent** —— 服务器继续执行，结果照常落盘
- 重新打开 UI 选回该会话，断线期间的事件自动补拉回来；WebSocket 断连期间界面顶部显示「连接中断，正在重连…」横幅，恢复后自动消失
- **重命名**：侧栏双击会话标题或点编辑按钮内联改名
- **置顶**：会话菜单置顶后排在列表最前，再次操作取消
- **删除**：弹确认对话框（不再用浏览器原生确认框），删除后该会话的输入框草稿一并清理
- 主动停作业用「中断」按钮；关掉 server 进程才收尾全部会话与后台任务
- 断线期间发起的权限请求会一直挂起等待响应，**无超时**

## 面板与状态显示

运行状态与上下文信息分布在会话头部徽标、底部面板标签页与侧栏视图中：

- **文件树**（侧栏「文件」视图）：懒加载，文件只读预览
- **上下文窗口**：会话头部实时显示窗口占用 `45k/128k · 38%`（≥70% 变黄、≥85% 变红）与缓存命中胶囊（悬停细分读取/写入/未缓存输入）；底部面板页签条同步显示 `窗口 N%`
- **上下文用量**（底部面板「上下文」标签页）：顶部「上下文窗口」区给出大号占用表、按段（消息/工具结果/repoMap/压缩摘要/系统/其他）堆叠的 token 归因条、本轮/累计缓存命中与水位提示；下方为 token/成本/预算明细，支持 lag/interval/off 策略与驱逐模式（默认节省/超级节省）热调、工具调用/概览压缩、条目逐出/回写/pin，以及 artifact 原文查看
- **子代理**（底部面板「子代理」标签页）：汇总本会话全部 `spawn_task`/`spawn_swarm`——按调用分组，swarm 显示完成/失败/运行中聚合计数与逐项实时进度，可内联展开转录；消息轨道里的子代理卡片也实时刷新（swarm 逐项状态、轮次、工具数），转录展示完整内部消息流（折叠到最近 20 条）；刷新页面后从历史恢复
- **时间线**（底部面板「时间线」标签页）：检查点列表 → diff 查看 → 「完整回滚」或「仅文件」回滚（二次确认），新建检查点；顶部为可交互**会话树**（上限 50 个节点，非活动分支淡化），悬停任意节点可「继续」（检出到该节点，后续消息形成新分支）或「分叉」为新会话
- **消息级操作**：用户消息悬停出现「编辑重发 / 重新生成 / 分叉」——编辑重发把内容回填输入框（附件不重发），发送后从该处另起分支重跑；重新生成直接回退到该条重跑；分叉复制到该条为止的对话进新会话（会话历史是树形存储，旧分支消息始终保留）
- **沙盒状态**：会话头部徽标（enforced / advisory），标识当前沙盒是否生效
- **模式切换**：会话空闲时可在头部直接切换沙盒模式，以及快照的「每轮自动 / 仅手动」模式；运行中会暂时禁用切换
- **命令后端**：会话空闲时可在头部切换「默认 / PowerShell 7」；缺少 `pwsh` 时会返回明确错误，不会悄悄改用其他 shell

## 模型与成本

多服务商接入、会话中热切换与成本核算的要点：

- **模型服务商**：可保存并独立启用多个接口配置，接口类型三种——Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses（`POST /responses`，思维以 reasoning summary 流返回，历史思维链不回传）；每个服务商可自动拉取或手动添加自己的模型，同名模型互不覆盖。每个服务商可配**自定义请求体**（JSON，如 `{"temperature": 0.7, "max_tokens": 8192}`），浅合并进每次模型请求；`model`/`messages`/`stream`/`tools`/`system` 为保留字段不可覆盖
- **会话中热切换模型**：统一列表显示为 `模型ID【服务商】`，下轮生效；账本按新窗口重算，模态不兼容的历史内容替换为占位描述
- **快速模型**：直接从同一统一模型列表中选择，用于上下文压缩与内容透镜；接口、Base URL 和密钥复用所选服务商，可单独设置 thinking、effort 与最大输出上限
- **模型选择器**：输入框下方常驻，模型按供应商分组（可展开收起）；底部固定区显示当前模型能力徽章与思考控件——胶囊开关切换思考，强度用格子档滑动切换（只显示模型声明的档位；未声明思考能力的模型开关默认关、未声明档位时全部可选）
- **思维链回传**：模型能力新增 `reasoningContent` 声明（设置 → 模型目录双击模型编辑）。开启时历史 thinking 块以 `reasoning_content` 回带给 OpenAI 兼容端点（deepseek/qwen/glm/kimi 等新模型要求）；gpt/o 系与 claude 前缀默认关闭，其余默认开启；Anthropic 接口走签名回放不受此开关影响
- **上下文与输出**：未声明的模型默认上下文 256k（deepseek 前缀为 1M）；输出长度默认不封顶（OpenAI 兼容接口不发送 `max_tokens`，需要时经自定义请求体显式设置；Anthropic 接口 `max_tokens` 为强制字段，默认 64k 同样可被自定义请求体覆盖）
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

- **导出分享页**：侧栏会话项 → 「导出分享页」→ 生成自包含只读页（内联样式、零外部资源、全文转义，下载文件名 `session-<id>.html`），可直接发给别人
- **导出 Markdown**：会话头部「导出 Markdown」下载 `session-<id>.md`（活动路径消息，思考折叠、工具调用带围栏），适合贴进文档/Issue
- **导出/导入 JSONL**：会话菜单导出全量历史（`session-<id>.jsonl`），另一台机器导入即恢复

## 配置文件位置

`<启动/设置目录>` 按启动方式确定：用户显式设置的 `OWC_DATA_DIR` 优先；未设置时，安装版启动器会注入平台注册默认值（Windows `%USERPROFILE%\openwebcode`，Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才用相对 `server` 目录的 `../.openwebcode` 作为兜底。旧默认目录 `%LOCALAPPDATA%\openwebcode` 中的数据会在启动器下次启动时一次性自动迁移到新位置。为避免相对路径按 `server` 目录解析，建议为 `OWC_DATA_DIR` 和设置页中的数据目录填写绝对路径。

设置页保存到 `<启动/设置目录>/server-settings.json`。其中已保存的“数据目录”会在**未设置 `OWC_DATA_DIR`**时、下次启动后决定 `<业务数据目录>`；设置文件不会随之移动。未保存覆盖时，`<业务数据目录>` 与 `<启动/设置目录>` 相同。

| 路径 | 用途 |
|---|---|
| `<启动/设置目录>/server-settings.json` | 设置页保存的服务端设置 |
| `<业务数据目录>/provider-profiles.json` | 多模型/联网服务商配置与密钥（本机明文保存，界面仅脱敏显示） |
| `<业务数据目录>/sessions/<id>/` | 会话数据（meta.json + messages.jsonl + ledger.json + artifacts/） |
| `<业务数据目录>/agents/*.md` | 全局自定义子代理 |
| `<业务数据目录>/commands/*.md` | 全局自定义斜杠命令 |
| `<业务数据目录>/skills/<name>/SKILL.md` | 全局 Skills |
| `<业务数据目录>/hooks.json` | 全局 Hooks（**安全级别等同 yolo**） |
| `<业务数据目录>/totp.json` | TOTP 全局登录凭据（权限 0600，恢复码只存哈希） |
| `<业务数据目录>/cron.json` | 全部会话的 cron 定时任务 |
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

四类扩展机制——扩展宿主、子代理、斜杠命令与 Hooks，均支持项目级（`<cwd>/.owc/`）与全局两级：

### Extension Host 与官方扩展

设置 → **扩展** 可管理官方及第三方扩展。内置六项：

- `context-manager`：默认启用，负责工具结果的滚动驱逐策略；停用后不会自动逐出工具结果，85% 核心水位安全网仍保留（「上下文」面板是核心 UI，不受扩展开关影响）
- `attention-optimizer`：默认关闭，把关键约束/目标复制到上下文首尾锚区；`bottomOnly` 缓存影响较小，`full` 会增加输入 token
- `content-lens`：默认关闭；启用且已配置快速模型后，消息旁出现「译」与「解析选中」，结果只存 `translations/`，不进入 LLM 上下文
- `pdf-to-image`：默认启用；通过 Web 选择的 PDF 会先保存到当前工作区 `.owc/uploads/`，再将最多 4 页按 150 DPI、长边最大 2048px 转为图片附件，供支持图片输入的模型读取；停用时 Composer 仅把这个工作区相对路径引用交给主代理处理
- `owc-eval`：默认关闭；启用后底部面板出现「评测」，可选择固定 mock-provider 示例与 0.4 工具契约任务，在独立临时工作区回放 AgentRunner。报告包含断言、工具、token 与耗时；可把历史运行设为基线，与当前运行生成持久化的回归/改善对比并导出自包含 JSON。评测服务内置于 server，不读取原始 API Key；生产运行仍走正常 Core 权限与沙盒边界
- `env-sim`（环境模拟）：默认关闭；启用并选择预设后，系统提示词切换为该产品风格（身份行 + 工作方式），内置工具以该产品的命名/描述呈现（如 `Read`/`Bash`/`Edit`），底层仍走原工具实现与权限链。内置 `claude-code`/`kimi-code`/`zcode`/`codex` 四档预设；把自制预设 JSON（必填 `id`/`name`/`identity`/`basePrompt`，可选 `productSections`/`hideBuiltIns`/`aliases`）放入 `<业务数据目录>/env-sim/personas/` 即可添加并与他人分享，一个文件一个预设

第三方扩展目录需包含 `manifest.json`（`apiVersion: "1"`）；入口默认为 `index.js`，可在 manifest 的 `entry` 字段另行指定。在设置页输入本地绝对路径即可安装。v1 扩展是可信代码，安装即信任其声明权限；单个钩子运行超时 5 秒会被跳过并记录日志。

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

多个独立的同类只读任务可用 `spawn_swarm` 并行（模板 + 逐项替换，2–16 项，并发上限 4，超出自动排队）：

```
spawn_swarm prompt_template="审查 {{item}} 的最近改动，输出风险点" items=["src/auth.ts", "src/api.ts", "src/pay.ts"]
```

`items` 也可逐项指定子代理：`items=[{"task": "审查 src/auth.ts", "agent": "reviewer"}, ...]`（字符串形式仍兼容，`agent` 也可填内置 `general`）。子代理结论按 `[序号/总数]` 聚合返回；派生过程在消息轨道渲染为实时卡片（swarm 逐项状态、轮次与工具数），底部面板「子代理」标签页按调用分组汇总，顶部还可手动启动子代理（任务描述 + 类型选择，`POST /api/sessions/:id/subagents`，并发上限 4，超限直接拒绝）；主窗口子代理标签页以与主对话相同的渲染展示完整转录。每次派生的完整转录存在会话数据目录 `subagents/<taskId>.json`。中断 agent 不会再启动排队中的 swarm 项，也会取消手动启动的子代理。

同一次 `spawn_swarm` 的成员还拥有两个专属工具 `swarm_board_post` / `swarm_board_read`，经共享讨论板互相协调：板文件为会话数据目录下 `subagents/swarm-<id>-board.jsonl`（每行 `{ts, from, text}`，append-only），单次读取限最后 50 条 / 8KB；`spawn_swarm` 汇总时会在聚合结论后附 Board digest（板路径、各成员发帖数与最后几条）。

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

- 事件：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PreCompact` / `PostCompact` / `Notification` / `SubagentStart` / `SubagentStop`
- `matcher`：精确工具名、`前缀*`、`*` 全匹配（无工具名的事件仅 `*` 命中）
- exit 0 放行；exit 2 否决（仅 PreToolUse / PreCompact 两个 Pre 类事件，stderr 回填调用方）；其他非零/超时告警不阻断；Notification、Subagent 类、SessionEnd、PostCompact 等通知类事件的失败与退出码均不阻塞主流程
- 5s 超时杀进程
- **安全级别等同 yolo**：hooks.json 里的 command 由 server 直接 spawn 执行，不经沙盒与权限链。凡是能写 hooks 配置的人即拥有等同 yolo 的执行能力。

## 常见问题

见 [`faq.md`](./faq.md)。
