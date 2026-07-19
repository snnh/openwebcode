# openwebcode

AI 编码工作台：WebUI 客户端 + C 执行器 + Node.js 服务层，原生支持 Windows / Linux。
Agent 循环在 Node 层，C 只做执行器（命令、PTY、文件、沙盒、快照），浏览器打开即用。

## 功能特性（v0.3）

- **Agent 循环**：多轮工具调用、流式输出、运行中 steering 队列、随时中断；工具含 bash（支持 `run_in_background` 后台任务 + `task_output`/`task_stop`）、文件读写/编辑、glob/grep、read_artifact、load_skill、`spawn_task`（隔离上下文子代理）、`remember`（长期记忆）、`todo_write`（任务清单实时展示）、`web_fetch`/`web_search`（SSRF 防护、搜索 provider 可插拔），以及 MCP 注入工具
- **自定义子代理与斜杠命令**：项目 `.owc/agents/*.md` + 全局两级定义专职子代理（frontmatter 声明工具集与模型，`spawn_task agent=<name>` 调用）；`.owc/commands/*.md` 自定义斜杠命令模板（`$ARGUMENTS` / `$1..$9` 参数），与 Skills 同套触发方式
- **Plan/Build 双模式**：plan 模式在权限门禁层拦截全部写工具（含 MCP 工具），只读调研产出分步计划，切换 build 后执行
- **后台 bash 任务**：长命令后台运行不阻塞对话，完成自动通知下一轮；头部徽标查看运行中任务与输出、随时终止
- **Hooks**：`.owc/hooks.json` 声明 PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart 钩子（全局 + 项目两级，热读生效），shell 命令执行，PreToolUse exit 2 可否决工具调用（可信配置，安全级别等同 yolo）
- **模型接入**：Anthropic Messages 与 OpenAI 兼容双协议（DeepSeek/Qwen/Ollama 等），模型目录一键刷新、会话中热切换、思考程度开关；全部在设置页 UI 内配置（baseUrl / apiKey / 定价）
- **权限**：ask / acceptEdits / yolo 三级模式，「总是允许」生成持久规则（随会话保存）
- **沙盒**（默认开启）：Windows AppContainer（Job Object 兼容兜底，带内存/进程数限制）、Windows Sandbox（WSB，面向不可信代码）、Linux Landlock；能力探测如实上报（enforced/partial/advisory）
- **快照回滚**：每轮用户消息前自动检查点，时间线面板一键回滚（文件 + 会话历史同步截断）；后端自动探测 Btrfs/ZFS/ReFS，兜底 git 影子仓库；可选「托管工作区」——项目活在 VHDX/qcow2 稀疏镜像盘挂载点上，差分链快照毫秒级、可再分支
- **上下文管理**：token 预算账本、滚动驱逐 + 占位符回写、provider2 两种压缩（toolcalls/overview）、85% 水位强制概览压缩；`/clear` 清视图留历史（JSONL 全量保留）
- **长期记忆**：`remember(fact, scope)` 写项目 `.owc/memory.md` 或全局 memory.md，每轮注入系统提示；压缩时「关键发现/未决事项」自动沉淀
- **成本**：按会话/按日/按 provider 报表，缓存读写分项，双币种（USD/CNY）汇率折算，预算触发暂停
- **MCP + Skills**：stdio/HTTP 双传输 MCP 客户端（全局 + 项目级配置）；Skills 全局/项目两级，`/name` 手动触发
- **输入体验**：输入框 `@` 引用工作区文件（补全下拉 + 内容随消息注入，大文件截断落 artifact）；`!` shell 快捷前缀直接执行命令（走 bash 权限链），结果可一键发给 agent
- **Headless CLI**：`owc run "prompt" [--cwd --model --json --yolo --session]` 非交互执行，`--json` 输出 NDJSON 事件流，退出码区分完成 / agent 错误 / 权限拒绝——CI 与脚本集成入口
- **会话分享**：侧栏一键导出 `export.html` 自包含只读分享页（内联样式、零外部资源、全文转义）
- **其他**：多模态图片输入（粘贴/拖拽）、会话导出/导入（JSONL）、存储 GC、断线重连补拉

## 安装

### Windows（MSI）

从 Releases 下载 `openwebcode-<version>-windows-x64.msi` 双击安装（默认 `C:\Program Files\openwebcode`，需管理员权限）。装完运行安装目录下 `bin\owc.cmd`（或把 `bin` 加入 PATH 后任意终端 `owc`），浏览器打开 <http://127.0.0.1:3000>。卸载走「设置 → 应用」。

### Linux（tar.gz）

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh --prefix ~/.local    # 可选 --with-systemd 注册用户级服务
~/.local/bin/owc                  # 浏览器打开 http://127.0.0.1:3000
```

卸载：`rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc`（详见 `packaging/install.sh` 头部注释）。

## 使用

1. 启动 `owc` 后浏览器打开 <http://127.0.0.1:3000>；
2. **设置页**配置模型提供商（baseUrl、apiKey），点「刷新模型目录」拉取模型列表，可为每个模型补上下文窗口/定价/思考参数；
3. 侧栏 **+** 新建会话：选工作目录、provider/模型、沙盒模式（AppContainer / WSB / Job Object / 关闭）、工作区模式（直接 / 托管工作区）；
4. 输入框支持 `/技能名`、`/自定义命令`、`/compact`（概览压缩）、`/compact tools`（规则压缩）、`/clear`（清视图留历史）；`@` 引用文件、`!` 执行 shell；agent 运行中可追加 steering 消息或中断；
5. 右侧面板：文件树、上下文用量、时间线（检查点回滚）、沙盒状态；顶部可切权限模式、模型与 Plan/Build 模式。

## 从源码构建

- core：`cmake -S core -B build && cmake --build build`（测试：`ctest --test-dir build`）
- server：`cd server && npm ci && npm run build && npm test && npm start`
- web：`cd web && npm ci && npm run build && npm test`（产物由 server 静态托管）

布局与流水线细节见 `packaging/README.md`。

## 文档

- `docs/plan.md` — 架构总览、协议、沙盒/快照/上下文设计、实施阶段与当前状态
- `docs/protocol.md` — C ↔ Node JSON-RPC 协议规范
- `packaging/README.md` — 分发布局、安装脚本与 CI 发布流水线
- `docs/stage7-handoff.md` — 当前版本交付清单、验证状态与未真机验证项（历史：`docs/stage6-handoff.md`）
