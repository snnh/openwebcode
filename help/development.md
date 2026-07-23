# 编译与二次开发

面向想从源码构建、调试或扩展 openwebcode 的开发者。用户侧使用见 [`usage.md`](./usage.md)。

## 仓库布局

```
openwebcode/
├── core/                 # C 执行器（owc-exec）：命令、文件、沙盒、快照后端
│   ├── CMakeLists.txt
│   ├── src/
│   │   ├── main.c        # stdio JSON-RPC 主循环
│   │   ├── rpc.c/.h      # Content-Length 分帧
│   │   ├── exec.c/.h     # 命令执行（超时、输出捕获、进程树 kill）
│   │   ├── fs.c/.h       # read/write/edit/glob/grep
│   │   ├── path_policy.c # 沙盒路径校验（denyPaths > writeRoots > readRoots）
│   │   └── platform/     # 平台代码分文件：exec_{posix,win}.c / fs_{posix,win}.c /
│   │                     #             path_{posix,win}.c / sandbox_{posix,win}.c
│   ├── tests/            # Python 脚本喂 RPC + C 单测（path-policy、sandbox-capability）
│   └── vendor/cJSON/     # 唯一第三方依赖（源码内置）
├── server/               # Node.js 服务层（TypeScript，ESM）
│   ├── src/
│   │   ├── index.ts      # 全局单例装配 + buildServer({...})
│   │   ├── app.ts        # Fastify HTTP/WS、REST 路由、buildServer(deps) 注入面
│   │   ├── core-client.ts# C 子进程管理 + RPC 客户端（崩溃自动重启）
│   │   ├── agent/        # agent loop、工具调度、权限、状态机、护栏、子代理、后台任务
│   │   ├── providers/    # anthropic / openai + 统一流式接口
│   │   ├── context/      # 账本、buildView、驱逐、artifact、压缩
│   │   ├── sessions/     # 多会话管理、JSONL 持久化
│   │   ├── cost/         # 定价目录、汇率、成本核算
│   │   ├── events/       # EventBus（EventEmitter 子类）
│   │   ├── snapshots/    # 快照后端探测链、git 影子、托管工作区
│   │   ├── sandbox/      # core-router 策略映射
│   │   ├── mcp/          # MCP 客户端（stdio + HTTP）
│   │   └── rpc/          # C RPC 类型定义
│   ├── test/             # vitest 测试（单元、HTTP、真实 core 端到端）
│   └── dist/             # 编译产物（ts 输出，git 跟踪）
├── web/                  # React + Vite 前端
│   ├── src/
│   │   ├── App.tsx       # 顶层组件、WS 事件流、状态管理
│   │   ├── components/   # Composer / ExecutionTrack / MessageCard / JobHeader 等
│   │   ├── lib/          # api.ts（REST 客户端）、contracts.ts（类型契约）
│   │   └── styles.css    # 全部样式
│   └── src/test/         # vitest + jsdom + Testing Library + axe
├── packaging/            # 分发布局、安装脚本、owc.cmd、CI 发布流水线
└── .github/workflows/    # core.yml / server.yml / web.yml（CI）+ release.yml（发布）
```

## 构建三件套

### 1. core（C 执行器）

依赖：CMake ≥ 3.16、C11 编译器（Windows MSVC / Linux gcc/clang）、Python 3（跑协议测试）。

```sh
cmake -S core -B build
cmake --build build --config Debug        # Windows 多配置用 --config，Linux 单配置可省
ctest --test-dir build -C Debug --output-on-failure
```

Windows MSVC 默认 `/W4 /WX`（警告即错误）。**C 源文件注释必须纯 ASCII**——GBK 代码页下 `/WX` 会把 C4819（非 ASCII 字符）当错误。

`core/vendor/cJSON/` 是唯一第三方依赖，源码内置，无需装库。

### 2. server（Node 服务层）

依赖：Node ≥ 20。

```sh
cd server
npm ci
npm run build       # tsc -p tsconfig.json，产物到 dist/（ESM）
npm test            # vitest run，运行完整测试套件
npm start           # node dist/index.js
npm run dev         # tsx watch src/index.ts，源码改动热重启
```

tsconfig 严格档：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。`dist/` 是 git 跟踪的编译产物，`npm run build` 后随源码一起提交（CRLF warning 正常）。

### 3. web（前端）

依赖：Node ≥ 20。

```sh
cd web
npm ci
npm run build       # tsc -b && vite build，产物到 dist/（不被 git 跟踪）
npm test            # vitest run + jsdom
npm run dev         # vite dev server，HMR
```

web/dist 不入库——由 server 静态托管（server 解析 `server/dist/../../web/dist`）。

对话渲染链位于 `components/Markdown.tsx`：`react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex`，代码块再交给 Shiki。KaTeX CSS 与字体由 Vite 打进 `web/dist/assets/`；部署时不能只复制入口 JS。

界面本地化位于 `web/src/i18n.tsx`。生产入口用 `I18nProvider` 包裹应用；组件通过 `useI18n()` 取得 `t(中文, English)`、当前语言和区域格式。新增用户可见文案必须同时提供中英文，不要按 DOM 文本做运行时替换。

## 本地开发循环

三种跑法，按需选：

### A. 全本地三件套联调

三个终端分别跑：

```sh
# 终端 1：core
cmake -S core -B build && cmake --build build
OWC_CORE_PATH=./build/owc-exec node server/dist/index.js        # Linux
# Windows: set OWC_CORE_PATH=build\Debug\owc-exec.exe && node server/dist/index.js

# 终端 2：server（热重启）
cd server && npm run dev

# 终端 3：web（HMR）
cd web && npm run dev    # Vite 默认 5173，proxy 到 server 3000
```

`OWC_CORE_PATH` 指向编译出的 owc-exec，否则 server 按源码树相对位置找（开发态通常能找到）。

### 数据目录解析

用户显式设置的 `OWC_DATA_DIR` 优先。未设置时，安装版启动器会注入平台默认值（Windows `%LOCALAPPDATA%\openwebcode`；Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才以相对 `server` 目录的 `../.openwebcode` 作为启动/设置目录兜底。设置文件固定在 `<启动/设置目录>/server-settings.json`；其已保存的 `dataDir` 会在未设置 `OWC_DATA_DIR` 时、下次启动后选择 `<业务数据目录>`，但不会移动设置文件。未保存覆盖时两者相同。为避免相对路径按 `server` 目录解析，建议两处都使用绝对路径；源码联调若想隔离数据，可显式设置 `OWC_DATA_DIR`。

### B. 测试用 provider（无需真实 LLM）

运行时不再内置模拟 provider。端到端和单元测试使用
`server/test/helpers/stub-provider.ts` 的 `makeStubProvider()` 注入一个确定性
provider；它支持 `run: <cmd>` 的工具调用回放与 `tool_result` 回包，因此测试无需
消耗 token，也不会把开发用途的 provider 暴露给实际用户。

本地联调请在设置页添加并启用 Anthropic Messages 或 OpenAI Chat Completions 服务商配置，并刷新模型目录后
创建会话。

### C. 真实 LLM + 本地三件套

设置页添加具名服务商配置（接口类型 + Base URL + API Key），启用后点「刷新模型目录」。正常会话流程即此路径。

## 测试约定

### server（vitest）

- 临时目录：`mkdtemp(os.tmpdir())` + 模块级 `roots[]` + `afterEach` 递归清理（防 Windows ENOTEMPTY 竞态）
- fake provider：参考 `test/shell.test.ts`、`test/memory.test.ts`——返回 `AsyncIterable<ProviderEvent>` 的最小实现
- HTTP 层：`buildServer(deps)` 注入 fake provider/core 后 `app.inject({...})`，不起真实端口
- 权限响应：`POST /permissions/respond` 必须先完成 HTTP 响应，再恢复挂起工具；测试需覆盖 allow / allow_always / deny 与响应后执行顺序
- 外部命令：`recordingRunner` / `tableRunner`（参考 `test/snapshot-backends.test.ts`）
- 异步落盘竞态：用 `vi.waitFor(() => expect(...), { timeout: 5000 })` 轮询，别在 `finally` 里直接 `app.close()` 配 `rm -rf`（Windows 会撞 ENOTEMPTY）

### web（vitest + jsdom）

- `@testing-library/react` + `axe-core`（a11y）
- 组件渲染用 jsdom，无真实 WebSocket——测事件处理走 mock event dispatch

### core（ctest）

- `test_protocol.py` / `test_fs.py`：Python 脚本喂 JSON-RPC 给编译出的 owc-exec，断言回包
- `test_path_policy.c` / `test_sandbox.c`：纯 C 单测

## 二次开发切入点

### 加一个内置工具

1. 在 `agent-runner.ts` 顶部工具 schema 常量区定义 `XXX_TOOL`（follow 现有 `TODO_WRITE_TOOL` 模式）
2. `executeTool()` 的 if 链加分支（或抽 `executeBash` 那样的私有方法）
3. 想自动放行：加到 `permission-coordinator.ts` 的只读白名单首行
4. 想进子代理只读集：加到 `sub-agent.ts` 的 `SUB_AGENT_TOOL_NAMES`
5. 想进 plan 模式白名单：加到 `agent-runner.ts` 的 `PLAN_READONLY`
6. web 端如要专门渲染：`MessageCard.tsx` 的 `ContentBlock` switch
7. 测试：端到端用 fake provider 回放工具调用 + 真实 `executeTool`，断言 tool_result

### 加一个 LLM provider

1. `server/src/providers/xxx.ts` 实现 `Provider` 接口（`name` + `async *streamChat(req): AsyncIterable<ProviderEvent>`）
2. `ProviderEvent` 类型见 `providers/provider.ts`：`text_delta` / `thinking_delta` / `tool_call` / `usage` / `done`
3. `index.ts` 装配：`providers.register(new XxxProvider(...))`
4. config 加配置项：参考 `config.ts` 现有 provider 结构 + `settings-service.ts` 的 `FIELDS` 声明式（group/label/env/validate/restartRequired）
5. 缓存断点：Anthropic 用显式 `cache_control`，OpenAI 系自动缓存——按你 provider 能力选
6. 测试：fake provider 参考现有点用例

### 加一个快照后端

1. `server/src/snapshots/` 下加后端实现，follow 现有 `git-shadow.ts` / `btrfs.ts` 模式
2. 探测链在 `snapshots/index.ts`（或探测入口），按能力自上而下尝试
3. RPC 方法走 core 侧 `snapshot.*`（如需 core 协助），以 `core/src/rpc.c` 和 `server/src/core-client.ts` 的当前实现为准
4. 测试：`test/snapshot-backends.test.ts` 用 `recordingRunner` / `tableRunner`

### 加一个 MCP 客户端传输

1. `server/src/mcp/` 现有 stdio + Streamable HTTP，加新传输 follow 同样抽象
2. 配置在 `<业务数据目录>/mcp.json` 或 `<cwd>/.owc/mcp.json`
3. 工具注入命名空间 `mcp__<server>__<tool>`，走与内置工具相同的权限链

### 改上下文策略

- 驱逐策略：`context/context-manager.ts` 的 `evictionPlan(ledger, strategy)` 纯账本运算
- 压缩：`fast-model.ts` + `context/compactor.ts`
- 新增占位/回写状态：改 `ContextLedger` 接口 + `normalizeLedger` 兼容 + `buildView` 渲染 + `replaceLedger` 回滚
- 前端始终用全量历史，驱逐只影响 LLM 视图——改策略不会破坏 UI

### 改 UI

- 状态：`App.tsx` 顶层 + `zustand` store（偏好/布局）
- 数据：`@tanstack/react-query`（`queryKeys` 集中定义）
- WS 事件流：`App.tsx` 的 onmessage 分发到 state + react-query invalidate
- 样式：单文件 `styles.css`，CSS 变量主题（亮/暗）
- 新组件：`components/` 下独立文件，follow 现有命名（`JobHeader.tsx` / `MessageCard.tsx`）
- Markdown/LaTeX：统一改 `Markdown.tsx`，不要在正文、历史思考、流式思考分别维护解析器；思考块只负责折叠与弱化视觉层级

## 架构要点（改动前必读）

- **C↔Node 通信**：子进程 + JSON-RPC 2.0 over stdio，`Content-Length: N\r\n\r\n{json}` 分帧（LSP 式）。传输层抽象在 `core-client.ts`，支持 TCP（为 WSB 模式铺路）；协议实现以 `core/src/rpc.c` 和 `server/src/core-client.ts` 为准。
- **Agent 循环在 Node 层**，C 只做执行器。状态机：`idle → thinking → (tool_calls? → waiting_permission → tool_running → thinking)* → idle`。
- **机制在核心，策略在扩展**：核心安全网（85% 水位、当前轮保护、账本一致性、沙盒路径校验）不可被绕过；扩展点（Skills/Commands/Hooks/自定义子代理/MCP）只加策略不绕机制。
- **权限与沙盒正交**：yolo 跳权限确认但不解除沙盒；`--no-sandbox` 才完全解除（不推荐）。
- **Hooks 安全级别等同 yolo**：`.owc/hooks.json` 里的 command 由 server 直接 spawn，不经沙盒与权限链。
- **界面取向：WebUI 为主，CLI 为辅，不引入 TUI**。所有交互界面只做在 `web/`（React + Vite 浏览器端）；`owc run` CLI 定位是非交互的自动化入口（`--json` NDJSON 事件流、CI/脚本集成），不做交互式终端界面。**禁止引入任何 TUI 方案**（ncurses / bubbletea / ratatui / blessed 等）——这是产品边界，不是技术取舍。新增「界面/交互」类需求时，默认落到 WebUI，只在脚本自动化场景才动 CLI。

## CI

四个工作流，都在 `.github/workflows/`：

| 工作流 | 触发 | 覆盖 |
|---|---|---|
| `core.yml` | 改 `core/**` | Linux gcc+clang / Windows MSVC：configure→build→ctest（C 单测 + Python 协议/fs 脚本） |
| `server.yml` | 改 `server/**` 或 `core/**` | Ubuntu + Windows：先构建 core Debug，再 `npm ci && npm run build && npm test`（含依赖真实 owc-exec 的 core-client / core-tcp / stage3-e2e / web-e2e——通过 `OWC_CORE_PATH` 注入路径） |
| `web.yml` | 改 `web/**` | Ubuntu：`npm ci && npm run build && npm test`（vitest + jsdom + Testing Library + axe） |
| `release.yml` | 打 `v*` tag 或手动触发 | 发布前先跑 server + web 全测试网关，再产 MSI / tar.gz |

关键点：

- 三件套各有独立 workflow，写哪个跑哪个——改 `web/` 不会触发 core 编译
- `server.yml` 和 `release.yml` 都构建 core Debug 给真实 owc-exec 测例使用；测例用 `OWC_CORE_PATH` 或 `skipIf(existsSync)` 兜底，缺二进制时跳过而非挂
- 所有 workflow 有 `concurrency`，同分支新推送取消旧运行
- npm 用 `setup-node` 的 cache，依赖 lockfile 路径
- `release.yml` 的测试网关在 `npm prune --omit=dev` 之前跑——staging 的 `node_modules/` 是 prune 后的生产依赖

## 发布

`release.yml` 在测试全绿后产两个分发物并上传到该 tag 的 GitHub Release：

| 产物 | 平台 | 内容 |
|---|---|---|
| `openwebcode-<version>-windows-x64.msi` | Windows | CPack/WiX 安装包 |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux | tar.gz + 顶层 `install.sh` |

- Windows：`npm ci/build`（server+web）→ CMake Release 构建 core → 按 `core/CMakeLists.txt` 末尾契约组装 `build/stage/` → `cpack -G WIX`
- Linux：同样构建后组装 `build/stage/` + 下载 Node 20 整树解入 `node/` → `tar` 打包
- bundled Node 版本固定在 workflow 的 `env.NODE_DIST_VERSION`，升级改这一个常量
- Linux 安装器的 portable 回归可在 checkout 中运行 `sh packaging/test-install.sh`；它覆盖非 TTY 不提问、带空格/单引号路径、`--use-system-node` 与严格参数校验。发布冒烟应使用 `./install.sh --yes --prefix <临时绝对路径>`，避免 CI 被交互式配置卡住。
- staging 契约细节见 `core/CMakeLists.txt` 末尾注释；从干净源码执行测试门禁、组装 staging、本地生成 MSI/tar.gz、冒烟与发布检查的逐步命令见 [`../packaging/README.md`](../packaging/README.md)
- 本地替换 staging 前端时应整体替换 `web/dist/` 并重启 server；若 UI 仍显示旧布局，用 `Ctrl+F5` 清掉旧入口缓存。只覆盖部分 assets 会留下入口与哈希文件不匹配的风险

## 提交与代码规范

- 提交信息中文，格式 `feat(scope): 标题` / `fix(scope): 标题`，正文列要点（参考 `git log --oneline`）
- 不主动 `git push` / `rebase` / `reset`，只顺序 commit
- `server/dist/` 是 git 跟踪产物，`npm run build` 后随源码提交
- `web/dist/` 不入库，由 server 静态托管
- `docs/` 仅在本地维护并由 `.gitignore` 排除，不提交到远端仓库
- `help/` 入库——用户文档与本文档随 git 同步
- C 源文件注释纯 ASCII（GBK 代码页 `/WX` 把 C4819 当错误）
- `server/assets/*.ps1` 必须 UTF-8 带 BOM
- TypeScript 严格档（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`），改完确保 `npm run build` 绿

## 调试技巧

- **看 core RPC 往来**：core 子进程的 stderr 由 server 捕获归档到 `<业务数据目录>/logs/`，限量轮转
- **看事件流**：WS `/api/events` 端点，浏览器 DevTools Network → WS 看每帧
- **看账本**：`<业务数据目录>/sessions/<id>/ledger.json`，每轮更新
- **看消息历史**：`<业务数据目录>/sessions/<id>/messages.jsonl`（每行一条）
- **看 artifacts**：`<业务数据目录>/sessions/<id>/artifacts/`
- **看子代理转录**：`<业务数据目录>/sessions/<id>/subagents/<taskId>.json`
- **强制单轮**：`maxTurnsPerMessage` 在 config 里可调，调试时设小
- **断 core**：杀 owc-exec 进程，观察 core-client 自动重启（指数退避 ≤3 次）与运行中工具标记失败
