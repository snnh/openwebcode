# openwebcode

浏览器打开即用的 AI 编码工作台。原生支持 Windows / Linux，自带沙盒、快照回滚与上下文管理。

```
浏览器 (React)  ──HTTP/WebSocket──►  Node 服务层 (Agent 循环、工具调度)  ──JSON-RPC──►  C 执行器 (命令/文件/沙盒/快照)
```

## 它能做什么

- **让 AI 直接在你的项目里干活**：读写文件、跑命令、跑测试，多轮自主推进到一个任务完成
- **写之前先看清楚**：Plan 模式下 AI 只读调研、产出分步计划，你确认后切 build 才动手
- **随时回退**：每轮自动打检查点，时间线面板一键回滚（文件 + 会话历史一起退）
- **不怕跑飞**：默认沙盒隔离（Windows AppContainer / Linux Landlock），不可信代码可上 WSB 一会话一 VM
- **长任务不阻塞**：后台 bash 任务继续跑，你照常对话，完成自动通知
- **技术内容直接读**：对话支持 GFM Markdown、代码高亮与 KaTeX 公式；思考过程默认折叠并弱化显示
- **脚本可集成**：`owc run "..."` 非交互执行，`--json` 出 NDJSON 事件流，CI 直接用

## 快速开始

### Windows

1. 从 Releases 下载 `openwebcode-<version>-windows-x64.msi` 双击安装（需管理员权限）
2. 终端运行 `owc`（把 `bin` 加进 PATH 后任意终端都行）
3. 浏览器打开 <http://127.0.0.1:3000>

### Linux

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh --prefix ~/.local    # 可选 --with-systemd 注册用户级服务
~/.local/bin/owc                  # 浏览器打开 http://127.0.0.1:3000
```

### 首次使用

1. **设置页**配置模型提供商（baseUrl、apiKey），点「刷新模型目录」拉取可用模型。Anthropic 与 OpenAI 兼容协议（DeepSeek/Qwen/Ollama 等）都支持。
2. 侧栏 **+** 新建会话：选工作目录、provider/模型、沙盒模式、工作区模式。
3. 输入框描述任务，回车发送。

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

**Agent 工具集**：bash（含后台任务）、文件读写/编辑、glob/grep、`spawn_task`（隔离上下文子代理）、`remember`（长期记忆）、`todo_write`（任务清单实时展示）、`web_fetch`/`web_search`（SSRF 防护）、MCP 注入工具。

**自定义扩展**（项目 `.owc/` + 全局两级，项目同名覆盖全局）：
- `agents/*.md` — 专职子代理（frontmatter 声明工具集与模型，`spawn_task agent=<name>` 调用）
- `commands/*.md` — 斜杠命令模板（`$ARGUMENTS` / `$1..$9` 参数替换）
- `hooks.json` — PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart 钩子，shell 命令执行，PreToolUse exit 2 可否决工具调用
- `skills/` — Skills（`/name` 触发，正文按需加载）
- `mcp.json` — MCP 客户端配置（stdio/HTTP 双传输）

**模型**：会话中热切换、思考程度开关（low/medium/high）、缓存断点优化（Anthropic 显式 cache_control，OpenAI 系自动）、按会话/按日/按 provider 成本报表（双币种 USD/CNY）。设置页可按“每百万 tokens 单价”维护带生效日期的模型定价。

**权限**：ask / acceptEdits / yolo 三级。「允许一次」仅批准当前调用，响应送达后才启动工具；「总是允许」生成持久规则。「总是允许」与 yolo 都不解除沙盒——两个机制正交。

**沙盒**（默认开启）：Windows AppContainer（Job Object 兼容兜底）/ WSB（不可信代码）/ Linux Landlock。能力探测如实上报（enforced/partial/advisory），不谎报。

**快照回滚**：每轮用户消息前自动检查点；后端自动探测 Btrfs/ZFS/ReFS，兜底 git 影子仓库；可选「托管工作区」（项目活在 VHDX/qcow2 镜像盘上，差分链快照毫秒级、可分支）。

**上下文管理**：token 预算账本、滚动驱逐 + 占位符回写、provider2 两种压缩、85% 水位强制概览压缩。前端始终看全量历史，驱逐只影响 LLM 视图。

**扩展系统**：独立 Extension Host 子进程（IPC、5 秒钩子保护、manifest 权限与持久化管理）。内置 context-manager、attention-optimizer、content-lens；可在设置页启停、调参并从本地目录安装第三方 `owc-ext-*` 扩展。

**会话生命周期**：关浏览器不停 agent；断线重连自动补拉；权限请求挂起等你 respond（**无超时**，长任务记得回来确认）。

**其他**：多模态图片输入（粘贴/拖拽）、GFM Markdown + KaTeX 数学公式、折叠思考块、会话导出/导入（JSONL）、会话分享（`export.html` 自包含只读页）、Headless CLI（`owc run`）、断线重连、存储 GC。

## Headless CLI

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json --yolo
```

- `--json` — 输出 NDJSON 事件流，便于脚本解析
- `--yolo` — 权限请求自动 allow（CI 场景）
- `--session <id>` — 复用已有会话续聊
- 退出码：`0` 完成 / `1` agent 错误 / `2` 权限拒绝

## 配置文件位置

| 路径 | 用途 |
|---|---|
| `~/.openwebcode/config.json` | 全局配置（provider/模型/定价/汇率/上下文策略） |
| `~/.openwebcode/sessions/<id>/` | 会话数据（meta + messages.jsonl + ledger + artifacts） |
| `~/.openwebcode/{agents,commands,skills}/` | 全局自定义扩展点 |
| `~/.openwebcode/hooks.json` | 全局 Hooks（**安全级别等同 yolo**） |
| `~/.openwebcode/mcp.json` | 全局 MCP 客户端配置 |
| `~/.openwebcode/extensions/` | Extension Host 配置与第三方扩展 |
| `<cwd>/.owc/` | 项目级（同名覆盖全局） |

Windows 下 `~` 指 `%USERPROFILE%`。

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

分发布局与 CI 流水线细节见 `packaging/README.md`。

## 文档

- **用户文档**（随 git 同步）：
  - [`help/usage.md`](./help/usage.md) — 使用帮助：启动、输入框快捷、运行中操作、自定义扩展点模板（子代理/斜杠命令/Hooks）
  - [`help/faq.md`](./help/faq.md) — 常见问题：模型接入、权限与沙盒、上下文管理、快照回滚、CLI 集成、故障排查
- **开发者文档**（随 git 同步）：
  - [`help/development.md`](./help/development.md) — 编译与二次开发：仓库布局、三件套构建、本地开发循环、测试约定、二次开发切入点、CI 与发布
- **开发文档**（`docs/`，本地不随 git 同步）：架构总览、RPC 协议规范、实施阶段与交接记录
- `packaging/README.md` — 分发布局、安装脚本与 CI 发布流水线

## 卸载

- **Windows**：「设置 → 应用」卸载，用户数据默认保留（可选全删 `~/.openwebcode/`）
- **Linux**：`rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc`，用户数据保留

## 特别感谢
1. 感谢glm-5.2，kimi-k3，本项目由上述模型辅助开发
2. 感谢一些不愿透露姓名的群友提供的灵感
