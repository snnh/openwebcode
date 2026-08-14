# 使用帮助

日常使用 openwebcode 的操作说明。

## **目录**：
1. **首次访问：**
[启动](#启动) | [远程访问与局域网](#远程访问与局域网) | [Linux 安装器交互与自动化](#linux-安装器交互与自动化) 
2. **基础操作：**
[界面语言](#界面语言) | [工作台布局与快捷键](#工作台布局与快捷键) | [Chat 模式](#chat-模式) | [创建会话](#创建会话) | [输入框](#输入框) [对话内容渲染](#对话内容渲染) | [运行中操作](#运行中操作) | [面板与状态显示](#面板与状态显示) | [模型与成本](#模型与成本)
3. **进阶操作：**
[问题与 SCM 面板](#问题problems与源代码管理scm面板) | [远程终端](#远程终端) | [移动端与 PWA](#移动端与-pwa) | [会话管理](#会话管理) | [联网、代理与离线模式](#联网代理与离线模式) | [定时任务（cron）](#定时任务cron) | [Headless CLI](#headless-cli脚本集成) | [工具限制与只读模式](#工具限制与只读模式) | [版本号与更新检查](#版本号与更新检查) 
4. **个性化：**
[配置文件位置](#配置文件位置) | [自定义系统提示词](#自定义系统提示词)  | [自定义扩展点](#自定义扩展点)（包含Skills、斜杠命令、Hooks、自定义子代理、MCP 和 Extension Host 第三方扩展）

5. **常见问题见 [`faq.md`](./faq.md)。**

## 启动

1. 运行 `owc`（Windows：`owc.cmd`；Linux：安装器生成的 `<prefix>/bin/owc`）；
2. 浏览器打开 <http://127.0.0.1:3210>；
3. 首次使用先到 **设置 → 模型目录** 添加模型服务商：选接口类型、填 Base URL 和 API Key、启用，然后刷新模型列表。

还没配任何服务商时，空会话页有三步快速上手引导，按钮直达设置的对应分区；新建会话对话框里的「未配置服务商 / 无可用模型」提示也能点击跳转。服务商表单里的「测试连接」可以在保存前验证配置，认证失败、URL 错误、连不上、限流会分类给出中文提示。

端口被占用或想换端口：设 `OWC_PORT=4000` 再启动 `owc`（1.3.x 起 launcher 与 server 默认端口统一为 3210）。

### 远程访问与局域网

默认只监听 `127.0.0.1`（回环）。要让手机或局域网其他机器访问，把监听地址改成非回环即可。访问令牌不用手工配：服务端首次启动会自动生成并持久化（`<业务数据目录>/access-token`，0600）。

- **Windows / 已装机**：设置 → **远程访问** 把监听地址改为 `0.0.0.0`（重启生效）。改完后该分区会展示带令牌的一键访问链接（可复制、可扫码），服务端启动时也会把链接打印到控制台。Windows 首次监听 `0.0.0.0` 时防火墙会弹窗，选允许。
- **Linux 新装**：`./install.sh --lan`（等价 `--host 0.0.0.0`）；搭配 `--enable-service` 时安装结束直接打印访问链接，root 系统级安装可以再加 `--open-firewall` 自动放行防火墙端口（见下文「Linux 安装器交互与自动化」）。

访问方式：

1. 局域网设备的浏览器打开 `http://<主机>:<端口>/?token=<令牌>`，服务端校验后写入 HttpOnly Cookie，之后访问不用再带令牌；
2. `owc run` 访问带令牌的实例时，把同一令牌放进 `OWC_ACCESS_TOKEN` 环境变量（走 Bearer 头）；
3. 设置 → **远程访问** 可随时重新生成令牌，旧链接与已登录设备立即失效；令牌由环境变量显式配置时不出现在该分区，需在环境中轮换。

显式覆盖：`OWC_ACCESS_TOKEN`（≥32 字符）固定令牌；`OWC_ALLOWED_ORIGINS`（逗号分隔的 http(s) 源）限定浏览器来源，缺省放行与访问地址同源的请求。非回环 + 令牌只是准入门槛，仍建议只在受信网络使用。

同一分区还有 **TOTP 全局登录** 向导。启用后所有浏览器访问都要先输入认证器 App 的 6 位动态码（RFC 6238，30 秒步长）才能进界面：

- 向导生成 base32 密钥，可扫码或手动录入认证器；启用时展示 **10 个一次性恢复码**（服务端只存哈希，用完即删），请离线保存
- 登录票据有效期 12 小时、随有效请求滑动续期，只驻留内存——重启 server 后所有浏览器要重新登录；每个 IP 连续 5 次失败锁定 60 秒
- 凭据存 `<业务数据目录>/totp.json`（权限 0600）；向导里可停用或重新生成密钥
- `OWC_ACCESS_TOKEN` 的 Bearer 通道保留给 `owc run` 等机器访问，与 TOTP 并存，任一通过即可

### Linux 安装器交互与自动化

从 Linux tar.gz 解包后直接运行 `./install.sh`，且 stdin/stdout 都是终端时，安装器会依次询问命令行没给的选项：安装前缀、端口、数据目录、是否开启局域网访问、是否使用系统 Node.js，以及 systemd 服务（是否写入、是否立即启用启动；root 且开启局域网访问时还会问是否放行防火墙端口）。直接回车保留默认值；命令行参数优先。

```sh
# 自动化、CI、管道或重定向中：--yes 保证绝不读取交互输入。
./install.sh --yes --prefix "$HOME/.local" --port 3210 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1

# 服务器一键安装（root）：系统级路径 + 局域网访问 + systemd 开机自启 + 防火墙放行，
# 安装结束直接打印带令牌的访问链接。
sudo ./install.sh --yes --system --lan --enable-service --open-firewall
```

- `--prefix` 与 `--data-dir` 必须是绝对路径；prefix 创建后会规范化并拒绝根目录。默认按用户分层：普通用户 `~/.local` + `${XDG_DATA_HOME:-~/.local/share}/openwebcode`；root（或显式 `--system`，需 root）`/usr/local` + `/var/lib/openwebcode`。
- `--port` 只接受 1–65535；`--host` 默认 `127.0.0.1`，`--lan` 是 `--host 0.0.0.0` 的快捷方式（互斥）。非回环监听只应放在受信网络或认证反向代理后。
- `--with-systemd` 写服务文件但不启用（root 写 `/etc/systemd/system/openwebcode.service`，否则写用户级 unit）；`--enable-service` 隐含写入并立即 `systemctl enable --now`。用户级服务要开机自启（未登录也运行）需再执行 `loginctl enable-linger $USER`。
- `--open-firewall` 仅在 root + 非回环监听时可用，检测 firewalld/ufw 放行端口；没检测到就打印手动放行提示。
- `--use-system-node` 不复制包内 `node/`，并在安装时验证 `PATH` 中的 Node.js 为 24+。
- 运行时的 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 始终覆盖安装时写入的默认值。`--with-desktop-entry` 目前会明确失败，尚未提供桌面集成。
- 服务以 root 运行时，agent 工具执行的命令同样是 root 权限（沙盒不降低这一风险），请只运行可信任务。
- 卸载：运行安装时落盘的 `<prefix>/bin/owc-uninstall`（发行包根目录也有 `uninstall.sh`），会停止并移除 systemd 服务、删除运行时与启动器；数据目录默认保留，`--purge-data` 一并删除，`--remove-firewall`（root）移除防火墙规则。

## 界面语言

- 首次打开时，浏览器语言以 `zh` 开头用简体中文，其余用英文。
- **设置 → 外观 → 语言** 可随时切换 `简体中文` / `English`，不用重启或刷新。
- 选择存在浏览器 localStorage 的 `owc-language`，只影响当前浏览器，不改模型的默认回复语言。
- 模型回复语言由提示词及 **设置 → 通用 → 默认语言** 控制，与界面语言相互独立。
- 切换语言会同步更新页面 `<html lang>`；日期、时间和数字按当前界面语言格式化。
- 从会话栏导出的自包含 HTML 分享页也沿用当前界面语言。
- **设置 → 外观 → 主题** 可选浅色/深色/跟随系统；**强调色**默认为中性石墨灰，另有多色预设与「自定义」色卡——支持任意 RGB（调色板或 hex 输入），悬停/底色/文字色自动派生，亮暗主题各自适配。

## 工作台布局与快捷键

界面为五区布局：**活动栏**（左侧窄条：会话/文件/SCM/设置等入口）、**侧栏**、**主区**（会话轨道与输入框）、**底部面板**（上下文/时间线/子代理/沙盒/成本/性能等标签页）、**页签状态区**。会话状态信息（状态、模式、模型、窗口占用、成本）在底部面板页签条右侧，桌面端显示完整项，移动端精简为状态点+模式+模型。打开会话先显示骨架屏，避免欢迎页闪烁。布局状态（侧栏宽度、面板开合等）保存在本机浏览器。

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
| `Shift+?` | 打开设置 → **快捷键** 页签 |

完整键位见设置 → **快捷键** 页签，暂不支持自定义键位。输入框聚焦时全局快捷键不抢键。设置本身是一个整页对话框：左侧导航轨按「个人偏好 / AI 与服务 / 能力与连接 / 系统」分组列出页签（外观、通用、会话默认、快捷键、模型目录、模型选择、联网服务、模型定价、提示词、技能、扩展、远程访问、通知、服务信息），列表带搜索框，按分区/分组/字段名（中英文）直接定位；界面各处的设置入口（如「前往模型目录」「打开模型设置」）会深链到对应页签。

## Chat 模式

ChatGPT 风格的纯对话模式，与编码工作台并存，适合问答、写作、翻译、数据分析等不需要改代码的场景。**默认关闭**：设置 → **通用** 打开「Chat 模式」后，侧栏出现 chat / 工作台切换开关。

- **界面**：左侧可折叠会话栏（新建 / 重命名 / 删除 / 分享 / 分支，顶部搜索框按标题过滤），中间窄列消息流，底部输入框。支持 Markdown / LaTeX 渲染，粘贴或选择图片上传（小图直接内嵌，大图落盘为引用，单条消息最多 3 张；**不输入文字也可直接发送纯图片消息**，即贴即问）。上翻阅读时右下出现「回到底部」浮钮（与工作台同款）；首页空态建议每屏 3 条、「换一批」轮转，**点击建议直接发送**（自动建会话后即发）。assistant 消息的思考内容以可折叠「思考过程」块展示（默认收起，流式期间实时可见，刷新后可展开回看）。
- **会话树**：每条 assistant 消息可「重新生成」（从该点长出新分支，旧分支不丢）；纯文本 user 消息可「编辑重发」（就地编辑后经 edit 路由长出新分支，旧分支同样保留）；会话可分支 / fork / 回溯到任意消息继续。
- **助手预设**：把系统提示词、模型覆盖、生成参数（temperature / topP / maxTokens / 推理档）、预置消息和工具清单打包成可切换的角色；内置「通用助手」「编程助手」，可自行新建。
- **工具**（默认全关，在会话设置里逐个开启）：
  - 实用：`time`、`calculate`
  - 联网：`web_search`、`web_fetch`（服务商在 设置 → 联网服务 选择，与工作台共用）
  - 媒体：`image_gen`（可选画面比例）、`vision`（分析对话图片 / 会话文件 / 网页图片，可选推理档）。两者使用的能力模型在 chat 设置中挑选——候选按模型能力声明过滤（能看图 / 能出图）；主对话模型本身具备对应能力时，该工具开关自动隐藏，图片直进对话
  - 沙盒（需先开「沙盒」总开关）：`python`、`read_file`、`write_file`、`show`
- **Python 沙盒**：uv 管理的独立环境预装 numpy / pandas / matplotlib / sympy / scipy / Pillow，不能额外装包；Linux 用 bubblewrap 全隔离（禁网），Windows 用 Job Object 约束进程树（无网络/文件系统隔离，工具结果如实标注）。matplotlib 保存的图直接内联回对话。
- **分享**：会话菜单 → 分享生成只读公开链接（可设访问密码），任何浏览器可打开；再次进入菜单可撤销。分享页是快照式只读，不含后续新消息。
- **鉴权**：局域网内打开 chat 页面可直接对话（免令牌）；修改 chat 配置、切换进工作台仍需访问令牌。要关闭局域网免令牌，在数据目录 `chat.json` 里设 `"lanUnauthenticated": false`。
- **数据位置**：chat 会话独立存于 `<数据目录>/chat-sessions/`，与工作台会话互不影响；全局配置在 `<数据目录>/chat.json`，助手预设在 `chat-assistants.json`。

## 创建会话

侧栏 **+** 新建会话，对话框里的选项：

- **工作目录**：agent 的 cwd，文件读写/命令执行都在此目录下（受沙盒约束）。可手输绝对路径，也可点输入框旁的「浏览…」按钮在弹层中导航选择——面包屑可跳回任意层级，列表里目录可进入、文件灰显仅作定位参考、符号链接标记但不跟随。浏览范围受**目录浏览根**限制（见「配置文件位置」），默认为用户家目录，可在 `server-settings.json` 的 `browseRoots` 或环境变量 `OWC_BROWSE_ROOTS` 中配置；手动输入路径仅校验是否存在，不受浏览根约束
- **模型**：从所有已启用服务商的模型列表中选择，格式为 `模型ID【服务商】`
- **沙盒模式**：
  - Windows：`Job Object`（默认，兼容模式）/ `AppContainer`（更强隔离，兼容性较差）/ `WSB`（Windows Sandbox，跑不可信代码用，一会话一 VM，关闭即销毁）/ `关闭`
  - Linux：`bubblewrap`（默认，mount/net namespace 隔离；无 bwrap 环境自动回落 Landlock）/ `Landlock`（强制后端）/ `关闭`
  - `关闭` 是完全不沙盒，不推荐
  - Linux 沙盒内使用 git/gh：宿主的 `~/.gitconfig`、`~/.git-credentials`、`~/.config/git`、`~/.config/gh`、`~/.ssh`（仅实际存在的项）会以只读方式挂入沙盒，`git push` / `gh` 可直接使用宿主凭据；这些路径只读且对文件工具不可见（仅沙盒内进程可读）
- **网络**：`允许（默认）` / `拒绝` / `代理过滤（仅 Windows）`。filtered 档让沙盒内进程经 sidecar 代理出网，默认全放行；拦截域名在 **设置 → 服务信息** 的「沙盒代理拦截域名」维护（每行一个域名、含其子域，最多 64 个，保存后对活跃会话热生效；对应环境变量 `OWC_SANDBOX_PROXY_DENY_LIST`）
- **初始化脚本**（仅 WSB）：沙盒启动后、agent 启动前执行的命令
- **工作区模式**：
  - `直接` —— 工作目录就是文件系统里的真实目录。Linux 上若 core 上报 `features.overlay.supported` 且工作区不在 btrfs/zfs 上，`直接` 会话会在创建时自动升级为 overlayfs 托管语义（见「面板与状态显示」的快照后端说明）；能力缺失或挂载失败时静默回落，快照退为 git shadow
  - `托管工作区` —— 项目复制进 VHDX/qcow2 稀疏镜像盘挂载点，快照走差分链（毫秒级、可分支）
- **目录绑定（Bind Link，可选）**：Windows 11 24H2+，面向 `Job Object` / `AppContainer` 沙盒模式。把会话工作区内的虚拟路径绑定到工作区外的真实目录，agent 进程经虚拟路径透明读写（`readOnly` 时只读），常用于共享依赖缓存。对话框里直接添加（≤16 项，`virtPath` 必须在会话可写根内、`backingPath` 必须是已存在目录）；REST 入参为 `bindLinks` 数组。创建绑定需要 server **以管理员权限运行**，且 core 上报 `features.bindLink`（`GET /api/core` 可见）；不满足时创建会话直接报错，不静默降级。绑定是全系统可见的命名空间映射，会话清理/删除时撤销，异常退出最迟重启失效；不支持 WSB 模式
- **工具白名单 / 黑名单（可选）**：逗号分隔的内置工具名，限制本会话暴露给模型的工具（语义见「工具限制与只读模式」）
- **备选模型（可选）**：最多 3 个，主模型因限流/过载等可恢复错误重试耗尽后按顺序自动切换（语义见「备选模型（fallback）」）
- **Plan/Code 模式**：创建后可随时在输入区「模式」弹层切换，plan 与 goal 互斥：
  - `code`（默认）—— 正常执行
  - `plan`（计划）—— 只读调研，产出分步计划，经结构化批准后才切回执行（见「运行中操作」的 plan 批准流）
  - `goal`（目标）—— 目标模式：主模型每轮自评目标达成度，未达成（GOAL_INCOMPLETE）自动续跑，最多 10 次后停止
  - 同层 `Swarm` 为独立开关，可与任一模式叠加 —— 提示词鼓励 agent 用 `spawn_swarm` 并行派生同类子任务

**设置 → 会话默认** 可以预设新建会话的默认模型与默认权限模式（存在本机浏览器，不预设则按服务商列表与 `ask` 兜底）。

## 输入框

| 输入 | 含义 |
|---|---|
| `普通文本` | 发给 agent 的任务描述 |
| `/技能名` | 触发 Skill（项目 `.owc/skills/` 或全局） |
| `/自定义命令` | 触发自定义斜杠命令（项目 `.owc/commands/` 或全局） |
| `/compact` | 概览压缩上下文（快速模型做结构化摘要） |
| `/compact tools` | 规则压缩（toolcalls 占位精炼） |
| `/clear` | 清空当前视图，**保留历史**（JSONL 全量在盘，可回滚） |
| `/init` | 分析当前工作区并生成/更新根目录 `AGENTS.md`（写文件走权限链） |
| `/help` | 打开设置 → **快捷键** 页签 |
| `@路径` | 引用工作区文件，内容随消息注入（大文件截断 + artifact 指针） |
| `!命令` | shell 快捷前缀，走与 bash 工具相同的权限链执行，结果可一键「发给 agent」 |

- `@` 触发文件补全下拉（防抖 200ms，键盘上下/回车/Esc）；已建索引时索引优先、未建索引自动回退 glob，符号条目显示 kind 与位置，选中插入 `@路径:行号`
- 图片附件最多 4 张、每张 ≤5MB（png/jpeg/webp/gif）；PDF 附件 ≤20MB（由 pdf-to-image 扩展转为图片，见「自定义扩展点」）；`@` 引用每条消息最多 10 个；运行中带附件的消息不能进 steering 队列，需等运行结束
- 首行或输入为空时按 `↑`/`↓` 召回历史消息，当前草稿自动暂存、翻到底恢复
- 输入框草稿按会话持久化到浏览器 localStorage，刷新后自动恢复，删除会话时清理
- 运行中再发消息会进入 **steering 队列**，下一轮注入，不中断当前作业
- 默认 Enter 发送、Shift+Enter 换行；可在设置里改成 Ctrl+Enter 发送

## 对话内容渲染

消息正文、思考过程与工具结果共用同一套 Markdown/LaTeX 渲染：

- 正文支持 GFM Markdown：标题、列表、任务列表、表格、引用、删除线、链接、行内代码与代码块
- 代码块悬停显示复制按钮，一键复制整块内容
- 行内公式 `$E=mc^2$`；块级公式用独占一段的 `$$ ... $$`，由 KaTeX 渲染，过宽可横向滚动
- 思考过程默认折叠，颜色比最终正文更浅；点「思考过程」或「正在思考」展开。完成后的思考随 assistant 消息落盘，刷新或重开会话仍保留
- 思考、正文与工具调用按真实产生顺序交织渲染；相邻的连续工具调用（≥2 个）自动合并为「N 个工具调用」折叠组，组内一调用一行，点击展开
- 流式正文按增量平滑追加，不整段重排；历史版本按 token 保存的正文分片会在显示时自动合并
- **压缩检查点行**：`/compact` 或 85% 水位强制压缩开始时，消息流尾部出现「正在压缩上下文」活动行；完成后原位沉降为常驻检查点行（模式徽标 + 手动/强制标注 + 被压缩条数与 token 估算），带摘要的记录可展开查看摘要与指令清单；压缩失败转为常驻错误行（可关闭）。多次压缩各自留行，刷新后从上下文账本逐条还原；行只是视图投影，历史消息原文不动
- **`/clear` 分隔线**：清空点渲染为带图标的「上下文已清空（历史保留）」分隔线（悬停可见清空时间），与压缩检查点行同视觉族
- **本轮产出文件行**：一轮中 write_file/edit_file 触及的文件在该轮末尾汇总为一行（按路径去重，标注写入/编辑），点击文件直接在编辑器分栏打开；工具调用卡展开区也有同款文件路径链接（旁边保留「在 diff 中打开」）

## 运行中操作

agent 运行期间的状态指示与干预手段：

- **运行活动条**：对话轨道底部吸附一条实时活动条，显示运行状态、已耗时（秒级跳动）与当前工具；空闲或结束后自动隐藏
- **中断**：顶部「中断」按钮、Esc 快捷键（或 `POST /api/sessions/:id/abort`）——取消当前 LLM 请求 + kill 运行中的工具进程
- **运行失败**：错误卡按类型给出可操作提示（认证失败/权限/限流/过载等），附设置深链按钮（认证/接口不存在/无效请求 → 模型目录）；可重试的错误（限流、过载等）提供「重试」按钮，一键重发上一条用户消息；toast 通知为一行摘要
- **Steering**：运行中追加消息进入队列，下一轮注入
- **权限模式（四档）**：输入区权限弹层切换，随会话保存：
  - `ask` 逐次确认（默认）—— 每个写操作弹权限卡片逐个确认
  - `acceptEdits` 接受编辑 —— 文件编辑类自动放行，bash 等仍需确认
  - `review` 模型审核 —— 需确认的调用先由审核模型评判风险：`fast`（快速模型，未配置则一律转人工）或 `main`（会话当前模型，可选）；判 LOW 自动放行并记录 `permission.reviewed` 审计事件，判 HIGH、审核失败或结果无法解析一律转人工；`git_commit` 永远强制人工
  - `yolo` 完全自主 —— 全部自动放行（**沙盒仍生效**）；从其他档位切入 yolo 会先弹风险确认对话框（明确「只跳过确认、不解除或扩大沙盒」），勾选「我已了解风险」后才生效
- **权限请求**：弹出权限卡片，三个选项：
  - `允许一次` —— 仅批准当前工具调用；批准响应先返回浏览器，随后才启动工具
  - `总是允许` —— 二次确认后生成持久规则（如 `bash(npm test)`，按词边界前缀匹配：`npm test -- --watch` 放行、`npm testx` 不放行），随会话保存
  - `拒绝` —— 可附理由回填给 LLM
- **命令后端**：会话头部可选 `默认` 或 `PowerShell 7`。`默认` 按平台探测顺序取第一个可用项——Windows 为 `pwsh > Git Bash > cmd.exe`（Git Bash 解析为 Git for Windows 的 bash.exe 绝对路径，不会命中 WSL 的 `System32\bash.exe`），Linux 为 `bash > pwsh > $SHELL`（`/bin/sh` 兜底）。该选择同时作用于前台命令、后台任务和 agent 的 bash 工具，随会话保存。选 `pwsh` 前需先安装 PowerShell 7；缺少时会返回明确错误，不会悄悄改用其他 shell
- **持久 shell**：agent 的 bash 工具默认复用每会话一个持久 shell（沙盒内 pty），`cd` 切换的目录、设置的环境变量跨调用保持；pty 不可用（如旧版 core）或 shell 起不来（如 AppContainer 沙盒下的 pwsh / Git Bash）时透明回退一次性执行，不报错。`run_in_background` 后台任务仍走一次性 job
- **会话环境变量**：bash 工具的执行环境中自动注入四个会话元数据变量——`OWC_SESSION_ID`（会话 id）、`OWC_WORKSPACE`（会话工作目录）、`OWC_SANDBOX_MODE`（沙盒模式，如 `jobobject`）、`OWC_AGENT_MODE`（agent 模式，如 `code`/`plan`）。持久 shell 开壳时激活一次，一次性回退路径逐命令前置 export，脚本可依此感知会话上下文
- **Python 环境**：会话头部「虚拟环境」切换 bash 工具的 python 运行环境——`本机环境` / `uv·工作区`（在项目工作区 `.owc/venv` 创建 uv 虚拟环境）/ `uv·配置目录`（在数据目录 `venvs/` 下按工作区路径哈希隔离创建）。venv 懒创建，不走 activate 脚本而是把 `Scripts`/`bin` 前置 PATH；uv 不可用或建环境失败时回退本机环境，输出前置一行说明。全局默认在 **设置 → 服务信息**（`OWC_PYTHON_ENV`），会话值优先
- **Node 环境**：会话头部「Node 环境」切换——`本机 global` / `工作区 project`（`node_modules/.bin` 前置 PATH）/ `fnm` / `nvm`（版本管理器激活；fnm 不支持 cmd，nvm 仅 POSIX bash/sh）。管理器不可用时同样回退本机环境并前置说明。全局默认在 **设置 → 服务信息**（`OWC_NODE_ENV`），会话值优先。Linux 沙盒下工具链目录按该选择只读挂入沙盒（`global` 解析宿主 PATH 上生效的 node/npm 工具链根，`nvm` 挂 `$NVM_DIR`，`fnm` 挂 fnm 安装目录），node 经 nvm/fnm 安装时沙盒内 `node`/`npm` 同样可用；挂载只读且对文件工具不可见，切换后下次工具调用自动重配
- **顶栏读数**：tokens·成本（未定价部分标 `*`）、上下文窗口占用、缓存命中率（累计口径标注，低于 30% 标红、30–60% 标黄；悬停看精确百分比与读/写 tokens）
- **后台 bash 任务**：bash 工具带 `run_in_background=true` 时立即返回 taskId，头部徽标查看运行中任务、点开看输出、随时终止；完成自动通知下一轮。弹层里运行中任务排前（先启动的在前）并逐秒跳动耗时，已结束任务按结束时间倒序排后并弱化显示（悬停恢复）；Esc 或点击外部关闭弹层并把焦点还给徽标按钮
- **通知中心**：活动栏铃铛打开设置 → **通知** 页签，汇总 toast 与后台事件（任务完成、诊断更新、SCM 更新、后台任务结束），未读角标、进入页签即全部已读、可逐条/全部清除、点击跳转相关会话与视图；权限请求与结构化交互不进通知流，仍是一等卡片
- **结构化提问**：agent 可通过 `ask_user` 工具在运行中向你提问——确认、单选、多选、自由文本四种卡片（一次 1–4 问，选择题 2–4 个选项），挂在对话轨道中等待回答（agent 暂停在「等待确认」状态），回答后带着答案继续；中断运行自动取消未答问题。单/多选题会自动附加「其他」选项，后面紧跟输入框，选中后可输入自定义回答
- **plan 批准流**：plan 模式下 agent 通过 `exit_plan_mode` 提交完整计划，弹出计划批准卡，三分支——`批准`（按原文切回 build 执行）/ `编辑后批准`（按你改后的文本执行）/ `拒绝`（可附意见，保持 plan 模式继续研究修订）。计划批准不走权限自动放行，yolo 也不会跳过
- **桌面通知**：设置 → 通用开启（默认关，首次需浏览器授权通知权限）；页面失焦时，权限待批、结构化交互待答与 run 终态会弹系统通知，点击跳回对应会话

## 面板与状态显示

运行状态与上下文信息分布在会话头部、底部面板标签页与侧栏视图中：

- **文件树**（侧栏「文件」视图）：懒加载；文件只读预览——超过 2000 行可点「加载更多」分页续读，图片（png/jpg/gif/webp/svg/ico/bmp）直接显示，Markdown 可切换「渲染/源码」双态，头部可一键「在编辑器中打开」
- **上下文窗口**：会话头部实时显示窗口占用 `45k/128k | 38%`（≥70% 变黄、≥85% 变红）与缓存命中胶囊（悬停细分读取/写入/未缓存输入）；底部面板页签条同步显示 `窗口 N%`
- **上下文用量**（底部面板「上下文」标签页）：顶部「上下文窗口」区给出大号占用表、按段（消息/工具结果/repoMap/压缩摘要/系统/其他）堆叠的 token 归因条、本轮/累计缓存命中（低于 30% 标红、30–60% 标黄）与水位提示、被驱逐工具结果的 tokens/条数读数（原文存 artifact，agent 可 read_artifact 召回）；下方为 token/成本/预算明细，支持 lag/interval/off 策略与驱逐模式（默认节省/超级节省）热调、工具调用/概览压缩、条目逐出/回写/pin，以及 artifact 原文查看
- **子代理**（底部面板「子代理」标签页）：汇总本会话全部 `spawn_task`/`spawn_swarm`——按调用分组，swarm 显示完成/失败/运行中聚合计数与逐项实时进度，可内联展开转录；消息轨道里的子代理卡片也实时刷新（swarm 逐项状态、轮次、工具数），转录展示完整内部消息流（折叠到最近 20 条）；刷新页面后从历史恢复
- **时间线**（底部面板「时间线」标签页）：检查点列表 → diff 查看 → 「完整回滚」或「仅文件」回滚（二次确认），新建检查点；顶部为可交互**会话树**（上限 50 个节点，非活动分支淡化），悬停任意节点可「继续」（检出到该节点，后续消息形成新分支）或「分叉」为新会话
- **快照后端**：按平台自动探测，徽标显示当前后端与成本特征。Linux：btrfs（子卷快照，即时 CoW）→ zfs（数据集快照，即时）→ overlayfs（ext4 等通用文件系统；优先内核 overlayfs 挂载——需 root/CAP_SYS_ADMIN，否则退化 fuse-overlayfs 用户态挂载；检查点为 upper 层变更的线性复制）→ git shadow（线性拷贝兜底）；Windows：ReFS（块克隆）→ git shadow。overlayfs 会话的工作目录是 merged 视图、源目录保持只读：改动在 upper 层累积，检查点/回滚只作用于 upper；确认后才经「文件」面板的「同步回源」写回源目录（node_modules/.git/.env 等不回写），关闭或删除会话不会自动回写。回滚时若存在运行中的任务会被拒绝，需先停止当前任务
- **消息级操作**：用户消息悬停出现「编辑重发 / 重新生成 / 分叉」——编辑重发把内容回填输入框（附件不重发），发送后从该处另起分支重跑；重新生成直接回退到该条重跑；分叉复制到该条为止的对话进新会话（会话历史是树形存储，旧分支消息始终保留）
- **沙盒状态**：会话头部徽标（enforced / advisory），标识当前沙盒是否生效
- **模式切换**：会话空闲时可在头部直接切换沙盒模式、快照的「每轮自动 / 仅手动」、命令后端、Python 环境与 Node 环境；运行中会暂时禁用切换

## 模型与成本

- **模型服务商**：可保存并独立启用多个接口配置，接口类型三种——Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses（`POST /responses`，思维以 reasoning summary 流返回，历史思维链不回传）；每个服务商可自动拉取或手动添加自己的模型，同名模型互不覆盖。每个服务商可配**自定义请求体**（JSON，如 `{"temperature": 0.7, "max_tokens": 8192}`），浅合并进每次模型请求；`model`/`messages`/`stream`/`tools`/`system` 为保留字段不可覆盖
- **会话中热切换模型**：统一列表显示为 `模型ID【服务商】`，下轮生效；账本按新窗口重算，模态不兼容的历史内容替换为占位描述
- **快速模型**：直接从同一统一模型列表中选择，用于上下文压缩与内容透镜；接口、Base URL 和密钥复用所选服务商，可单独设置 thinking 与 effort
- **会话默认模型与四档角色**（设置 → 模型选择）：「会话默认」决定新建会话的模型（未设置时取第一个服务商的第一个模型）；「极致 / 平衡 / 快速 / 廉价」四档角色各指派一个模型——快速档即上面的快速模型。主代理派发子代理时可按任务选档（`spawn_task`/`spawn_swarm` 的 `role` 参数，或自定义子代理 frontmatter 的 `role:`/`provider:`）：难题用极致、常规执行用平衡、要速度用快速、批量轻活用廉价；未配置的角色回落平衡档，再回落会话当前模型；用量与成本按实际生效的服务商与模型归属
- **模型选择器**：输入框下方常驻，模型按供应商分组（可展开收起）；底部固定区显示当前模型能力徽章与思考控件——胶囊开关切换思考，强度用格子档滑动切换（只显示模型声明的档位；未声明思考能力的模型开关默认关、未声明档位时全部可选）
- **思维链回传**：模型能力新增 `reasoningContent` 声明（设置 → 模型目录双击模型编辑）。开启时历史 thinking 块以 `reasoning_content` 回带给 OpenAI 兼容端点（deepseek/qwen/glm/kimi 等新模型要求）；gpt/o 系与 claude 前缀默认关闭，其余默认开启；Anthropic 接口走签名回放不受此开关影响
- **上下文与输出**：未声明的模型默认上下文 256k（deepseek 前缀为 1M）；输出长度默认不封顶（OpenAI 兼容接口不发送 `max_tokens`，需要时经自定义请求体显式设置；Anthropic 接口 `max_tokens` 为强制字段，默认 64k 同样可被自定义请求体覆盖）
- **成本报表**：摘要卡（成本/调用/输入输出/缓存命中率/缓存节省——按定价目录「全价输入 − 缓存读价」价差估算，未定价部分标 `*`）+ 按日/按会话明细表（含命中%列，数字右对齐、表头吸顶、超过 10 组分页），双币种（USD/CNY）汇率折算，预算触发暂停
- **模型定价**：设置 → 模型定价 → 添加条目。价格单位是"每百万 tokens 的元/美元"；输入、输出单价必填，缓存读/写可空（按 `0` 保存），生效日期默认当天并可修改
- 同一 provider/model 的生效区间不能重叠；历史价格或复杂区间可用「编辑 JSON」维护 `effectiveFrom` / `effectiveUntil`

## 问题（Problems）与源代码管理（SCM）面板

- **问题面板**：`test_runner` 工具跑测试/构建/lint 后，结构化诊断（vitest/jest、pytest、go test、dotnet test）按文件分组展示，可按严重度过滤、查看来源工具；点击条目跳转到只读代码视图的对应行列。agent 运行中产生新诊断时以角标提示，不打断当前操作。
- **SCM 面板**：展示当前分支、ahead/behind 与变更文件分组（已暂存/更改/未跟踪）；每行悬停出现行内操作——未暂存组 `+` 暂存 / `↩` 放弃更改，已暂存组 `-` 移出暂存，未跟踪组 `+` 暂存 / 删除（二次确认）；点击文件看只读 diff（未跟踪文件直接显示内容，大 diff 落 artifact 并提示）；底部「历史」折叠区显示最近提交（短哈希 + 主题 + 作者 + 相对时间）；填写提交信息后点「提交（需确认）」会经对话下发 `git_commit` 工具，提交动作始终需要确认（yolo 也不例外）；worktree 创建一键执行、合回一键执行（冲突列表直接展示）、移除需两步确认。agent 写文件或编辑器保存后面板自动刷新；无 git 仓库的会话面板会如实标注降级。
- **只读代码视图**：Shiki 高亮 + 行号 + 行列跳转的统一代码查看形态，从工具卡、问题面板、SCM diff 或 Quick Open 打开，`Esc`/关闭即回到对话。工具卡文件变化、Problems 跳转、SCM diff 还可打开 Monaco 编辑器/分栏 diff（随需加载，未打开不占用包体积），支持逐 hunk 接受/拒绝；加载失败降级为只读视图，窄屏（≤1024px）则为覆盖主区的全屏临时视图。

## 远程终端

会话可打开真正的宿主机终端（xterm.js 随需加载，未打开不占用包体积）：server 经 core 的 `pty.*` RPC 桥接（Windows ConPTY / Linux openpty），WebSocket 双向 JSON 帧直连。

- **启用门槛（两条同时满足）**：已开启 TOTP 全局登录；且 server 监听地址为回环或局域网字面量（`0.0.0.0` / `::` 通配监听不满足）。不满足时入口禁用
- 徽章「**宿主机终端 | 以应用身份运行 | 不经沙盒**」：终端进程以 server 应用身份直接运行在宿主机，不走 agent 权限链与沙盒——与输入框 `!` 命令（走与 bash 工具相同的权限链与沙盒）是两条严格区分的通道
- 终端独立于 agent 运行：中断会话不影响终端；页面关闭（WS 断开）即销毁 pty

## 移动端与 PWA

- 浏览器「安装到主屏」（PWA manifest，standalone 模式）后可像应用一样打开；不做离线缓存——应用强依赖实时连接。
- 窄窗口（≤1024px）为单列布局：导航收进左上角面板图标触发的左侧滑出菜单（图标+文字竖向列表，视图与功能两分组）；菜单选视图后收缩为左侧纯图标栏、右侧整屏展示对应面板（再点当前视图图标或遮罩/Esc 收起），设置走同一导航轨整页打开（点项钻取、可返回）；底部面板变全屏 sheet（标签默认只显示 上下文/时间线/成本，其余收进可展开的第二行；面板内容全部断行/堆叠适配，无左右滚动）、编辑器/diff 变覆盖主区的全屏临时视图；核心操作（权限卡、结构化交互、队列、启停 run、切换会话）均可在 3 次点击内完成，按钮点击目标 ≥44px。
- 移动端访问即非回环监听，访问令牌与一键访问链接见上文「远程访问与局域网」。

## 会话管理

会话运行在服务端，不在浏览器里：

- **关闭浏览器标签页不会停止 agent** —— 服务器继续执行，结果照常落盘
- 重新打开 UI 选回该会话，断线期间的事件自动补拉回来；WebSocket 断连期间界面顶部显示「连接中断，正在重连…」横幅，恢复后自动消失
- **重命名**：侧栏双击会话标题或点编辑按钮内联改名
- **置顶**：会话菜单置顶后排在列表最前，再次操作取消
- **删除**：弹确认对话框，删除后该会话的输入框草稿一并清理
- 主动停作业用「中断」按钮；关掉 server 进程才收尾全部会话与后台任务
- 断线期间发起的权限请求会一直挂起等待响应，**无超时**

导出与分享：

- **导出分享页**：侧栏会话项 → 「导出分享页」→ 生成自包含只读页（内联样式、零外部资源、全文转义，下载文件名 `session-<id>.html`），可直接发给别人
- **导出 Markdown**：会话头部「导出 Markdown」下载 `session-<id>.md`（活动路径消息，思考折叠、工具调用带围栏），适合贴进文档/Issue
- **导出/导入 JSONL**：会话菜单导出全量历史（`session-<id>.jsonl`），另一台机器导入即恢复

### 备选模型（fallback）

会话可为主模型配置最多 3 个备选模型，构成 fallback 链：

- **配置入口**：新建会话对话框的「备选模型」区（最多 3 行，选项来自已启用的模型目录）；REST 为 `POST /api/sessions`、`PUT /api/sessions/:id/config` 的 `fallbackModels` 字段（`{provider, model}` 数组；`null` 或 `[]` 清除，缺省保持不变）；CLI 为 `owc run "..." --fallback-models provider/model,provider/model`（格式错误退出码 1）
- **触发条件**：主模型在运行中因**可恢复错误**（限流 / 过载 / 超时 / 流中断 / 网络类）自动重试耗尽后，切到链上下一个备选模型继续当前任务；界面提示「模型已切换 A → B（原因）」。401 鉴权、400 参数错误等不可恢复错误不切换，直接报错
- **链语义**：校验时剔除与主模型重复或彼此重复的项；每个候选每轮任务只尝试一次（未配置服务商的候选跳过）；链走完仍失败按原错误路径结束
- **生效范围**：切换只影响本轮任务的后续 turn，不改会话模型字段；上下文窗口与能力按新模型重新解析（窗口变小由现有 85% 水位安全网兜底），用量与成本按实际生效的 provider/model 逐 turn 记账。子代理不继承 fallback 链（子代理走角色模型链）

## 联网、代理与离线模式

Web Search / Web Fetch 两个工具的数据来源在 **设置 → 联网服务** 页签配置：

- **联网搜索模式**（页签顶部）：`local`（默认）= 本地 `web_search` 工具经下方联网服务商执行；`model-api` = 由模型服务商在服务端执行搜索（请求级下发，仅 **OpenAI Responses** 接口类型的服务商生效；此时本地 `web_search` 不再注入，使用其他接口类型的会话将没有搜索能力）。`web_fetch` 两种模式下都可用。对应环境变量：`OWC_WEB_SEARCH_MODE`。
- Search 与 Fetch 使用同一套「联网服务商」配置。支持 10 种服务商：Jina / Brave / Tavily / Bing / SearXNG / Exa / LinkUp / Bocha / Firecrawl / Custom，每种可保存多个配置，每项声明 `search` / `fetch` 能力，再分别选择当前用于 Web Search 和 Web Fetch 的配置。
- Jina、Tavily 与 Firecrawl 同时支持 Search 与 Fetch（Tavily Fetch 使用 Extract API）；Brave、Bing、SearXNG、Exa、LinkUp、Bocha 仅支持 Search；Custom 可自行声明能力。Custom Fetch URL 必须包含 `{url}` 占位符，Custom Search URL 接收 `q` 与 `count` 查询参数。
- 未选中具备相应能力的配置时，对应工具不会注入模型。Tavily 的 API Key 由同一个联网服务商配置同时用于 Search 与 Fetch。
- 联网调用仍遵循会话权限模式；`ask` 下会请求确认，且内网/本地 URL 会被拒绝。

server 的全部出站请求（模型 API、联网搜索/抓取、更新检测与在线更新）都支持走代理，在 **设置 → 联网服务 → 代理** 配置：

- **模式**：`关闭`（全部直连）/ `跟随环境变量`（默认，现读 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` 及小写变体）/ `自定义`（使用下方地址）。
- 自定义模式下填 **HTTP 代理** / **HTTPS 代理**（形如 `http://127.0.0.1:7890`，可含凭据；按目标 URL 协议选择，缺失时回退另一个，两者至少填一个），**例外列表** 为逗号分隔的主机名或域名后缀（如 `internal.example.com`），命中的地址跳过代理；本机回环地址始终跳过。
- 代理地址按敏感字段处理：界面只显示脱敏值（凭据不外显），保存即热生效，无需重启。对应环境变量：`OWC_PROXY_MODE`、`OWC_PROXY_HTTP`、`OWC_PROXY_HTTPS`、`OWC_PROXY_NO_PROXY`。
- **仅支持 http/https 代理**（`socks5://` 不被接受；Clash/v2ray 类工具请填其 HTTP 端口，如 7890，而非 SOCKS 端口，如 1080）。
- **`跟随环境变量` 模式读的是 server 进程的环境**：systemd 服务不继承登录 shell 的 `HTTPS_PROXY`——服务化部署请在界面改用自定义代理，或在 unit 里加 `Environment=HTTPS_PROXY=...`，否则等于直连（更新检测失败的最常见原因）。
- 更新检测与在线更新同样经此代理（1.2.0 起）；更早版本一律直连，在必须代理的网络里无法自举更新，请用一行安装脚本重装：`https_proxy=http://<代理地址> curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash`（脚本用 curl，原生读取 `HTTPS_PROXY` 等环境变量，与界面设置无关）。

**离线模式**在 **设置 → 通用** 开启（`OWC_OFFLINE`，热生效）：关闭 server 自身的启动期/周期性出站——更新检查、远程模型目录/定价的后台同步、汇率在线刷新。不影响模型 API、联网搜索/抓取、MCP 与扩展联网，这些由会话与配置显式驱动的请求照常发出。

## 定时任务（cron）

会话内可创建定时任务，到点把一段 prompt 自动注入会话（作为 follow-up 消息继续跑）：

- 由 agent 用 `cron_create` / `cron_list` / `cron_delete` 工具管理（也可走 REST `/api/sessions/:id/cron`）；输入框上方的定时芯片实时显示本会话任务数，点开可查看、添加与删除
- 5 字段迷你 cron 语法：`分 时 日 月 周`，支持 `*`、`*/n`、`a-b`、`a-b/n`、`a,b` 列表；按 server 本地时区，非法表达式创建时即拒绝并给出可读错误
- recurring 任务创建 7 天后触发最后一次（标记 stale）并自动删除；one-shot 触发一次即删；停机期间错过的多次触发只补一次
- 每会话上限 50 个；任务持久化在 `<业务数据目录>/cron.json`，重启 server 后自动恢复重排；删除会话会级联删除其全部任务

## Headless CLI（脚本集成）

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json
```

- `--json` 输出 NDJSON 事件流（每行一个事件对象）
- `--yolo` 权限请求自动 allow（CI 场景）
- `--session <id>` 复用已有会话
- `--tools` / `--exclude-tools` / `--read-only` 限制工具范围（见下节）；`--fallback-models` 配置备选模型链（见「备选模型（fallback）」）
- `owc --help` / `owc run --help` 输出中英双语帮助
- 退出码：`0` 完成 / `1` agent 错误或参数错误 / `2` 权限拒绝（非 `--yolo`）

## 工具限制与只读模式

会话可限制暴露给模型的**内置工具**。配置入口：新建会话对话框的「工具白名单 / 黑名单」输入框（逗号分隔工具名）；REST `POST /api/sessions`、`PUT /api/sessions/:id/config` 的 `toolsAllow`/`toolsDeny` 字段（内置工具名数组，如 `read_file`/`glob`/`grep`/`bash`/`write_file`）。

- `toolsAllow` 非空 = 仅暴露名单内内置工具；`toolsDeny` 在结果上再剔除；两者都只作用于内置工具，未知工具名静默忽略
- 交互类工具（`ask_user` 等）始终保留；MCP 与扩展工具由用户显式配置，不受影响
- 子代理（`spawn_task`/`spawn_swarm`）自动继承会话的工具限制
- `PUT config` 传 `null` 或空数组清除限制；工具限制是提示面约束（模型看不到的工具即不可用），不替代沙盒与权限链

CLI 等价写法：`owc run "..." --tools read_file,glob,grep`（= `toolsAllow`）、`--exclude-tools bash`（= `toolsDeny`）、`--read-only`（便捷旗标，等价于 `--tools` 只读集：read_file/glob/grep/read_artifact/repo_map/code_search/git_status/git_diff/load_skill/task_output；与 `--tools` 互斥，同给报错退出码 1）。

## 配置文件位置

`<启动/设置目录>` 按启动方式确定：用户显式设置的 `OWC_DATA_DIR` 优先；未设置时，安装版启动器会注入平台默认值（Windows `%USERPROFILE%\openwebcode`，Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才用相对 `server` 目录的 `../.openwebcode` 兜底。旧默认目录 `%LOCALAPPDATA%\openwebcode` 中的数据会在启动器下次启动时一次性自动迁移到新位置。为避免相对路径按 `server` 目录解析，建议 `OWC_DATA_DIR` 和设置页中的数据目录都填绝对路径。

设置页保存到 `<启动/设置目录>/server-settings.json`。其中已保存的"数据目录"会在**未设置 `OWC_DATA_DIR`** 时、下次启动后决定 `<业务数据目录>`；设置文件不会随之移动。未保存覆盖时，`<业务数据目录>` 与 `<启动/设置目录>` 相同。

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
| `<业务数据目录>/system-prompt-identity.md` | 全局身份行覆盖 |
| `<业务数据目录>/system-prompt-subagent.md` | 全局子代理附加指令 |
| `<业务数据目录>/update-check.json` | 更新检查缓存（最新版本与检查时间） |
| `<业务数据目录>/extensions/` | Extension Host 配置与第三方 `owc-ext-*` 扩展 |
| `<安装目录>/config/defaults.json` | 随发布更新的默认配置；数据目录只存用户覆盖，启动时自动组合 |
| `<cwd>/.owc/agents/`、`.owc/commands/`、`.owc/skills/`、`.owc/hooks.json`、`.owc/mcp.json`、`.owc/memory.md`、`.owc/system-prompt.md`、`.owc/system-prompt-append.md`、`.owc/system-prompt-identity.md`、`.owc/system-prompt-subagent.md` | 项目级（同名逐面覆盖全局） |

### 目录浏览根（可信根）

新建会话对话框的目录浏览器只能遍历**浏览根**范围内的路径，防止通过浏览器界面窥探根目录之外的文件系统。浏览根通过 `server-settings.json` 配置，**热生效**（保存后立即应用，无需重启）：

```json
{
  "browseRoots": [
    "/home/me/projects",
    "/home/me/repos"
  ]
}
```

等价环境变量 `OWC_BROWSE_ROOTS`（路径分隔符：Linux `:`、Windows `;`）：

```sh
OWC_BROWSE_ROOTS=/home/me/projects:/home/me/repos
```

- 留空（默认）→ 浏览根为用户家目录（`os.homedir()`）
- 每行一个绝对路径（`server-settings.json`）或分隔符分隔（环境变量），最多 16 个
- 浏览器内的路径请求经服务端 `path.resolve` + 前缀匹配严格校验，越界返回 403
- 手动在输入框中粘贴路径**不受**浏览根约束，仅校验路径是否存在

## 版本号与更新检查

- 设置 → **服务信息** 展示 Server/Core 版本与协议版本；命令行 `owc --version` 打印服务版本。执行器、存储上限/数据目录、Python/Node 环境默认值、沙盒代理拦截域名等系统级参数也在该页签调整。
- 设置 → **服务信息 → 更新检查**（默认关闭）：启用后周期性查询 GitHub Releases 最新版本，结果在同一页签静默展示，可点「立即检查」手动刷新，并在有新版本时给出下载链接；发现新版本时通知中心会出现按版本去重的提醒条目，点击直达设置 → 服务信息。相关环境变量：`OWC_UPDATE_CHECK_ENABLED`、`OWC_UPDATE_CHECK_URL`、`OWC_UPDATE_CHECK_INTERVAL_HOURS`。
- 发现新版本后可直接在设置页**一键在线更新**：Windows 下载 MSI 后启动安装程序并退出当前服务（安装程序完成覆盖升级）；Linux 替换安装目录 `<prefix>/lib/openwebcode/` 内容后自动重启（未以后台服务运行时需手动重启）。启动器、systemd unit 与数据目录均不受影响。
- Linux 也可用一行命令在线安装或更新（自动校验 SHA-256；已安装则走更新模式）：

  ```sh
  curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
  ```

  参数与行为详见 [packaging/README.md 的「在线安装与更新」](../packaging/README.md#在线安装与更新)。

## 自定义系统提示词

设置 → **提示词** 提供「全局 / 当前项目」两级作用域切换与四个配置面。项目作用域对应当前会话的工作目录（无会话时项目档不可用），保存后写入 `<cwd>/.owc/`；全局作用域写入 `<业务数据目录>/`。

四个配置面（留空即该面无覆盖）：

- **身份行**：覆盖系统提示词首行身份（`You are OpenWebCode...`）。
- **基线覆盖**：完整替换内置 Pi 基线段落。
- **追加指令**：追加到安全约束之后的自定义指令。
- **子代理附加指令**：拼入所有子代理（explore/general/自定义）的系统提示，追加在自定义子代理 body 之后。

落盘文件（一文件一面，全局与项目两级同名）：`system-prompt-identity.md`、`system-prompt.md`、`system-prompt-append.md`、`system-prompt-subagent.md`。

生效优先级：**env-sim 人格身份 > 项目级 > 全局 > 内置**。两级按面独立合并——项目级某面存在时整面覆盖全局同面，其余面仍取全局；保存即热生效（无需重启会话）。

> 提示词**不是安全边界**：plan 模式、权限与沙盒由服务独立强制，不受提示词覆盖影响。「恢复内置基线」按钮一键清空当前作用域的全部四面覆盖。

## 自定义扩展点

四类扩展机制——扩展宿主、子代理、斜杠命令与 Hooks，均支持项目级（`<cwd>/.owc/`）与全局两级：

### Extension Host 与官方扩展

设置 → **扩展** 可管理官方及第三方扩展。内置八项：

- `context-manager`：默认启用，负责工具结果的滚动驱逐策略；停用后不会自动逐出工具结果，85% 核心水位安全网仍保留（「上下文」面板是核心 UI，不受扩展开关影响）
- `attention-optimizer`：默认关闭，把关键约束/目标复制到上下文首尾锚区；`bottomOnly` 缓存影响较小，`full` 会增加输入 token
- `content-lens`：默认关闭；启用且已配置快速模型后，消息旁出现「译」与「解析选中」，结果只存 `translations/`，不进入 LLM 上下文
- `pdf-to-image`：默认启用；通过 Web 选择的 PDF 会先保存到当前工作区 `.owc/uploads/`，再将最多 4 页按 150 DPI、长边最大 2048px 转为图片附件，供支持图片输入的模型读取；停用时 Composer 仅把这个工作区相对路径引用交给主代理处理
- `owc-eval`：默认关闭；启用后底部面板出现「评测」，可选择固定 mock-provider 示例与 0.4 工具契约任务，在独立临时工作区回放 AgentRunner。报告包含断言、工具、token 与耗时；可把历史运行设为基线，与当前运行生成持久化的回归/改善对比并导出自包含 JSON。评测服务内置于 server，不读取原始 API Key；生产运行仍走正常 Core 权限与沙盒边界
- `env-sim`（环境模拟）：默认关闭；启用并选择预设后，系统提示词切换为该产品风格（身份行 + 工作方式），内置工具以该产品的命名/描述呈现（如 `Read`/`Bash`/`Edit`），底层仍走原工具实现与权限链。内置 `claude-code`/`kimi-code`/`zcode`/`codex` 四档预设；把自制预设 JSON（必填 `id`/`name`/`identity`/`basePrompt`，可选 `productSections`/`hideBuiltIns`/`aliases`）放入 `<业务数据目录>/env-sim/personas/` 即可添加并与他人分享，一个文件一个预设
- `compact-vault`（上下文档案库）：默认关闭；启用且已配置快速模型后，`/compact` 从默认概览压缩切换为档案库压缩——完整上下文归档到会话目录 `compact/segments/`（真实内容全保留），主模型上下文只注入目录式索引（不保留任何工具调用细节）；快速模型两遍整理（分块提取条目 + 合并去重/删除过时内容）后生成索引。主模型可按索引里的 `key` 调用 `recall_memory` 工具，经快速模型按需提炼召回对应归档片段；`keepTail`/`chunkSize`/`recallMaxTokens` 可在扩展设置中调整。85% 水位强制自动压缩同样走档案库路径；若档案库压缩未启用时被默认压缩覆盖了索引，目录索引会自动回注，`recall_memory` 始终可用
- `vision-tools`（视觉工具）：默认关闭；主模型不支持视觉时，把图片交给配置的视觉模型处理——`describe` 模式自动生成图片描述并注入上下文；`toolCall` 模式以 `[图片 #N]` 占位符注入并注册 `describe_image` 工具，主模型按需向视觉模型提问（省主模型 token，图片内容按需获取）。支持视觉的主模型不受影响

第三方扩展目录需包含 `manifest.json`（`apiVersion: "1"`）；入口默认为 `index.js`，可在 manifest 的 `entry` 字段另行指定。在设置页输入本地绝对路径即可安装。v1 扩展是可信代码，安装即信任其声明权限；单个钩子运行超时 5 秒会被跳过并记录日志。第三方扩展可用的 API 面与官方扩展看齐：注册工具、`sessions`/`context`/`events` 访问（`context.readVaultFile` 可只读会话 `compact/` 归档目录）、提示词与上下文钩子、私有存储（`<数据目录>/extensions-data/<id>/`，单文件 1 MiB、总量 50 MiB）、REST 路由注册（`/api/ext/<id>/*`，需 `http:route` 权限）、模型调用通道（`model:fast` 权限）、提示词与工具塑形（`prompt:shape`/`tools:shaping` 权限）、会话级扩展状态（extensionState）。完整字段与权限语义见 `help/development.md` 的扩展开发章节，可运行的示例在 `examples/extensions/demo/`。

### 子代理（`.owc/agents/reviewer.md`）

内置两种类型：`explore`（默认，只读探索：read_file/glob/grep/read_artifact）与 `general`（通用：可读写文件、执行 bash，工具调用经与主代理相同的权限链与沙盒）。`spawn_task agent=general prompt="..."` 即可派发可写任务；自定义 markdown 子代理仍为只读。

```markdown
---
name: reviewer
description: 代码审查专家，只读不改
tools: [read_file, glob, grep]
model: claude-sonnet-4-5
role: premium
---
你是资深代码审查员。逐行核对 diff，指出：
- 逻辑错误
- 边界条件遗漏
- 命名与风格
不要修改代码，只输出审查意见。
```

frontmatter 模型声明（优先级从高到低）：`provider:` + `model:` 显式指定服务商与模型 > `role:` 指定四档角色（premium/balanced/fast/cheap，映射见「设置 → 模型选择」）> 派发时的 `role` 参数 > 会话当前模型。

调用：`spawn_task agent=reviewer prompt="审查 src/auth.ts 的最近改动"`；也可不指定 agent 直接按角色派发：`spawn_task prompt="..." role="cheap"`。

多个独立的同类只读任务可用 `spawn_swarm` 并行（模板 + 逐项替换，2–16 项，并发上限 4，超出自动排队）：

```
spawn_swarm prompt_template="审查 {{item}} 的最近改动，输出风险点" items=["src/auth.ts", "src/api.ts", "src/pay.ts"]
```

`items` 也可逐项指定子代理与模型角色：`items=[{"task": "审查 src/auth.ts", "agent": "reviewer", "role": "cheap"}, ...]`（字符串形式仍兼容，`agent` 也可填内置 `general`；调用级 `role` 对未单独指定的项生效）。子代理结论按 `[序号/总数]` 聚合返回；派生过程在消息轨道渲染为实时卡片（swarm 逐项状态、轮次与工具数），底部面板「子代理」标签页按调用分组汇总，顶部还可手动启动子代理（任务描述 + 类型选择，`POST /api/sessions/:id/subagents`，并发上限 4，超限直接拒绝）；主窗口子代理标签页以与主对话相同的渲染展示完整转录。每次派生的完整转录存在会话数据目录 `subagents/<taskId>.json`。中断 agent 不会再启动排队中的 swarm 项，也会取消手动启动的子代理。

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
- `matcher`：精确工具名、`前缀*`、`*` 全匹配（无工具名的事件仅 `*` 命中）；工具形态别名（env-sim 拟态）激活时 matcher 仍按内置工具名匹配，payload 的 `tool` 为内置名、模型侧别名经 `toolAlias` 字段附带
- exit 0 放行；exit 2 否决（仅 PreToolUse / PreCompact 两个 Pre 类事件，stderr 回填调用方）；其他非零/超时告警不阻断；Notification、Subagent 类、SessionEnd、PostCompact 等通知类事件的失败与退出码均不阻塞主流程
- 5s 超时杀进程
- **安全级别等同 yolo**：hooks.json 里的 command 由 server 直接 spawn 执行，不经沙盒与权限链。凡是能写 hooks 配置的人即拥有等同 yolo 的执行能力。
- bash 工具的 `OWC_SESSION_ID` 等会话环境变量（见「运行中操作」）不适用于 hooks——hooks 由 server 直接 spawn，不经过 bash 工具环境

## 常见问题

见 [`faq.md`](./faq.md)。
