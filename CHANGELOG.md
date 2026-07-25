# 更新日志

本文记录 OpenWebCode 从首次公开版本 `v0.1.0` 到当前版本的用户可感知变化。日期以 Git 标签发布日期为准。

## Unreleased

### 新增

- 工作台五区布局（0.4.0 Phase 5）：活动栏/侧栏/主区/底部面板/状态栏重构为固定职责的五区模型，`F6` 在区域间轮换，布局状态（侧栏宽度、面板开合）按工作区持久化在本机；对话轨道与输入框始终是主区中心。
- 命令面板与 Quick Open：`Ctrl/Cmd+Shift+P` 命令面板统一暴露会话/运行/面板/设置等全部内建命令（20 项），标注当前快捷键，`>` 前缀强制命令模式；`Ctrl/Cmd+P` Quick Open 混排工作区文件（索引供数、未建索引回退 glob）与符号条目（`#` 前缀），共用模糊匹配与防抖乱序丢弃；两者均为懒加载独立 chunk。
- 快捷键体系：全局 keybindings 注册表（`{ commandId, key, when }`），默认集对齐 VSCode 习惯（`mod+B` 侧栏、`mod+`` 底部面板、`mod+,` 设置、`mod+Shift+E/F/G/M` 各视图、`mod+L` 聚焦输入框、`mod+PageUp/Down` 切换会话等），输入框焦点下不抢键；`Shift+?` 打开快捷键速查；0.4.0 暂不支持自定义键位。
- 诊断闭环（0.4.0 Phase 3）：新增 `test_runner` 工具——自动检测项目类型（package.json/pyproject/go.mod/*.sln）生成默认运行命令，经 Core job 执行并继承权限与沙盒；vitest/jest、pytest、go test、dotnet test 四类输出解析为统一 `DiagnosticSet`（解析失败回退原文尾部，不丢输出），失败摘要有界回授 agent（前 20 条、每条 ≤500 字符），完整结果落会话 artifact 并经 REST/WS 暴露。
- Problems 面板：诊断按文件分组、严重度过滤、来源工具标注，点击跳转到只读代码视图对应行列；agent 运行中的新诊断以角标提示，不弹窗打断。
- 只读代码视图：Shiki 按行高亮 + 行号 + 行列跳转的统一代码查看形态，从工具卡、Problems、SCM diff 或 Quick Open 打开，关闭即回到对话；diff 为只读渲染（hunk 级接受/拒绝与编辑器属 0.5.0）。
- Git 集成（0.4.0 Phase 4）：新增 `git_status`/`git_diff`/`git_commit` 工具——状态按 porcelain 分组（每组 200 条截断保留 totals）、diff 大输出落 artifact、提交在 yolo 下也需确认且拒绝 `--no-verify`；Source Control 面板展示分支/ahead-behind 与三组变更状态、只读 diff 入口，提交辅助经对话下发 `git_commit`（默认不开放 agent 自动提交）；无 git 仓库时面板降级为如实标注。worktree 创建/合并/移除（上限 4、冲突 `--abort` 如实报告）经服务端 REST 提供，子代理 `isolation:"worktree"` spawn 参数留待 0.5.0。
- 代码库理解（0.4.0 Phase 2 Node 侧）：服务端符号提取（TS/JS、Python、Go、Rust、C/C++、Java、C# 八种语言）与索引存储（`<业务数据目录>/index/<workspace-hash>/`，append-only + 压实，损坏整体重建）；新增 `code_search`（符号名模糊 + 种类过滤，未建索引明确回退 grep）与 `repo_map` 工具（默认 2k token 预算、会话可关、索引可用时附关键文件符号）；索引新鲜度以 Core watch 驱动增量更新，watch 不可用时降级 mtime 抽样，REST 提供索引状态/重建/符号查询。
- Prompt cache 断点（0.4.0 Phase 1）：支持的 Provider 上把稳定前缀组织为显式 cache 断点（≤4 个），连续 turn 前缀逐字节一致；cache 命中/创建/读取 tokens 进入成本面板与 usage 日志。
- 远程访问 token 认证：非回环监听（`OWC_HOST` 非 `127.0.0.1`）强制要求 `OWC_ACCESS_TOKEN`（≥32 字符），否则拒绝启动；浏览器经 `?token=` 换取 HttpOnly Cookie，CLI 用 `OWC_ACCESS_TOKEN` 环境变量走 Bearer 头。设置页「远程访问」分区展示监听状态与风险提示。
- Core `index.scan` 作业（0.4.0 Phase 2 第一块）：`job.start` 新增 `kind:"index.scan"`，按 glob include/exclude 规则产出完整文件清单（路径、大小、mtime、SHA-256），遵守节点/深度/字节（哈希）/时间预算、可取消、结果按路径排序确定；输出经 `job.output` 分页为 JSONL 条目流 + 末行 summary（截断原因与哈希预算标记）。增量变化集由 Node 侧对连续 manifest 做 diff，core 不做语言解析。`core.ping` 新增 `indexScan` capability 与 `maxIndexScan*` limits（双平台声明）；协议见 `docs/protocol.md`。
- watch 突发折叠：`fs.watch.poll` 在同批去重之后，若某目录（含被监听根）产生 4 个及以上事件，折叠为一条目录级 `changed` 事件，可向上传播，抑制 build 目录等突发变更的事件风暴。
- 上下文工程（0.4.0 Phase 1）：ContextManager 增量复用上一 turn 的不可变前缀构建结果（消息构建与 token 估算），压缩/驱逐/恢复/配置变更自动回退全量重建，最终注入字节与全量构建等价；每 turn 构建耗时与增量标记进入 run 诊断（context.watermark 事件）。
- 选择性上下文：会话级 pin（消息 id/文件路径，不被驱逐；pin 占用超预算时如实警告）与排除路径 glob（不进上下文组装，repo map/索引钩子预留）。清单持久化在会话配置，Context 面板可视化管理。注意：排除不是安全边界，文件访问仍由路径策略与沙盒保证。
- 成本归因：上下文按段（压缩摘要/工具结果/对话消息等）统计 token，Context 面板展示"钱花在哪一段"与构建耗时。
- 通知中心（0.4.0 Phase 5b）：toast 提示与后台事件（任务完成、诊断更新、SCM 更新、后台任务结束）汇总为可回看列表；未读角标、逐条/全部清除、点击跳转相关会话与视图；活动栏铃铛入口与 `workbench.action.showNotifications` 命令；权限请求与结构化交互不进入通知流。
- 设置页升级：新增"快捷键"分区（如实列出默认键位集，暂不支持自定义）与"远程访问"分区（展示监听地址、回环/非回环状态与 token 认证说明；非回环监听持续展示风险提示）。
- 移动端（§6.8）：断点统一为 ≤768px，活动栏变顶部横条（保留全部入口），侧栏变全屏抽屉（选中会话自动收起），底部面板全屏 sheet；权限/交互/队列按钮点击目标 ≥44px；会话切换经顶部入口可达。
- PWA：新增 manifest（standalone、图标、theme_color）与 apple-touch-icon，可安装到主屏；不做离线缓存 SW（应用强依赖实时连接，见 docs/0.4.xplan.md §6.8 取舍）。

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

[0.3.10]: https://github.com/snnh/openwebcode/compare/v0.3.8...v0.3.10
[0.3.8]: https://github.com/snnh/openwebcode/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/snnh/openwebcode/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/snnh/openwebcode/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/snnh/openwebcode/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/snnh/openwebcode/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/snnh/openwebcode/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/snnh/openwebcode/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/snnh/openwebcode/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/snnh/openwebcode/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/snnh/openwebcode/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/snnh/openwebcode/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/snnh/openwebcode/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/snnh/openwebcode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/snnh/openwebcode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/snnh/openwebcode/releases/tag/v0.1.0
