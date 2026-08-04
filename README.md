# openwebcode

[English](./README.en.md) | 简体中文

浏览器打开即用的 AI 编码工作台，界面中英双语。原生支持 Windows / Linux，自带沙盒、快照回滚与上下文管理。

```
浏览器 (React)  ──HTTP/WebSocket──►  Node 服务层 (Agent 循环、工具调度)  ──JSON-RPC──►  C 执行器 (命令/文件/沙盒/快照)
```

## 功能概览

- 读写项目文件、跑命令、跑测试，多轮推进到一个任务完成
- Plan 模式下只读调研、产出分步计划，确认后切 build 执行
- 每轮自动打检查点，时间线面板可回滚文件与会话历史；快照后端按探测链自动选择（Linux：btrfs / zfs / overlayfs → git shadow），也可显式指定
- 默认沙盒隔离（Windows Job Object / Linux Landlock，可显式切 AppContainer），不可信代码可用 WSB，一会话一 VM
- 全部出站请求（模型 API、联网搜索/抓取、更新检测）可走代理：关闭 / 跟随环境变量 / 自定义，保存即生效
- 联网搜索可选本地服务商执行，或由模型服务端执行（OpenAI Responses 接口，如 DeepSeek）
- bash 后台任务继续跑，不阻塞对话，完成后自动通知
- 对话渲染 GFM Markdown、代码高亮与 KaTeX 公式；思考过程默认折叠并弱化显示；思考与工具调用按真实顺序交织，相邻工具调用自动合并折叠
- `owc run "..."` 非交互执行，`--json` 输出 NDJSON 事件流，可用于 CI

## 快速开始

### Windows

1. 从 [Releases](https://github.com/snnh/openwebcode/releases) 下载 `openwebcode-<version>-windows-x64.msi` 双击安装（需管理员权限）；在 “Shell integration” 页按需保留桌面快捷方式和“添加到 PATH”选项
2. 若勾选 PATH，重新打开终端后运行 `owc`；否则从安装目录的 `bin\owc.cmd` 启动
3. 浏览器打开 <http://127.0.0.1:3210>

### Linux

支持 x86_64、aarch64（arm64）与龙芯 loongarch64；在线安装脚本自动按架构选择包：

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
```

或手动下载对应架构的 tar.gz（`linux-x64` / `linux-arm64` / `linux-loongarch64`）：

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-<arch>.tar.gz -C openwebcode
cd openwebcode
# 直接运行时会在 TTY 中询问安装前缀、端口、数据目录、监听地址和 Node 选择
./install.sh
~/.local/bin/owc                  # 浏览器打开 http://127.0.0.1:3210
```

龙芯（loongarch64）包不内置 Node.js，安装时需系统 Node.js ≥ 24（`--use-system-node`，包内无 node/ 时安装脚本会自动走该路径）。

脚本/CI 安装使用 `--yes` 避免提问，例如：

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3210 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

完整选项、系统 Node.js 和用户级 systemd 服务说明见 [`packaging/README.md`](./packaging/README.md)。

### 首次使用

1. 界面首次按浏览器语言选择中文或英文；可在 **设置 → 外观 → 语言** 随时切换，选择保存在本机并立即生效。
2. 在 **设置 → 模型目录** 添加并启用一个或多个具名模型服务商，选择 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses 接口，再刷新模型目录。模型统一显示为 `模型ID【服务商】`。
3. 侧栏 **+** 新建会话：选工作目录、provider/模型、沙盒模式、工作区模式。
4. 输入框描述任务，回车发送。若选择「托管工作区」，源目录会先复制到镜像盘；会话空闲时可在顶部点「手动快照」立即创建虚拟磁盘差分链快照。需要回写时，在底部「文件」面板点「同步回源」，先核对差异再确认。

> 关闭浏览器标签页 **不会** 停止正在运行的 agent——服务器继续执行，结果照常落盘，重开 UI 选回会话自动补拉断线期间事件。要主动停下用顶部「中断」按钮。

## 输入框速查

| 输入 | 含义 |
|---|---|
| 普通文本 | 发给 agent 的任务描述 |
| `/技能名` | 触发 Skill |
| `/自定义命令` | 触发项目 `.owc/commands/` 里的斜杠命令模板 |
| `/compact` | 概览压缩上下文（结构化摘要） |
| `/compact tools` | 规则压缩（toolcalls 占位精炼） |
| `/clear` | 清空当前视图，**保留历史**（可回滚） |
| `@路径` | 引用工作区文件，内容随消息注入 |
| `!命令` | shell 快捷前缀，走 bash 权限链执行，结果可一键发给 agent |

运行中再发消息会进入 **steering 队列**，下一轮注入，不打断当前作业。默认 Enter 发送、Shift+Enter 换行（设置里可改）。

## 主要能力

**Agent 工具集**：bash（含后台任务；命令解释器按平台探测——Windows `pwsh > Git Bash > cmd`，Linux `bash > pwsh > $SHELL`，可按会话强制 pwsh）、文件读写/编辑、glob/grep、`repo_map`/`code_search`（工作区符号索引）、`test_runner`（结构化诊断）、`spawn_task`/`spawn_swarm`（隔离上下文子代理，后者一次并行派发多项任务）、`remember`（长期记忆）、`todo_write`（任务清单实时展示）、`web_fetch`/`web_search`（SSRF 防护）、MCP 与扩展注入工具。工具 schema、工具提示和 MCP 只会下发给模型目录中标为支持 tools 的模型；不支持时会以普通对话运行。联网工具通过统一的具名服务商注册表配置，每项声明 Search/Fetch 能力，再分别选择当前配置；没有选中对应能力时不会下发该工具或提示词。

**自定义扩展**（项目 `.owc/` + 全局两级，项目同名覆盖全局）：
- `agents/*.md` — 专职子代理（frontmatter 声明工具集、模型、服务商与模型角色，`spawn_task agent=<name>` 调用）
- `commands/*.md` — 斜杠命令模板（`$ARGUMENTS` / `$1..$9` 参数替换）
- `hooks.json` — PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart / SessionEnd / PreCompact / PostCompact / Notification / SubagentStart / SubagentStop 钩子，shell 命令执行，Pre 类事件 exit 2 可否决
- `skills/` — Skills（`/name` 触发，正文按需加载）
- `mcp.json` — MCP 客户端配置（stdio/HTTP 双传输）

**模型**：可保存并独立启用多个模型服务商，每个服务商自动拉取或手动维护自己的模型；同名模型按服务商独立存在。会话中可热切换统一模型列表，并支持思考程度、缓存断点优化和按 provider 成本报表。支持四档模型角色（极致/平衡/快速/廉价）与会话默认模型设置：子代理派发时可按任务用 `role` 参数下发到不同模型执行，难题走极致档、批量轻活走廉价档，成本按实际模型归属。

**权限**：ask / acceptEdits / review / yolo 四级。「允许一次」仅批准当前调用，响应送达后才启动工具；「总是允许」生成持久规则。review 为模型审核档：需确认的调用先由审核模型（快速模型或会话当前模型）评判风险，判 LOW 自动放行并留审计事件，判 HIGH、审核失败或结果无法解析一律转人工，`git_commit` 永远强制人工。「总是允许」与 yolo 都不解除沙盒——两个机制正交。

**沙盒**（默认开启）：Windows Job Object（默认，可切 AppContainer）/ WSB（不可信代码）/ Linux Landlock。能力探测如实上报（enforced/partial/advisory）。Windows 11 24H2+ 可选 Bind Link 目录绑定（需管理员运行）：把会话工作区内的虚拟路径透明映射到外部真实目录，面向共享依赖缓存等场景。

**快照回滚**：每轮用户消息前自动检查点，也可切为「仅手动」；后端自动探测 Btrfs/ZFS/ReFS，兜底 git 影子仓库；可选「托管工作区」（项目位于 VHDX/qcow2 镜像盘挂载点上，差分链快照毫秒级、可分支）。托管工作区会在顶部提供「手动快照」，空闲时可随时立即生成镜像盘检查点。它不会在关闭或删除会话时自动覆盖源目录；可随时在「文件」面板生成三方差异，确认后只回写无冲突的改动。

**上下文管理**：token 预算账本、滚动驱逐 + 占位符回写、快速模型两种压缩、85% 水位强制概览压缩。会话头部实时显示上下文窗口占用与缓存命中，上下文面板给出分段 token 归因与水位提示。前端始终看全量历史，驱逐只影响 LLM 视图。

**子代理**：内置 `explore`（只读探索）与 `general`（通用读写，走与主代理相同的权限链与同配置沙盒）两种类型，另可自定义子代理（frontmatter 可声明工具集、模型、服务商与模型角色）；`spawn_swarm` 按模板一次派发 2–16 项任务（并发上限 4，超出排队），逐项可指定 agent 与模型角色。聊天内实时卡片、主窗口标签页与底部「子代理」面板实时监视进度与转录，面板顶部可手动启动子代理。

**多会话与会话树**：会话历史树形存储——用户消息可「编辑重发 / 重新生成 / 分叉」，旧分支始终保留，时间线面板可从任意节点「从此处继续」；侧栏管理多个会话（重命名、置顶）。

**索引、诊断与 SCM**：符号索引由 core 侧提取，为 `repo_map`/`code_search` 供数；`test_runner` 跑测试/构建/lint 后结构化诊断进「问题」面板，按文件分组、点击跳转行列；「SCM」面板展示分支与变更 diff、行内 stage/unstage/discard、提交历史与 worktree 一键合回，生成提交信息（提交始终需确认，yolo 也不例外），agent 写文件后自动刷新。「文件」面板支持大文件分页预览、图片直显与 Markdown 渲染双态。

**WebUI 在线更新**：设置页发现新版本后可一键更新——Windows 下载 MSI 并启动安装程序覆盖升级；Linux 替换安装目录内容后重启。发布资产均附 SHA256SUMS.txt，在线安装/更新流程强制校验；启动器、systemd unit 与数据目录不受影响。

**扩展系统**：独立 Extension Host 子进程（IPC、5 秒钩子保护、manifest 权限与持久化管理）。第三方扩展可用的 API 面与官方扩展看齐：注册工具与会话/上下文/事件访问、提示词钩子、私有存储、REST 路由注册、模型调用通道、提示词与工具塑形、会话级扩展状态（示例见 `examples/extensions/demo`）。内置六项官方扩展：context-manager、attention-optimizer、content-lens、pdf-to-image、env-sim（环境模拟，切换产品风格提示词与工具形态）与 owc-eval 评测服务；默认仅启用 context-manager 与 pdf-to-image，其余在设置页按需启停、调参，并可从本地目录安装第三方 `owc-ext-*` 扩展。

**会话生命周期**：关浏览器不停 agent；断线重连自动补拉；权限请求挂起等待响应（**无超时**，长任务需回来确认）。

**其他**：多模态图片输入（粘贴/拖拽）、会话导出/导入（JSONL）、会话分享（`export.html` 自包含只读页）、存储 GC。

## Headless CLI

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json --yolo
```

- `--json` — 输出 NDJSON 事件流，便于脚本解析
- `--yolo` — 权限请求自动 allow（CI 场景）
- `--session <id>` — 复用已有会话续聊
- 退出码：`0` 完成 / `1` agent 错误 / `2` 权限拒绝

## 配置文件位置

`<启动/设置目录>` 按启动方式确定：用户显式设置的 `OWC_DATA_DIR` 优先；未设置时，安装版启动器会注入平台注册默认值（Windows `%USERPROFILE%\openwebcode`，Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才用相对 `server` 目录的 `../.openwebcode` 作为兜底。旧默认目录 `%LOCALAPPDATA%\openwebcode` 中的数据会在启动器下次启动时一次性自动迁移到新位置。为避免相对路径按 `server` 目录解析，建议为 `OWC_DATA_DIR` 和设置页中的数据目录填写绝对路径。

设置页的持久化文件固定为 `<启动/设置目录>/server-settings.json`。其中已保存的“数据目录”会在**未设置 `OWC_DATA_DIR`**时、下次启动后决定 `<业务数据目录>`；设置文件本身不会随之移动。未保存覆盖时，`<业务数据目录>` 与 `<启动/设置目录>` 相同。

| 路径 | 用途 |
|---|---|
| `<启动/设置目录>/server-settings.json` | 设置页保存的用户覆盖（默认值随发布内置，此处只存覆盖项） |
| `<业务数据目录>/provider-profiles.json` | 多模型/联网服务商配置与密钥 |
| `<业务数据目录>/sessions/<id>/` | 会话数据（meta + messages.jsonl + ledger + artifacts） |
| `<业务数据目录>/{agents,commands,skills}/` | 全局自定义扩展点 |
| `<业务数据目录>/hooks.json` | 全局 Hooks（**安全级别等同 yolo**） |
| `<业务数据目录>/mcp.json` | 全局 MCP 客户端配置 |
| `<业务数据目录>/extensions/` | Extension Host 配置与第三方扩展 |
| `<cwd>/.owc/` | 项目级（同名覆盖全局） |

## 从源码构建

```sh
# core（C 执行器）
cmake -S core -B build && cmake --build build
ctest --test-dir build

# server（Node 服务层）
cd server && npm ci && npm run build && npm test && npm start

# web（前端，产物由 server 静态托管）
cd web && npm ci && npm run build && npm test
```

从干净源码组装 `build/stage`、本地生成 MSI/tar.gz、执行冒烟检查及触发 GitHub Release 的完整流程见 [`packaging/README.md`](./packaging/README.md)。

## 文档

- **用户文档**（随 git 同步）：
  - [`CHANGELOG.md`](./CHANGELOG.md) — 版本更新日志（v0.1.0 至当前版本）
  - [`help/usage.md`](./help/usage.md) — 使用帮助：启动、输入框快捷、运行中操作、自定义扩展点模板（子代理/斜杠命令/Hooks）
  - [`help/faq.md`](./help/faq.md) — 常见问题：模型接入、权限与沙盒、上下文管理、快照回滚、CLI 集成、故障排查
- **开发者文档**（随 git 同步）：
  - [`help/development.md`](./help/development.md) — 编译与二次开发：仓库布局、三件套构建、本地开发循环、测试约定、二次开发切入点、CI 与发布
- **内部文档**：`docs/` 仅在本地维护，不随远端仓库分发
- [`packaging/README.md`](./packaging/README.md) — 完整打包流程、分发布局、安装脚本与 CI 发布流水线

## 卸载

- **Windows**：「设置 → 应用」卸载，默认数据目录 `%USERPROFILE%\openwebcode` 保留；显式 `OWC_DATA_DIR` 指定的数据也不会自动删除
- **Linux**：`rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc`，用户数据保留

## 赞助

OpenWebCode 是个人维护的开源项目。如果它对你有帮助，欢迎通过 [donate.md](./donate.md) 赞助支持持续开发。

<img src="./assets/donate-wechat.png" alt="微信赞赏码" width="240">

## 特别感谢
1. 感谢 deepseek、kimi-k3、qwen，本项目由上述模型辅助开发
2. 感谢一些群友提供的灵感
3. 感谢 [pi-agent](https://github.com/earendil-works/pi)，本项目默认系统提示词以其为基线（MIT，作者 Mario Zechner）
