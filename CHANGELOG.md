# 更新日志

本文记录 OpenWebCode 从首次公开版本 `v0.1.0` 到当前版本的用户可感知变化。日期以 Git 标签发布日期为准。

## [未发布]

### 修复

- OpenAI Responses 接口遵循模型目录「思维链回传」设置：开启时历史同源 thinking 块以 reasoning item（`reasoning_text` 明文）回传——DeepSeek 思维模式（如 deepseek-v4-flash）强制要求回传，此前第二轮起必现 400「The `reasoning_text` in the thinking mode must be passed back to the API」；关闭或 OpenAI 官方端点（声明不回传）行为不变。

## [1.3.6] - 2026-08-04

### 修复

- agent bash 持久 shell 不再被分页器挂死：pty 是 TTY，`git log`/`gh` 等会启动 less 等待交互导致命令挂到超时（典型表现：工具调用几十秒无返回）。三种 shell（bash/pwsh/cmd）启动时统一置 `PAGER=cat`、`GIT_PAGER=cat`；人类真终端不受影响。
- 持久 shell 输出清洗对齐 pi：剥离控制字符与 Unicode Format 字符（防二进制垃圾进入上下文），`\r` 统一归一（进度条覆写帧直接拼接，不再残留回车控制符）。

## [1.3.5] - 2026-08-04

### 界面与体验

- 通知中心与快捷键速查并入设置：活动栏铃铛与 `Shift+?`/`/help` 现在打开设置的「通知」/「快捷键」页签，不再使用独立弹层；通知页签进入即全部已读（角标清零），列表交互不变。
- 默认端口统一为 **3210**（launcher 脚本、安装器默认值、`owc run` 默认服务地址、Vite 开发代理此前为 3000，与 server 兜底 3210 不一致）；`OWC_PORT` 覆盖方式不变。

### 新增功能

- 联网搜索模式可选：设置 → 联网服务新增「联网搜索模式」，`local`（默认）保持本地 `web_search` 工具经联网服务商执行；`model-api` 由模型服务商在服务端执行搜索（仅 OpenAI Responses 接口生效，如 DeepSeek 的官方搜索工具；此时本地 `web_search` 不再注入），搜索过程以实时活动形式展示。亦可用 `OWC_WEB_SEARCH_MODE` 配置。

## [1.3.0] - 2026-08-04

界面设计语言统一专项：引入可复用交互基元（弹层、确认框、徽标、输入框、折叠行、空态/错误态），全面 token 化（字号、圆角、阴影、遮罩、diff 色、z-index），并修复一批界面瑕疵与可靠性问题。

### 新增功能

- 初步添加linux版对arm和龙芯的适配

### 界面与体验

- 新增设计基元：`Overlay` 弹层组件（Esc/背板关闭、焦点循环与归还）统一命令面板、Quick Open、快捷键速查、通知中心、代码视图五个弹层；`ConfirmDialog` + `useConfirmDialog` 取代全部原生 `window.confirm`；`.pill` 徽标、`.input` 输入框、`.collapse-row` 折叠行、`.composer-popup` 建议弹层、`.muted-empty` 空态、`.panel-error` 行内错误（带 `role="alert"`）六套样式基类收敛全站重复实现。
- 视觉语言 token 化：字号半点值归入整数阶梯（新增 `--text-2xs`）、`font-weight` 统一 600、圆角收敛为 `--radius-s/--radius/--radius-l/--radius-xl` 四档、弹层阴影 `--shadow-lg` 与遮罩 `--backdrop` 按主题定义、diff 颜色（`--diff-add/del-bg/text`）亮暗分主题、z-index 归为 11 档分层变量、内容宽度 `--content-max`。
- 可访问性：键盘可见焦点补齐五处缺口（模式下拉、弹层输入、会话内搜索、工作区区域、开关控件）；次级文字 `--text-3` 两主题对比度提升至 WCAG AA 档；Unicode 字符图标（✓✗●○■ 等）全部迁入描边 SVG 图标组件，EmptyState 步骤序号改 CSS 计数器。
- 修复：快捷键 Ctrl+P 与浏览器默认冲突（`defaultPrevented` 检查）、触屏设备 hover 不可达的操作按钮兜底、通知/Toast 错误态样式、徽标在窄屏的截断、自定义强调色非法值残留（回落 graphite）、on-accent 文字色改 WCAG 对比度计算。

### 服务端修复

- 快照后端支持显式 pin zfs（此前仅 auto 探测链支持）；`defaultEffort` 存储前校验枚举，非法值（如环境变量直写）不再带进运行时。
- 中断补写失败落 stderr 留痕（不再静默，provider 400 可诊断）；OpenAI Responses 接口同一 call_id 重复的 function_call 只内联一次（避免被 API 拒绝）。

### CI 与打包

- loongarch64 交叉构建产物强制校验目标架构 ELF（防 toolchain 静默回落主机编译器）；bundled Node 哈希校验左锚加固；手动下载示例改 `<arch>` 占位。

## [1.2.0] - 2026-08-03

Linux 体验与功能专项：快照新增 overlayfs 后端（原语下沉 core C 层）、出站代理设置、安装器 systemd 更新/重装判定、沙盒能力误报修正与界面平台适配。

### 快照

- 新增 overlayfs 快照后端（Linux）：core 新增 `overlay.mount` / `overlay.checkpoint` / `overlay.restore` / `overlay.unmount` 原语（root 走内核 mount，rootless 走 fuse-overlayfs，检查点 reflink 复制优先），`core.ping` 上报 `features.overlay`。探测链变为 btrfs → zfs → overlayfs → git-shadow；ext4 用户不再只有线性成本的 git shadow。会话在 merged 视图中工作、源目录只读，改动在文件面板确认后手动同步回源（复用托管工作区同一套机制）；有运行中任务时回滚返回可读错误。

### 网络

- 新增出站代理设置：关闭 / 跟随环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`）/ 自定义三模式，自定义支持 HTTP、HTTPS 代理与例外列表（后缀/精确/通配匹配，回环默认绕过）。作用于模型 API、联网搜索/抓取、更新检测与在线更新；界面保存热生效，代理凭据脱敏不出服务端。亦可用 `OWC_PROXY_*` 环境变量配置。

### 安装与更新（Linux）

- 安装器解析既有 systemd unit 的启动路径：同路径判定为更新（保留服务启用状态与启动器变量，一次确认），不同路径提示「切换服务 / 仅装文件 / 中止」，防止双安装抢端口；未检测到可用的 systemd 时不再询问写服务。
- 重跑 install.sh 保留启动器中已设置的端口、数据目录、监听地址与 pin 的系统 Node（命令行显式参数仍最优先）。
- 在线更新修复重启竞态：`Restart=on-failure` 下 clean exit 不拉起、`try-restart` 对已停止服务无效，此前更新后服务可能停在停止状态；同时支持系统级 unit 自动重启。`--use-system-node` 安装更新不再重复复制约 100MB 的 Node 运行时。
- 安装结束检测 `<prefix>/bin` 是否在 PATH 并给出 export 指引；新写 systemd unit 增加加固指令（`NoNewPrivileges` 等）；卸载提示 `loginctl disable-linger`。

### 沙盒与界面平台适配

- 修复 Linux 沙盒能力误报为「兼容模式（Job Object，无文件系统隔离）」——实际为 Landlock，界面与 capability 上报现已一致；界面按平台出文案：Linux 显示 Landlock 语义、隐藏 AppContainer / Windows Sandbox / Bind Link 选项与提示，shell 选择器隐藏 CMD / PowerShell。
- Landlock 强制模式新增 `/tmp`、`/dev` 读写与 `/proc`、`/sys` 只读豁免：沙盒内 mktemp、编译器中间文件、测试框架不再批量 EACCES。
- exec 的内存 / 进程数限制在 Linux 经 setrlimit 落地（此前被静默忽略）；`fs.stat` 修改时间在 Linux 提供毫秒精度。

### 安全与其他

- 数据目录 0700，服务商配置（明文 API Key）、设置文件、会话转录等敏感文件 0600（POSIX 新写入生效）；core stderr 归档 `<数据目录>/logs/core.log`（5MB 轮转，保留一代）。
- 优雅退出加固：第二次 Ctrl+C 立即强制退出、shutdown 5 秒超时兜底、POSIX 接入 SIGHUP；默认 corePath 按平台区分（修复 Linux 手动启动默认指向 `.exe`）。

## [1.1.1] - 2026-08-02

设置界面重组与提示词配置扩展：联网服务与模型选择独立成页，提示词支持全局/项目两级与更多配置面；移动端密度进一步优化。

### 界面与体验

- 移动端密度优化：零计数芯片（含「定时」）整行隐藏、会话信息条单行紧凑（过长省略号收缩）、Composer 控制行收档（长模型名省略号）、消息区侧距与 Markdown 表格降档；修复空输入框常显滚动条轨道的问题。
- 设置页签拆分：新增「模型选择」（会话默认 + 四档角色 + 快速模型）与「联网服务」（联网服务商与 search/fetch 当前配置）两个独立页签，「模型目录」保留模型服务商与目录同步。

### 提示词

- 提示词设置升级为「全局 / 当前项目」两级作用域，并新增两个配置面：**身份行**与**子代理附加指令**（连同基线覆盖、追加指令共四面）。项目级逐面覆盖全局，优先级 env-sim persona > 项目 > 全局 > 内置，保存即热生效；子代理附加指令对 explore/general/自定义子代理统一生效。

### 变更与修复

- 移除「快速模型最大输出上限」设置项：输出上限改由各任务按需指定（压缩 2048、翻译 4096、审核 256 等），不再受全局钳制；残留的用户覆盖值自动清理。
- 修复扩展私有存储在 Linux 不拒绝 `C:/` 形态路径的跨平台校验漏洞。
- 修复 core `pty.input` 在 ptyId 未找到分支的 3 字节内存泄漏（CI ASan 任务检出）。

## [1.1.0] - 2026-08-02

多模型角色与工程化专项：新增四档模型角色与会话默认模型，子代理可按任务下发到不同模型执行；SCM 与文件预览大幅增强；第三方扩展 API 面向官方扩展能力看齐；修复快照回退后无法继续等一批问题。

### 模型与服务商

- 多模型四档角色：极致（高智能）/ 平衡 / 快速 / 廉价，在「设置 → 模型选择」分别指派到任意已启用服务商的模型。`spawn_task`/`spawn_swarm` 子代理可按任务用 `role` 参数选择角色下发；自定义子代理 frontmatter 新增 `role:` 与 `provider:` 声明；用量与成本按实际生效的服务商与模型归属。
- 新增「会话默认模型」设置项：新会话默认模型不再固定取第一个服务商的第一个模型。
- 设置「模型接入」重组为「模型选择」（会话默认 + 四档角色，快速模型设置并入）与「模型目录与同步」两组。

### SCM 与文件预览

- SCM 面板支持行内 stage / unstage / discard（删除未跟踪文件需二次确认），新增提交历史区与 worktree 一键合回（冲突结构化展示）。
- agent 写文件或编辑器保存后 SCM 面板自动刷新，不再过期。
- 文件预览：超过 2000 行可「加载更多」分页续读；图片直接预览（png/jpg/gif/webp/svg/ico/bmp）；Markdown 渲染/源码双态；一键在编辑器中打开；未跟踪文件点开显示内容而非空 diff。

### 扩展

- 第三方扩展 API 面向官方扩展能力看齐：私有存储（extensions-data，单文件 1 MiB、总量 50 MiB）、REST 路由注册（`/api/ext/<id>/*`，`http:route` 权限）、模型调用通道（`model:fast` 权限）、提示词与工具塑形权限（`prompt:shape` / `tools:shaping`，不再官方独占）、会话级扩展状态（extensionState）。附 `examples/extensions/demo` 示例扩展与重写后的扩展开发文档。

### 性能与修复

- agent 的 glob/grep 工具切换到 core 四线程并行搜索 job：大仓库搜索提速且不再阻塞 core 主循环；老 core 按能力协商自动回退，工具行为不变。
- 修复快照回退后无法继续：回退进行中发消息返回 409（不再静默进队列）、回退完成后回收持久 shell、openai 系 SSE 流新增 idle 超时（默认 300 秒，仅 data 事件续命，半开连接可重试恢复；`OWC_PROVIDER_STREAM_IDLE_MS` 可调，0 关闭）。
- 修复索引重建对真实 core 必败（job.output 参数越界且输出未做 base64 解码），诊断与 SCM 的同类输出解码问题一并修复，并补充真实 core 端到端测试守住该链路。
- core 新增 `fs.readBase64`（20 MiB 上限，root-bound），为图片预览供数。
- 新增 10 万文件级索引基准，接入发布性能门禁（10 万文件/21 万符号下查询 p95 约 41ms）。

### 界面与其他

- 移动端：抽屉遮罩、紧凑顶栏、状态栏并入底部面板标签条、Popover 视口自适应、iOS 安全区适配。
- 新增 `agentMaxTurns` 设置项（1–1000，热生效，可用 `OWC_AGENT_MAX_TURNS` 覆盖）。
- 工程化：server/web 接入 ESLint 并纳入 CI 强制、依赖审计与测试覆盖率上传（非阻断）、Dependabot 周更、core 增加 clang-tidy 与 Linux ASan CI 任务、`.gitattributes` 固化换行符规则。

## [1.0.1] - 2026-08-01

安装与局域网访问体验专项：局域网访问从「手工配置三个环境变量」收敛为「改一个监听地址」，Linux 安装器补齐 root/systemd/防火墙/卸载全链路。

### 安装与局域网访问

- 非回环监听开箱可用：未显式配置时访问令牌由服务端首次启动自动生成并持久化（`<数据目录>/access-token`，0600），启动后控制台打印带令牌的一键访问链接；`OWC_ACCESS_TOKEN`（≥32 字符）仍可显式覆盖。
- 浏览器来源校验缺省同源自动放行（与访问地址同源的 origin 直接放行），不再强制手工配置 `OWC_ALLOWED_ORIGINS`；显式设置时维持严格列表。
- 设置 → 远程访问新增「访问链接」卡片：令牌 masked 展示、链接逐条复制、首条链接二维码（手机扫码即登录）；自动生成的令牌可一键重新生成，旧链接与已登录设备立即失效。
- Linux 安装器：root 系统级安装（默认 `/usr/local` + `/var/lib/openwebcode`，`--system` 显式声明）；`--with-systemd` 按 root/用户分层写 unit；`--enable-service` 立即启用并启动服务；`--lan` 一键开启局域网访问；`--open-firewall` 自动放行防火墙端口（firewalld/ufw）；局域网安装结束时直接打印访问链接。
- Linux 卸载脚本：安装时落盘 `<prefix>/bin/owc-uninstall`（发行包同附 `uninstall.sh`），停止并移除 systemd 服务、删除运行时与启动器；数据目录默认保留，`--purge-data` 一并删除，`--remove-firewall` 移除防火墙规则。
- Windows MSI 完成页新增默认勾选的「Launch OpenWebCode」：安装结束即启动服务并打开浏览器。

### 修复

- 设置对话框搜索框：通用对话框输入规则覆盖了搜索框内边距，导致搜索图标与占位文字重叠；恢复图标左侧 28px 让位。

## [1.0.0] - 2026-08-01

首个公测版本。本节为完整项目发版日志，按主题汇总 0.1.0 首个公开版本以来的全部能力；逐版本明细保留在下方各节。

### 核心能力（Agent 与会话）

- 浏览器打开即用的 AI 编码工作台：三层架构（React WebUI ─ Node 服务层 ─ C 执行器 core），Windows/Linux 原生支持，自带沙盒隔离、快照回滚与上下文管理。
- 完整 Agent 工具链：文件读写/编辑、bash、glob/grep、任务清单、长期记忆、文件引用、Shell 快捷命令、网络抓取与可插拔搜索。
- 会话树导航：任意用户消息可分叉、编辑后重发、对 assistant 回复重新生成；会话从线性历史升级为树。
- 消息记录父消息/运行/轮次归属并可在时间线查看；持久化运行队列支持查看、重排、取消与安全插队。
- `ask_user` 结构化提问：agent 运行中发起带选项的提问（单选/多选/自定义输入），回答持久化并注入后续轮次。
- 三种 agent 模式：code（默认）/plan（结构化批准流：批准/编辑后批准/拒绝三分支）/goal（主模型自评未达成自动续跑，最多 10 次）。
- 四级权限档：逐次确认 / 接受编辑 / 模型审核（review，低风险自动放行留审计、高风险转人工）/ 完全自主；权限与沙盒正交。
- 子代理体系：`spawn_task` 单任务与 `spawn_swarm` 并行集群（2-16 项、并发上限 4、逐项指定 agent）、explore 只读与 general 通用两类内置类型、实时卡片与标签页转录、共享讨论板、WebUI 手动启动。
- cron 定时任务（会话内 5 字段，持久化并注入 follow-up 队列）；Hooks 全事件与桌面通知；agent bash 持久 shell（cd/env 跨调用保持）。
- Skills、MCP（stdio + Streamable HTTP）、Hooks、自定义子代理、自定义斜杠命令与独立 Extension Host；官方扩展：PDF to Image、env-sim 环境模拟、owc-eval 评测。
- `owc run` 非交互 CLI（--json 出 NDJSON，面向 CI），中英双语帮助与版本输出。

### 上下文工程

- 上下文账本与窗口管理、两种压缩策略、选择性 pin/排除、分段 token 成本归因、Provider prompt-cache 断点。
- 工具结果滚动驱逐：lag 按轮计（默认 2）、当轮保护、豁免下限（小结果与短文件始终保留）、read_file 头 50 + 尾 50 行摘录降级、「默认节省」占位符与「超级节省」双模式，阈值会话级热调。
- 上下文窗口可视化：占用表、分段归因条、缓存命中胶囊与水位提示（建议压缩/强制压缩）。

### 模型与服务商

- 多配置服务商注册表：Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种接口；多配置联网服务商（Jina / Brave / Tavily / Custom，Search 与 Fetch 分能力声明）。
- 模型目录：远程同步、持久化与手动编辑；能力声明覆盖思考/力度/文本图片视频输入/图片输出/工具/reasoningContent，逐模型覆盖；未声明模型默认上下文 256k，deepseek 前缀 1M。
- 思维链保留回传（reasoning_content）、服务商自定义请求体（extraBody）、输出长度默认不封顶；快速模型复用服务商配置并可独立设置思考与上限；Provider 并发控制（FIFO 排队）。

### 界面与体验

- 五区工作台（活动栏/侧栏/主区/底部面板/状态栏）、命令面板、Quick Open、统一快捷键注册表与通知中心。
- Monaco 编辑器与统一 diff：逐 hunk 接受/拒绝、保存快捷键、SHA-256 条件写（并发修改返回 409）。
- 诊断闭环 `test_runner`（Vitest/Jest、pytest、Go test、.NET test）与 Problems 面板；Git 集成（status/diff/commit、worktree）与 SCM 面板；代码库索引（core index.scan、九语言符号提取、code_search、repo_map）。
- 思考/正文/工具调用按真实顺序交织渲染，相邻工具调用合并折叠组，流式正文平滑追加；对话轮次深浅成组、层级递进，亮暗主题自适应。
- 会话管理：重命名/置顶/分页加载/导入导出（HTML/JSONL/Markdown）；首次引导三步上手、服务商测试连接、设置搜索与深链。
- 高频操作：输入历史召回、Esc 中断、代码块悬停复制、断连横幅、草稿按会话持久化、对话内搜索、Ctrl+P 快速切换模型。
- 真终端面板（core PTY：打开/输入/缩放/关闭与输出/退出通知）；Bind Link 目录绑定（Windows 11 24H2+，新建会话可视化编辑器，沙盒面板展示生效绑定）。
- 英文界面与中英双语文档（首次访问按浏览器语言选择）；移动端单列响应式与 PWA 安装。

### 安全与沙盒

- 沙盒后端：Windows AppContainer / Windows Sandbox（一会话一 VM）/ Job Object（1.0 起为 Windows 默认）/ Linux Landlock；能力状态如实上报（enforced/partial/advisory）。
- 路径策略 deny > write > read 固定优先级，文件原语 root-bound + no-follow/reparse 防护；deny 变形路径绕过、`.owc` 可信来源、会话导入清洗等安全复核结论均已固化。
- 非回环监听强制 ≥32 字符访问令牌 + 合法 origin 白名单；TOTP 全局登录（票据滑动 12h、失败锁定）；WS 握手三重校验；loopback Host 校验封 DNS rebinding 入口。
- 出站网络统一收口 Node：超时/重试/大小上限/SSRF 防护（手动重定向逐跳复验 + DNS 解析逐 IP 复验）/UA 注入/脱敏；MCP 子进程环境白名单；WebUI CSP 与 nosniff 响应头。
- 权限链加固：bash 前缀规则词边界匹配、控制字符类补 CR（封堵 cmd 拆命令绕过）；Hooks 明确等同 yolo 信任级。

### 快照与工作区

- 自动与手动检查点、时间线回滚；Btrfs/ZFS/ReFS 原生快照探测链 + git 影子仓库兜底。
- VHDX/qcow2 托管工作区（稀疏镜像盘隔离）与同步回源：三方差异预览 + 手动确认，默认只写无冲突改动，关闭/删除会话不自动覆盖源目录。

### 性能

- 会话解析 LRU 缓存（单轮总耗时 -74.9%）、流式增量 Markdown（平方级降为近线性）、EventBus 单次序列化、buildView 增量路径、索引追加只扫新增字节（p50 13.59→1.40ms）。
- core 并行 grep/glob（4 worker、确定性排序、预算/取消/no-follow 语义保留）与可取消后台作业控制。
- 实测：5000 消息 59.88fps、输入回显约 25ms、长历史缓存分页 p50 0.58ms；完整基准体系（固定 seed、真实 server + Playwright、回归 >15% 标红）。

### 发布工程

- Windows MSI（可选桌面快捷方式与 PATH）与 Linux tar.gz；`install-online.sh` 一条命令安装/升级，SHA-256 强制校验；WebUI 在线更新（MSI 覆盖 / tar 替换）。
- 四个独立 CI 工作流 + 发布流水线：测试网关、版本三方一致性校验（server/web package.json 与 CMake 基版本，含手动触发）、CHANGELOG 段落提取为发布说明、bundled Node SHASUMS 校验、MSI 数据库门禁、基准门禁（相对回归警告 / 绝对验收阻断两层）。

### 升级说明

- 从任意旧版本直接覆盖安装即可，数据目录与设置自动保留。
- Windows MSI 未做 Authenticode 签名，首次安装/升级可能被 SmartScreen 提示；发布资产（MSI/tar.gz）带 SHA256SUMS.txt，安装与在线更新流程均强制校验。

## [1.0.0-beta.5] - 未发布（已并入 1.0.0）

### 新增

- Shell 后端探测与 Git Bash 支持：Windows 默认命令后端按 `pwsh > Git Bash > cmd.exe` 探测取首个可用项（Git Bash 解析为 Git for Windows 的 bash.exe 绝对路径，排除 WSL 的 `System32\bash.exe`），Linux 按 `bash > pwsh > $SHELL`（`/bin/sh` 兜底）；会话 `shellBackend` 意图扩展为 `default/pwsh/bash/cmd`（界面仍暴露「默认 / PowerShell 7」两档）。core `exec.run`/`job.start` 新增 `shellBackend:"bash"` 与 `shellPath`（host 探测到的显式解释器路径），`core.ping` 上报 `features.shellBash`；bash 工具描述按平台与实际解释器生成（Git Bash 下提示 POSIX 语义）。
- OpenAI Responses 接口类型：模型服务商新增第三种接口（`POST {baseURL}/responses`，流式）；思维以 reasoning summary 流返回，历史思维链不回传（Responses 的思维回放依赖服务端 reasoning 机制）。
- Bind Link 目录绑定（Windows 11 24H2+）：创建会话的 REST 入参 `bindLinks`（≤16 项，`virtPath`/`backingPath`/`readOnly?`）把会话工作区内的虚拟路径透明绑定到外部真实目录，面向共享依赖缓存；创建绑定需 server 以管理员权限运行，`core.ping` 上报 `features.bindLink`，wsb 模式不支持；绑定全系统可见，会话清理时撤销，异常退出最迟重启失效。

### 界面与体验

- 思考、正文与工具调用按真实产生顺序交织渲染；相邻的连续工具调用（≥2 个）自动合并为「N 个工具调用」折叠组，组内一调用一行。
- 流式正文按增量平滑追加，长输出不再整段重排。

### 文档

- 根 README（中英）、`docs/`、`help/` 精简重写并同步本轮变化；删除空文件 `docs/review.md`。

## [1.0.0-beta.4] - 2026-07-31

### 新增

- TOTP 全局登录认证：非回环监听场景的访问控制，凭据 `totp.json`（0600），票据滑动 12h。
- core PTY RPC 与真终端面板：PTY 打开/输入/缩放/关闭与输出/退出通知，能力经 `core.ping` 上报。
- plan 模式结构化批准流：`exit_plan_mode` 提交计划，批准/编辑后批准/拒绝三分支，不经权限自动放行。
- goal 目标模式：主模型每轮自评目标达成度，未达成自动续跑（最多 10 次）。
- 模型审核权限模式（review）：低风险由审核模型自动放行，高风险转人工。
- swarm 成员共享讨论板：并行子代理经 JSONL 板面互相分享发现。
- agent bash 持久 shell：cd/env 跨调用保持（沙盒内 PTY）。
- Hooks 事件补全与桌面通知：页面失焦时权限待批/交互待答/run 终态弹系统通知。
- cron 定时任务：会话内 5 字段 cron，持久化并注入 follow-up 队列。

### 界面与体验

- 模型选择器重做：按供应商分组展开收起，底部固定区显示模型能力与思考控件；思考改为胶囊开关，强度改格子档滑动（只显示已声明档位；未声明则全部可选、切换模型不再清除继承值）。
- 模式弹层：code（默认）/plan/goal 与 Swarm 独立开关可叠加。
- 权限档文案：逐次确认/接受编辑/模型审核/完全自主。

### 模型与服务商

- 思维链保留回传：历史 thinking 块以 `reasoning_content` 回带给 OpenAI 兼容端点（同源 provider）；新增模型能力 `reasoningContent` 声明，gpt/o 系与 claude 默认关闭、其余默认开启，模型目录可逐模型覆盖。
- 服务商自定义请求体（extraBody）：每次请求浅合并自定义 JSON 字段，保留字段禁止覆盖。
- 输出长度默认不封顶：OpenAI 兼容接口不再默认发送 `max_tokens`；Anthropic 保留 API 强制默认值，可经自定义请求体覆盖。
- 未声明模型默认上下文 256k；deepseek 前缀升至 1M（DeepSeek V4）；effort 档新增 ultra。

### 变更

- Windows 默认沙盒模式改为 Job Object（兼容模式）；AppContainer 仍需在会话中显式选择，既有未指定沙盒模式的会话按新默认执行。

### 修复

- 工具结果滚动驱逐重构：lag 改为按轮计（一轮 = 一批连续工具结果）且默认 lag 1 → 2，当轮（模型尚未看到的批次）受保护不再被驱逐；新增驱逐豁免下限（<256 token 的小结果、≤10 行的文件读取始终保留）与 read_file 头 50 + 尾 50 行摘录降级；驱逐占位符改为语义摘要（工具名/大小）并指引模型用 `read_artifact` 自助恢复（原"UI restore action"指引模型无法执行）。以上阈值均可在上下文面板会话级热调。
- 新增「超级节省」驱逐模式（上下文面板/REST 可选，默认仍为「默认节省」占位符模式）：非保留轮的整轮工具过程连同思维链出视图，只留一行不可变摘要（含 artifact 恢复指引），tool_call 大参数（write_file 全文等）不再滞留上下文；回写时双侧配对自动复活。
- bash 工具调用长时间不结束：server 从 Git Bash/MSYS 环境启动时子进程 PATH 里 `usr/bin` 先于 System32，`find`/`sort` 被解析成 MSYS 版本（如 `find /c` 变递归扫盘）导致命令跑飞；现 Windows 下 core 子进程一律前置 System32 恢复内置命令语义，持久 shell 超时错误附带已捕获输出尾部供模型自我纠正。
- 全局 review 修复：权限卡悬挂、幽灵运行态、core 崩溃恢复。
- 子代理思维链回传档位按实际请求模型（modelOverride）取档。
- bash 权限规则词边界前缀匹配。
- 流式渲染改 append-only 分片与增量 Markdown 切分（长会话性能）。

## [1.0.0-beta.3] - 2026-07-29

### 界面与体验

- 会话配置控件重排：模式/模型靠左，思考/权限/高级设置靠右；模式选项缩短为「构建/计划」，模型字段弹性收缩（窄窗口文字标签自动隐藏、高级设置留图标），始终一行；≤480px 堆叠显示。

### 文档

- README 中英与使用文档语气平实化：口号式条目改直接陈述，删除重复内容。

## [1.0.0-beta.2] - 2026-07-29

### 界面与体验

- 对话轮次深浅成组：user 消息开启一轮，奇数轮 assistant/tool 消息底色加深一档与偶数轮交替；每轮首条 user 消息前间距拉开；流式输出跟随当前轮次；子代理标签页与主对话同一轮次规则。
- 层级深浅递进：奇数轮内工具/结果卡底色同步加深（错误卡保持红色）；子代理转录体加深一档，转录内消息按角色深浅交替；全部基于 CSS 变量 color-mix，亮暗主题自适应。
- 会话配置行（模式/模型/思考/权限/高级设置）整体右对齐。
- 「回到底部」按钮不再遮挡正文：滚动区底部留白加大，按钮实底加背景模糊。
- PDF 提示可关闭：关闭状态按扩展状态签名记忆（localStorage），扩展状态变化后提示自动重现。
- 消息操作按钮（复制/翻译/编辑重发/重新生成/分叉等）键盘聚焦可达、触屏常显，补显隐过渡。
- 底部面板状态条去除与头部重复的 tokens/成本显示，保留运行状态/模式/模型/上下文窗口水位。

## [1.0.0-beta.1] - 2026-07-29

首个 1.0 预览版：会话树导航与结构化提问补齐核心交互，文档全面对齐实现。

### 新增

- 会话树导航：任意一条用户消息可分叉（branch）、编辑后重发、对 assistant 回复重新生成；会话从线性历史升级为树，UI 提供分叉点切换与路径指示。
- `ask_user` 结构化提问工具：agent 运行中可向用户发起带选项的结构化提问（单选/多选/自定义输入），回答注入后续轮次。
- 消息导出增加 Markdown 格式（`session-<id>.md`），与既有 HTML/JSONL 并列，导出菜单统一入口。

### 界面与体验

- 对话内搜索：会话内按关键词定位消息并跳转。
- `Ctrl+P` 快速切换模型（循环候选列表）。

### 文档

- 用户文档全面校对：`help/usage.md` 加锚点目录并纠正 10 处与实现不符的描述；`help/development.md` 同步新模块（tool-schemas、session-tree、env-sim、设置拆分）；`help/faq.md` 修正过时答案并新增 5 条 FAQ；README 中英对齐；packaging README 补发布工程说明。

### 发布工程

- release.yml 支持预发布版本：tag 可为 `vX.Y.Z-beta.N`（`package.json` 存完整版本号，`core/CMakeLists.txt` 存数值基版本，一致性检查按基版本比对）；MSI 的 ProductVersion 保持数值、产物文件名携带完整预发布号；带预发布后缀的 Release 自动标记为 Pre-release。

### 升级说明

- 与 0.9.0 相同：Windows MSI 未做 Authenticode 签名，首次安装/升级可能被 SmartScreen 提示；发布资产（MSI/tar.gz）带 SHA256SUMS.txt，安装与在线更新流程均强制校验。

## [0.9.0] - 2026-07-29

### 新增

- 官方扩展「环境模拟」（`env-sim`）：启用并选择预设后，系统提示词切换为该产品风格（身份行 + 工作方式），内置工具以该产品的命名/描述/参数形态呈现（如 `Read`/`Bash`/`Edit`），底层仍走原工具实现与权限链。内置 `claude-code`/`kimi-code`/`zcode`/`codex` 四档预设；自制预设 JSON 放入 `<业务数据目录>/env-sim/personas/` 即可使用并与他人分享。
- 扩展 API 第二批：`prompt.beforeBuild` 钩子（身份行与基线提示词可覆盖，安全约束段仍由核心追加）；manifest `toolShaping`（仅官方扩展：隐藏/别名内置工具，别名保留原权限类别与 plan 门禁）；manifest `configSchema`（设置页渲染 typed 配置表单，server 松散校验）。
- 普通子代理 `general`：内置子代理类型注册表——`explore`（默认，只读探索，行为不变）与 `general`（通用：可读写文件、执行 bash，工具调用经与主代理相同的权限链与同配置沙盒，plan 门禁同源）；`spawn_task`/`spawn_swarm` 的 `agent` 参数与逐项派发均支持。
- WebUI 手动启动子代理：底部「子代理」面板顶部输入任务并选择类型（explore/general/自定义）即可启动，新增 `POST /api/sessions/:id/subagents`（并发上限 4）与 `GET /api/agents`；中断会话同时取消手动子代理。

### 界面与体验

- 运行活动条：对话区底部吸顶显示当前状态（思考中/执行工具/等待确认…）、已耗时长（秒级跳动）与正在执行的工具，空闲自动隐藏。
- 会话打开加载骨架屏，替代欢迎页闪烁；底部面板懒加载增加占位。
- 底部排版合并：状态栏内容（运行状态/模式/模型/token/窗口占用/成本）右移进面板页签条（桌面端），移动端保留原状态栏；去除与头部重复的工作目录显示。
- 子代理标签页与主对话同一渲染（MemoMessageCard 完整转录），低饱和状态色区分子代理标签与「对话」标签；子代理面板可直接手动启动；历史运行不再显示「0 轮」；转录 20 条折叠可展开。
- 对话轮次与层级深浅强调：assistant/tool 消息淡底色，工具卡片缩进并加左侧引导线。

### 性能

- agent 循环每轮两次全量解析消息历史改为会话级缓存（LRU 32，stat 指纹校验 + append-through）：`sessions.get()` p50 8.00→0.41ms（-94.9%），单轮总耗时 -74.9%，5000 消息会话每轮消除约万次 JSON.parse。
- 流式 Markdown 分块增量渲染：稳定块只解析一次，流式每帧仅重渲染尾部块（渲染管线不变），长回答流式主线程占用从平方级降为近线性。
- EventBus 单次序列化（扇出与驱逐复用）；ledger.json 内存缓存（每轮省 3 次原子写）；buildView 增量路径累计化（ledgerKey 惰性化、token/片段缓存、克隆复用）；`evict` 的 mkdir 提出循环；glob 排除正则按模式缓存；视图缓存加 LRU 上限。agent-loop 基准 buildView.p50 0.88→0.30ms。
- 新增 `bench-agent-loop` 基准场景，覆盖真实 agent 循环读路径（原 context-build 基准只喂内存数组，存在测量盲区）。

### 改进

- 设置对话框按页签拆分为独立组件（2038→360 行外壳）；删除死代码（initUserAgent、遗留 job 类型、parsePricingDocument）；格式化助手下沉 `lib/format.ts`；web 依赖清理（移除零引用的 zustand，`@vitejs/plugin-react` 移入 devDependencies）。

### 发布工程

- release.yml 新增 tag 与仓库版本一致性检查（`server/package.json` 与 `core/CMakeLists.txt` 不等于 tag 版本即失败）；bundled Node 下载增加官方 SHASUMS.txt 校验；Release 说明改为从 CHANGELOG 对应版本段提取（缺失或为空则阻断发布），替代自动生成。

### 升级说明

- Windows MSI 未做 Authenticode 签名，首次安装/升级可能被 SmartScreen 提示；发布资产（MSI/tar.gz）带 SHA256SUMS.txt，安装与在线更新流程均强制校验。

## [0.8.0] - 2026-07-28

### 新增

- 上下文窗口可视化：会话头部显示窗口占用 `45k/128k · 38%` 与细条（≥70% 黄、≥85% 红，按「上下文窗口 − 最大输出」的工作预算计），缓存命中胶囊 `缓存 82%`（悬停细分读取/写入/未缓存输入）；上下文面板新增「上下文窗口」区——大号占用表、按段（消息/工具结果/repoMap/压缩摘要/系统/其他）堆叠的 token 归因条与图例、本轮/累计缓存命中、水位提示（建议压缩 / 强制压缩）；状态栏显示 `窗口 N%`。数据来自实时 `context.watermark`/`context.usage` 事件，REST 兜底。
- 子代理实时卡片与 swarm 增强：`spawn_task`/`spawn_swarm` 在消息轨道渲染为实时卡片（swarm 逐项状态 pending/running/done/failed、实时轮次与工具数、生效 agent、逐项转录链接）；转录展示完整内部消息流（折叠到最近 20 轮）。服务端新增 `subagent.progress` WS 事件；`spawn_swarm` 的 items 支持 `{task, agent}` 逐项指定 agent（字符串形式仍兼容）；中断不再启动排队中的 swarm 项。
- 主窗口子代理标签页：子代理启动时在对话列顶部自动建标签（swarm 聚合成一个，不抢焦点，运行/完成/失败状态指示），标签内实时监视逐项进度并展开转录；底部「子代理」面板可对历史运行「在标签中打开」。标签按会话隔离，移动端走底部面板。
- 底部面板「子代理」标签页：会话级子代理监视——全部 `spawn_task`/`spawn_swarm` 按调用分组，swarm 聚合计数（完成/失败/运行中）、实时进度行、内联展开转录；由实时事件与消息历史共同派生，刷新后保留。
- 首次引导与测试连接：未配置服务商时空会话页显示三步快速上手（按钮深链到设置 → 模型目录）；设置对话框支持深链到指定分区；新建会话对话框的无服务商/无模型提示可点击跳转。服务商表单新增「测试连接」按钮与 `POST /api/provider-profiles/test`（openai：GET /models；anthropic：GET /v1/models?limit=1；5 秒超时），错误按认证/URL/不可达/限流分类为中文提示。
- 会话管理增强：会话重命名（双击标题或编辑按钮内联修改，清空可回落派生标题）与置顶（置顶排前），新增 `PATCH /api/sessions/:id`；删除确认改为样式化对话框（运行中会话禁用删除并提示先中断），替代原生 `window.confirm`。

### 界面与体验

- 设置重组：原「服务设置」页签解散——模型服务商/模型接入/快速模型并入「模型目录」，汇率并入「模型定价」，更新检查/执行器/存储并入「服务信息」，语言与货币并入「通用」，监听地址/端口并入「远程访问」；设置搜索与全部深链同步指向新归属。
- 高频操作五项：输入框历史召回（首行或空输入时 ↑/↓ 翻阅，自动暂存当前草稿，IME 组合中不触发）；Esc 中断运行中的 agent（不抢弹窗/对话框/权限卡/编辑器的 Esc）；代码块悬停复制按钮（触屏常显）；WebSocket 断连时显示「连接中断，正在重连…」横幅（1s 防抖）；输入框草稿按会话持久化到 localStorage（刷新恢复，删除会话时清理）。
- 错误可操作化：`agent.error` 事件携带 `kind`（authentication/permission/not_found/invalid_request/rate_limit/overloaded/network 等）与 `retryable`；运行错误卡给出可操作提示与设置深链按钮（认证/接口问题 → 模型目录），可重试的失败提供「重试」按钮（重发上一条用户消息，附件不随重试重发）；toast 改为一行摘要，不再直接展示原始 JSON。
- 更新提醒：启用更新检查且发现新版本时，通知中心出现按版本去重的提醒条目，点击跳转设置 → 服务信息。
- 设置页左侧导航新增搜索框（匹配分区/分组/字段标签，中英文）；页签切换纳入未保存更改确认（含定价 JSON 与提示词编辑）；`/help` 内置输入框命令打开快捷键速查；空会话页示例任务 chips 点击复制到剪贴板并提示。
- CLI：`owc --help` / `owc run --help` 输出中英双语帮助；参数错误退出码改为 1（退出码 2 专属权限拒绝）。

### 修复

- swarm 部分失败在刷新后全部显示为「完成」：工具结果新增 `subagentTasks` 逐项状态（taskId/序号/状态/错误），失败或中断的 spawn 调用也回填转录 id，子代理面板/标签历史不再丢失；失败子代理可展开转录。
- 子代理标签打开期间后台新消息把对话滚动位置清零；关闭的 swarm 标签被后续并发项的 `subagent.started` 重新打开。
- WebSocket 重连退避计数成功后不复位（二次断线直接 10s 起步）；其他会话的权限请求渲染进当前会话（补回归测试锁定既有防护）。
- `owc --version` / `--help` 恒显示 `0.0.0`（CLI 从未初始化版本缓存，v0.7.0 即存在）。
- 跨客户端重命名/置顶不生效（`session.updated` 被当前会话门拦死）；首条消息派生标题不发布事件。
- 设置切换页签静默丢弃未保存编辑；`updateCheckIntervalHours` 无法存 0（服务端本就支持 0=仅手动）且无上限校验；更新检查三个字段缺英文标签。

## [0.7.0] - 2026-07-27

### 新增

- `/init` 内置斜杠命令：分析当前工作区并生成/更新根目录 `AGENTS.md`（项目概述、构建与测试命令、代码组织、约定边界）；走正常 agent 流程，写文件经权限链与自动快照。
- `spawn_swarm` 并行子代理（agent 集群）：按 `prompt_template` + `{{item}}` 占位符 + `items[]` 一次派发 2–16 个只读子代理，并发上限 4、超出自动排队；单项失败不拖垮整批，结论按 `[序号/总数]` 聚合返回。单项任务仍用 `spawn_task`。
- 子代理可见性：新增 `subagent.started` / `subagent.finished` WS 事件与 `GET /api/sessions/:id/subagents/:taskId` 转录接口；`spawn_task`/`spawn_swarm` 工具结果携带转录 id，聊天中可展开「子代理转录」查看 prompt、轮次、工具与结论。
- 扩展 API 第一批：v1 扩展可 `registerTool` 注册 agent 工具（以 `ext__<扩展id>__<工具名>` 注入，与 MCP 工具共用权限链与 plan 模式拦截，单次调用 5 秒超时）、只读访问会话列表/详情（`sessions:read`）、读取上下文视图与 artifact（`context:read`）、订阅 `agent.state`/`tool.*`/`context.*`/`checkpoint.*`/`subagent.*` 事件流；能力调用按 manifest 权限逐项校验，缺权限即报错并如实标记扩展状态。

### 界面与体验

- 会话状态徽章补齐 completed/failed/aborted 中英文标签与语义色（绿/红/黄）。
- 窄屏（≤1024px）顶栏改为标题独占一行、操作区整行左对齐；「回到底部」按钮降级为纯图标并补 aria-label。
- 修复「加载更早的消息」按钮引用未定义 CSS 变量导致的透明背景；设置导航分组加分隔线；底部面板标签栏支持横向滚动、折叠按钮钉在右侧。

### 改进

- 索引符号提取下沉到 core：新增 `job.start kind:"index.extract"`（C 侧手写行匹配器，覆盖既有 9 种语言），server 索引管理器改为单次 job 批量提取，删除 JS 侧逐文件 `readFile` + 正则提取路径（`symbols.ts` 移除）；core 侧自动跳过超大/非 UTF-8/不支持扩展名的文件。

## [0.6.0] - 2026-07-27

### 新增

- 提示词修改：设置页新增「提示词」分组，可覆盖内置系统提示词基线并追加自定义指令；全局存于数据目录 `system-prompt.md` / `system-prompt-append.md`，项目级 `.owc/system-prompt.md` 覆盖全局。提示词不是安全边界，plan 模式/权限/沙箱仍由服务独立强制。
- 更新检查：设置页「更新检查」分组（默认关闭），启用后周期性查询 GitHub Releases 最新版本，结果在「服务信息」静默展示并支持手动「立即检查」与下载链接。
- WebUI 在线更新：设置页发现新版本后可一键更新——Windows 下载 MSI 后启动安装程序并退出当前服务；Linux 替换安装目录内容后自动/手动重启。启动器、systemd unit 与数据目录均保留。
- Linux 在线安装/更新脚本 `packaging/install-online.sh`：`curl | bash` 一条命令完成安装或升级，下载后先经 SHA-256 校验（失败即中止），已安装时进入更新模式替换 `lib/openwebcode/` 并保留启动器与数据目录；该脚本同时作为 release 资产发布。
- 版本号显示：设置页「服务信息」展示 Server/Core 版本与协议版本；CLI 新增 `owc --version`；新增 `GET /api/version`。
- 配置默认值拆分：安装目录 `config/defaults.json` 存放随发布更新的默认配置，数据目录 `server-settings.json` 只存用户覆盖，启动时按 env > 用户覆盖 > 安装默认自动组合；被覆盖项在安装默认变化时会提示「采纳新默认」。

### 改进

- 全部出站 HTTP 请求统一注入 `User-Agent: owc/openwebcode{version}`（LLM provider、MCP、联网工具、定价/汇率/模型目录同步、更新检查）；MCP `clientInfo` 版本号改为读取真实服务版本。
- delta 合批的占位事件不再复制累计文本，长流下每次突发减少 O(delta 数) 次对象分配。

## [0.5.2] - 2026-07-27

### 界面与体验

- 性能面板增加可持久化的实时监控开关；暂停时停止浏览器帧率采样，并暂停性能记录、服务指标和 Provider 状态轮询。
- 工作台在 1024px 以下切换为紧凑顶栏与临时侧栏抽屉，抽屉状态不再污染桌面侧栏偏好；修复窄窗口只剩活动栏、侧栏铺满页面和主区错位。
- Composer 调整为“对话在上、配置在下”：模型框收窄，思考开关与强度合并为单一选择器，次要模型能力收进高级设置，降低横向拥挤。
- 设置页重排分组和滚动边界，长扩展列表仅在内容区滚动，标题与底部操作保持稳定。

### 修复

- 安全：无认证回环模式的普通 HTTP 请求现在同样校验 loopback Host，封住 DNS rebinding 入口；启动 token 不再出现在请求日志，特殊字符 token 可安全写入并读取 HttpOnly Cookie。
- 安全：Windows 后台索引/搜索使用线程隔离的 deny 策略快照，避免并发会话串用路径规则或读取已释放内存；Linux Landlock 正确纳入显式 `allowPaths`。
- Core `session.configure` 改为事务式更新：无效配置不再破坏既有会话，也不会耗尽固定会话槽位；Windows AppContainer 能力探测改为真实创建 profile，失败时如实降级并报告 HRESULT。
- 带 `sessionId` 的 WebSocket 实时流与回放保持同一隔离语义，不再混入其他会话的 `agent.state`/`run.*`；异步发送失败会计数并移除失效连接。
- 切换到不支持当前 thinking/effort 的模型时，在同一次配置请求中清除不兼容值，避免先关思考再换模型的反直觉流程。
- 会话侧栏完整填充已保存的可调宽网格列，消除侧栏加宽后的空白槽和主工作区错位。
- 浏览器内存基准在采样前后主动回收垃圾并使用稳定低水位，避免共享 CI runner 的 GC 时机把正常内存波动误判为回归。

## [0.5.1] - 2026-07-26

### 改进

- 设置页重构为“个人偏好、AI 与服务、能力与连接、系统”四组导航；桌面端采用分组侧栏与固定内容标题，移动端切换为横向分类栏，并补充自然过渡、方向键导航和减少动态效果适配。

### 修复

- 性能基准的慢 WebSocket 客户端场景改用确定性的待发送消息队列触发背压，并为断连等待增加超时，避免 Linux runner 因 TCP 接收窗口差异永久挂起。

### 文档

- 明确 macOS 当前不受支持，避免将缺少原生沙盒后端误解为可正式运行。

## [0.5.0] - 2026-07-26

### 新增

- Monaco 编辑器与统一 diff：工具卡、Problems、SCM、Quick Open 和检查点均可打开懒加载编辑器或分栏 diff；支持逐 hunk 接受/拒绝、保存快捷键、只读/移动端降级，写回继续经过权限与 plan 门禁。
- 会话分页：首屏尾读并可向前加载历史；JSONL byte-offset/message-id 索引以 32 会话 LRU 有界缓存。
- Provider 并发控制：按 provider 设置并发上限，FIFO 排队；`GET /api/providers/stats` 暴露 active/queued/maxConcurrent。
- Core 并行 grep/glob：4 worker 搜索，结果确定性排序，并保留预算、取消、include/exclude 与 no-follow 语义。
- 性能诊断：底部面板展示渲染帧率、事件吞吐和 Turn 各阶段耗时；采样不包含消息内容、路径或模型名。
- 官方评测扩展 `owc-eval`：默认关闭；内置 3 个基础 mock-provider 示例与 1 个 0.4 回归契约任务，通过隔离工作区回放真实 AgentRunner。报告包含断言、工具轨迹、turn、token 与耗时，支持基线/候选对比和自包含 JSON 导出。

### 性能

- 活跃会话追加消息时，索引先校验旧 EOF 尾部，再只扫描新增字节；5000 消息基准的追加刷新 p50/p95 从 13.59/21.44ms 降至 1.40/1.64ms。
- 浏览器 5000 消息实测保持 59.88fps，输入回显约 25.2ms；长历史缓存分页 p50 为 0.58ms。

### 修复

- 编辑器写回增加 SHA-256 条件写；文件被并发修改时返回 409，不再静默覆盖。
- SCM 正确解析 `git status --porcelain=v1 -z` 的重命名/复制记录与特殊文件名；worktree 合并支持多提交分支，不再只 cherry-pick 单一提交。
- 取消尚在 Provider 并发队列中的请求会立即移除并拒绝，不再等到获得槽位后才响应。

### 发布工程

- Release 性能基准改为硬门禁：缺失上一 release 基线或任一可比指标回归超过 15% 都会阻断发布；首次建立基线必须显式启用 bootstrap。
- 发行产物归档基准 JSON，供下一版本直接比较。
- 手动触发 release workflow 时可显式启用 `skip_performance_tests` 跳过性能基准；默认仍执行，tag 触发不可跳过，跳过时不会生成或发布基准 JSON。

## [0.4.0] - 2026-07-25

### 新增

- 工作台重构为活动栏、侧栏、主区、底部面板和状态栏五区；新增命令面板、Quick Open、统一快捷键注册表与通知中心。
- 诊断闭环新增 `test_runner`，自动识别 Vitest/Jest、pytest、Go test 和 .NET test；统一 Problems 面板与 Shiki 只读代码视图。
- Git 集成新增 `git_status`、`git_diff`、`git_commit` 与 worktree 管理；SCM 面板展示分支、ahead/behind 和分组变更，提交始终需要确认。
- 代码库索引新增 Core `index.scan`、八种语言符号提取、`code_search` 和 `repo_map`；索引通过 Core watch 增量更新，损坏时完整重建。
- 上下文工程新增增量构建、Provider prompt-cache 断点、选择性 pin/排除和分段 token 成本归因。
- 非回环监听强制使用至少 32 字符的 `OWC_ACCESS_TOKEN`；浏览器通过 HttpOnly Cookie、CLI 通过 Bearer token 认证。
- 移动端提供单列响应式工作台与 ≥44px 交互目标；PWA manifest 支持安装到主屏，不启用不适用的离线缓存。

### 性能与稳定性

- `fs.watch.poll` 将同目录的突发事件折叠为目录级 changed 事件，降低构建目录事件风暴。
- 上下文构建复用连续 turn 的不可变前缀；事件 delta 合批并对慢客户端执行有界背压。
- 设置页新增快捷键和远程访问分区；无索引、无 Git 或功能不可用时，各面板提供明确降级状态。

## [0.3.10] - 2026-07-24

### 修复

- 安全：修复路径策略 deny 规则的绕过问题，拒绝路径及其后代不再可通过变形路径访问。
- 安全：`.owc` 目录内配置仅在可信来源下加载，避免工作区内被篡改的配置影响会话。
- 安全：事件 WebSocket 校验浏览器 `Origin`，阻止跨站页面接入本地服务。
- 安全：会话导入对数据做清洗，剔除非法或越权的字段与结构。
- 安全：MCP 服务器环境变量继承受控，不再把宿主全部环境暴露给子进程。
- 可用性：前台命令与后台任务统一遵守超时设置，避免无限挂起。
- 可用性：POSIX 子进程在取消与退出路径上完整回收，不再残留僵尸进程。
- 可用性：事件在跨会话场景下正确归属与投递。
- 可用性：统一 core 与各组件上报的版本号，消除与发行版本不一致。
- 可用性：修复 Windows 沙盒内 pwsh 工作目录回退到 `C:\` 导致相对路径命令被拒绝的问题；ACL 授权改用无子树传播的原生调用，消除大目录树上的卡顿。
- 可用性：兼容 Node.js 24。

## [0.3.8] - 2026-07-23

### 修复

- 在托管 CI 中跳过不稳定的冷启动 `pwsh` 集成测试；本地环境仍保留该真实集成覆盖，避免其偶发超时阻断发行。

## [0.3.7] - 2026-07-23

### 新增

- Tavily 联网配置同时提供 Search 与 Fetch；Fetch 使用 Tavily Extract API 提取目标页面正文。
- 快速模型直接从已启用服务商的统一模型目录选择，并可独立设置 thinking、effort 与最大输出上限。

### 变更

- 快速模型复用所选模型服务商的接口类型、Base URL 与凭据，不再维护独立服务商配置；旧的独立快速模型格式不再读取。

### 修复

- `fs.glob`、`fs.grep` 与 `fs.scan` 递归遍历时跳过 `System Volume Information` 等受保护子目录，不再因单个目录不可读而整体报 `permission denied`。

## [0.3.6] - 2026-07-23

### 新增

- 模型服务商改为可持久化的多配置注册表：每项独立选择 Anthropic Messages / OpenAI Chat Completions 接口、凭据与启用状态，并自动拉取或手动维护各自模型。
- 模型选择器合并所有已启用服务商的实际模型，统一显示为 `模型ID【服务商】`；同名模型按服务商独立存在。
- Web Search 与 Web Fetch 合并为多配置联网服务商注册表，通过能力声明分别选择当前配置；支持 Jina、Brave、Tavily 与 Custom。

### 变更

- 删除固定 Anthropic/OpenAI 与独立 Search/Fetch 的旧设置格式和环境变量入口，不执行旧格式迁移。
- 用户界面中的第二辅助模型更名为“快速模型”。

## [0.3.5] - 2026-07-23

### 新增

- 会话可在头部选择默认命令解释器或 PowerShell 7（`pwsh`）；前台命令、后台任务与 agent 工具统一遵循并持久化该选择。

### 修复

- Windows VHDX 托管工作区改为挂载到源工作目录旁的无点号目录，避免 AppContainer 无法穿越应用数据目录而导致 `cwd`、读写和列目录失败。
- AppContainer 在管理员宿主下只临时获得工作区祖先目录的穿越权限，实际读写权限仍限定在配置的工作区根目录，并在命令结束后清理。
- 修复 Core 重启后会话工作目录策略丢失所导致的 `session cwd is not configured` / `Core is not running`。
- 修复空后台输出响应缓冲区越界导致的 Core 退出与后续 `job not found`。
- VHDX 换叶与恢复统一规范化目录 access path，避免重复挂载报“requested access path is already in use”。

## [0.3.4] - 2026-07-22

### 修复

- Windows 在宿主 Job Object 不可用时，命令取消和超时会直接终止子进程，不再遗漏清理。
- Core 协议测试改用跨托管环境稳定的 Windows 命令解释器验证基础执行通道。

## [0.3.3] - 2026-07-22

### 修复

- 附件请求的测试清理会在短暂的异步收尾期间重试，避免临时会话目录偶发残留而中断发布门禁。
- Core 命令启动失败现在附带系统错误码，便于诊断受限 Windows 环境。

## [0.3.2] - 2026-07-22

### 修复

- 修复 Windows 受宿主 Job Object 限制时，关闭沙盒的命令无法启动的问题；已请求但未获得 AppContainer 的沙盒仍会安全地拒绝执行。
- Core 能力接口现在返回实际发行版本，避免与安装包版本不一致。

## [0.3.1] - 2026-07-22

### 修复

- 修复 Linux 文件系统扫描会返回平台相关目录大小的问题；目录条目现在始终报告大小为 0，与 Windows 保持一致。

## [0.3.0] - 2026-07-22

### 新增

- 会话消息现在记录父消息、运行和轮次归属，可在时间线中查看对话、工具、队列和交互事件。
- 新增持久化运行队列：可查看、重新排序、取消待执行消息，并将运行中的 follow-up 安全排入队列。
- Agent 可向界面发起结构化的选择、文本和确认交互；用户的响应会持久化并恢复到对应运行。
- 会话支持在空闲时创建仅复制对话数据的分支，避免意外复制或改写原工作区。

### 改进与修复

- 会话导入会保留消息的父级、运行和轮次关联，导入后时间线仍保持完整。
- Web 顶部状态栏与队列面板统一展示当前运行、排队项和待处理交互。

## [0.2.4] - 2026-07-22

### 新增

- Core 增加受沙盒和 16 MiB 读取预算约束的 `fs.hash`（SHA-256）接口及有界 `fs.statMany`，并由 Node Gateway 透传。
- Core 增加分页、深度和节点预算受限的 `fs.scan`，以稳定游标枚举受会话策略约束的目录树。
- Core 增加有界、可取消的 `fs.watch` 创建/轮询/取消接口；监听事件会合并并遵守会话拒绝路径策略。
- 托管工作区的源目录、挂载目录和基线扫描改用共享的 8 worker I/O 队列，同时保留 no-follow 与文件身份复验。
- 托管工作区同步预览现在返回源目录和托管目录各自的文件数、目录数与扫描字节数。
- 托管工作区同步支持安全取消：扫描与文件操作之间响应取消请求，且不打断单文件的原子替换。
- `tool.end` 事件改为固定长度摘要与 artifact 引用，不再把完整 Web、文件或后台任务结果写入 WebSocket 回放缓冲。
- Windows Core 提供可查询、可取消的后台作业控制；Agent 的长时间 bash 命令改用该通道，执行期间仍可继续对话。
- Core 的后台作业保留会话沙盒策略及额外写入路径，避免策略重配影响已启动的作业。

## [0.2.3] - 2026-07-21

### 新增

- 托管工作区在会话空闲时可从顶部直接创建**手动虚拟磁盘快照**；VHDX/qcow2 差分链检查点无需等待下一条用户消息。

### 改进与修复

- Windows Core 文件写入改为 handle-relative 的临时创建与原子替换，消除父目录在验证后被 reparse point 替换时的路径解析窗口。
- Core RPC 单帧限制统一为 32 MiB，并公开 `fs.stat` 与内部 `fs.writeBase64` 的客户端协议能力。
- 重构消息提交与自动快照流程：已接受的用户消息会优先落盘；快照、配置或非关键 Hook 失败时会保留对话，并在界面中持续显示可诊断的错误。
- 补齐异常工具调用的结果配对。兼容 Provider 即使给出错误的停止原因，也不会留下损坏的 `tool_call` 会话历史。
- 仅向模型目录中声明支持 `tools` 的模型发送工具 schema、工具提示、MCP、技能目录和后台任务通知；其他模型以普通对话方式运行。
- `web_search` 仅在搜索服务配置合法且可构造时暴露；Brave 空 API Key、非法 URL 和非 HTTP(S) 自定义端点会自动降级，不影响普通对话或 `web_fetch`。

### 升级说明

- “搜索服务可用”目前指配置有效且可构造，不会在每轮对话前进行联网健康检查；运行时网络或鉴权失败会以工具错误结果反馈给模型。

## [0.2.2] - 2026-07-21

### 改进与修复

- 恢复并加固消息发送路径：自动快照失败不再阻塞已接受的对话，界面会提示失败原因。
- Windows MSI 安装程序新增可选的“创建桌面快捷方式”和“添加到当前用户 PATH”页面；选择会在修复和升级时保留。
- 发布流水线增加 MSI Shell 集成选项校验，避免安装器界面与实际安装结果不一致。
- 修复思考内容的持久化与流式显示边界问题。

## [0.2.1] - 2026-07-21

### 新增

- 托管工作区支持**同步回源**：在“文件”面板生成三方差异预览后，由用户手动确认回写；默认只写入无冲突改动，不会在关闭或删除会话时自动覆盖源目录。

### 改进与修复

- 修复 Windows 虚拟磁盘挂载根作为工作目录时的文件访问与路径校验，继续拒绝普通 junction/symlink 逃逸。
- 改进托管工作区文件树错误反馈、后台任务输出解码与 Windows 运行稳定性。
- 强化同步回源的路径、符号链接、硬链接、文件变更与冲突校验。

## [0.2.0] - 2026-07-21

### 新增

- 新增英文界面与英文 README/打包文档；首次访问按浏览器语言选择中文或英文，并可在设置中随时切换。
- 模型目录与定价支持远程同步、持久化与手动编辑。模型能力可分别描述文本/图片/视频输入、图像输出、思考、力度与工具支持，避免把视频输入和图像输出混为一项能力。
- 新增第四个官方扩展 **PDF to Image**：Web 上传的 PDF 会先保存到工作区；扩展启用时可转换页面为图片附件，停用时则把保存路径直接引用给模型。
- Linux `install.sh` 增加交互式安装配置，可选择安装前缀、端口、数据目录、监听地址、Node.js 与用户级 systemd；脚本或 CI 可用 `--yes` 无交互执行。

### 改进与修复

- 更新应用图标、数据目录与分发体验；整理 Windows MSI 与 Linux tar.gz 的发布、安装和冒烟验证流程，补全文档与安装参数说明。
- 清理误纳入仓库的构建产物和依赖目录，完善忽略规则；内部规划文档改为仅本地维护。

## [0.1.0] - 2026-07-20

### 首次公开版本

- 提供浏览器中的 AI 编码工作台：会话管理、流式输出、Steering 队列、多 Provider（Anthropic 与 OpenAI 兼容协议）、模型目录刷新与会话内热切换。
- 提供完整的 Agent 工具链：文件读写/编辑、bash、glob/grep、任务清单、长期记忆、只读子代理、文件引用、Shell 快捷命令、网络抓取与可插拔搜索。
- 提供 Plan / Build 双模式、三级权限确认、上下文账本、压缩与恢复、token/成本预算、按会话/日期/provider 的成本报表。
- 支持自动与手动检查点、时间线回滚、Btrfs/ZFS/ReFS 原生快照探测、git 影子仓库兜底，以及 VHDX/qcow2 托管工作区。
- 提供 Windows AppContainer、Windows Sandbox、Job Object 兼容兜底与 Linux Landlock 沙盒；能力状态如实上报。
- 支持 Skills、MCP、Hooks、自定义子代理、自定义斜杠命令和独立 Extension Host，并提供官方扩展体系。
- 支持图片输入、Markdown/代码高亮/KaTeX、折叠思考内容、会话导入导出、可分享的自包含 HTML 页面和 `owc run` Headless CLI。
- 提供 Windows MSI、Linux tar.gz 安装脚本和 GitHub Actions 发布流水线。
