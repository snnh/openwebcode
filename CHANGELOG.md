# 更新日志

本文记录 OpenWebCode 从首次公开版本 `v0.1.0` 到当前版本的用户可感知变化。日期以 Git 标签发布日期为准。

## Unreleased

### 新增

- Tavily 联网配置同时提供 Search 与 Fetch；Fetch 使用 Tavily Extract API 提取目标页面正文。
- 快速模型直接从已启用服务商的统一模型目录选择，并可独立设置 thinking、effort 与最大输出上限。

### 变更

- 快速模型复用所选模型服务商的接口类型、Base URL 与凭据，不再维护独立服务商配置；旧的独立快速模型格式不再读取。

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
