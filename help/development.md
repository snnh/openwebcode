# 编译与二次开发

面向想从源码构建、调试或扩展 openwebcode 的人。只是用的话看 [`usage.md`](./usage.md)。

## 仓库布局

三层各自独立构建，仓库根目录没有 `package.json`：

```
openwebcode/
├── core/              # C 执行器 owc-exec：命令执行、文件读写、路径策略、沙盒、快照原语、PTY
│   ├── src/
│   │   ├── main.c / rpc.c   # stdio JSON-RPC 主循环、Content-Length 分帧、参数白名单
│   │   ├── json.c           # 手写 JSON 解析/序列化，无第三方依赖
│   │   ├── exec.c / fs.c    # 命令执行、文件原语（read/write/edit/glob/grep/scan/watch/hash）
│   │   ├── path_policy.c    # 路径策略校验
│   │   └── platform/        # 平台代码分文件，各分 {posix,win}.c
│   └── tests/               # Python 脚本喂 RPC + 纯 C 单测
├── server/            # Node 服务层（TypeScript，ESM，Fastify，端口 3210）
│   ├── src/
│   │   ├── app.ts           # HTTP/WS、REST 路由、buildServer(deps) 注入面
│   │   ├── core-client.ts   # C 子进程管理 + RPC 客户端（崩溃自动重启）
│   │   ├── agent/           # agent 循环、工具调度、权限、子代理、后台任务
│   │   ├── providers/       # anthropic / openai-compatible / openai-responses
│   │   ├── context/         # 上下文账本、buildView、驱逐、压缩
│   │   ├── sessions/        # 多会话管理、JSONL 持久化、会话树
│   │   ├── snapshots/       # 快照后端探测链、托管工作区
│   │   ├── sandbox/         # core-router 策略映射、WSB、filtered 代理
│   │   ├── mcp/             # MCP 客户端（stdio + Streamable HTTP）
│   │   ├── extensions/      # Extension Host 子进程、扩展 API、官方扩展
│   │   └── index/ scm/ diagnostics/ cost/ events/ eval/
│   └── test/                # vitest：单元、HTTP 注入、真实 core 端到端
├── web/               # React 19 + Vite 6 前端
│   ├── src/
│   │   ├── app/             # 装配层：App 薄根组件、store（ui/session/live/prefs）、ws 事件客户端与路由、queries、commands（命令注册表/快捷键/覆盖审计）
│   │   ├── chat/ composer/  # 会话区（MessageList/scroll-controller/stream-buffer/卡片）与输入区
│   │   ├── workbench/ panels/ dialogs/ settings/  # 五区外壳、底部七面板、弹层、设置对话框与十七分区
│   │   ├── components/      # 设计基元（Icon/Overlay/ConfirmDialog 等）与保留件（Markdown/Monaco 编辑器）
│   │   ├── lib/             # api.ts REST 客户端、contracts.ts 类型契约
│   │   ├── i18n.tsx         # 中英双语
│   │   └── styles/          # 十一份样式表（tokens/base/layout/chat-*/composer/sidebar/panels/editor/dialogs/settings）
│   └── src/test/            # vitest + jsdom + Testing Library + axe
├── packaging/         # 分发布局、安装脚本、WiX 打包
├── scripts/bench/     # Node + Playwright 性能基准，回归 >15% 标红
├── examples/          # 示例资产（examples/extensions/demo/ 是完整第三方扩展示例）
└── .github/workflows/ # CI 与发布
```

各层 `src/` 下的详细文件清单看仓库根的 `AGENTS.md`（本地维护，不随 git 走），这里只给到能认路的粒度。

## 环境要求

- Node.js ≥ 20
- CMake ≥ 3.19、C11 编译器（Windows MSVC / Linux gcc 或 clang）
- Python 3（跑 core 协议测试）

## 构建与测试

### core（C 执行器）

```sh
cmake -S core -B build
cmake --build build --config Debug        # Windows 多配置要 --config，Linux 单配置可省
ctest --test-dir build -C Debug --output-on-failure
```

Windows MSVC 默认 `/W4 /WX`，POSIX 是 `-Wall -Wextra -Wpedantic -Werror`。**C 源文件注释必须纯 ASCII**——GBK 代码页下 `/WX` 会把 C4819（非 ASCII 字符）当错误。

### server（Node 服务层）

```sh
cd server
npm ci
npm run build     # tsc -p tsconfig.json -> dist/（ESM）
npm test          # vitest run
npm run dev       # tsx watch，源码改动热重启
npm start         # node dist/index.js
```

tsconfig 严格档：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`，改完保证 `npm run build` 绿。

### web（前端）

```sh
cd web
npm ci
npm run build     # tsc -b && vite build && scripts/check-bundle-size.mjs
npm test          # vitest + jsdom
npm run dev       # vite dev server，5173，/api proxy 到 server 3210
```

`web/dist/` 不入库，由 server 静态托管（解析 `server/dist/../../web/dist`）。本地替换过前端的话记得整体替换 `web/dist/` 并重启 server，浏览器还显示旧界面就 Ctrl+F5。

## 本地三件套联调

三个终端：

```sh
# 终端 1：构建 core
cmake -S core -B build && cmake --build build --config Debug

# 终端 2：server，OWC_CORE_PATH 指向刚编出的二进制
cd server && OWC_CORE_PATH=../build/owc-exec npm run dev        # Linux
# Windows: set OWC_CORE_PATH=..\build\Debug\owc-exec.exe && npm run dev

# 终端 3：web
cd web && npm run dev
```

浏览器开 5173，API 请求由 Vite proxy 转到 3210。不设 `OWC_CORE_PATH` 时 server 按源码树相对位置找，开发态通常也能找到。

第一次联调没有服务商配置：在设置页添加并启用一个服务商（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种接口），刷新模型目录后新建会话。

### 数据目录

显式 `OWC_DATA_DIR` 优先；其次是启动器注入的平台默认值（Windows `%USERPROFILE%\openwebcode`，Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；绕过启动器直接跑 `node server/dist/index.js` 时兜底为 `server` 旁边的 `.openwebcode`。设置文件固定在 `<启动目录>/server-settings.json`，生效值按 env > 用户覆盖 > 安装默认（`server/src/config/defaults.json`）> 代码兜底组合，`server/test/settings.test.ts` 强制两处默认一致。源码联调想隔离数据就显式设 `OWC_DATA_DIR`，用绝对路径。

## 测试约定

server（vitest，`testTimeout`/`hookTimeout` 均为 30s，Windows CI 资源紧张）：

- 临时目录用 `mkdtemp(os.tmpdir())` + `afterEach` 递归清理。异步落盘用 `vi.waitFor(() => expect(...), { timeout: 5000 })` 轮询，不要在 `finally` 里 `app.close()` 配 `rm -rf`——Windows 会撞 ENOTEMPTY。
- HTTP 层用 `buildServer(deps)` 注入 fake provider/core 再 `app.inject({...})`，不起真实端口。
- 不需要真实 LLM：`server/test/helpers/stub-provider.ts` 的 `makeStubProvider()` 做确定性工具调用回放，不消耗 token。
- 权限响应有顺序要求：`POST /permissions/respond` 先完成 HTTP 响应，再恢复挂起的工具。测试要覆盖 allow / allow_always / deny。
- 依赖真实 owc-exec 的测试用 `OWC_CORE_PATH` 注入路径，或 `skipIf(!existsSync)` 兜底——缺二进制时跳过，不要挂起。
- cron 测试给 `CronScheduler` 注入 `now()` 时钟 + `autoSchedule: false`，用 `check()` 手动 tick，不起真实 timer。
- 外部命令编排用 `recordingRunner` / `tableRunner`（参考 `server/test/snapshot-backends.test.ts`）。

web（vitest + jsdom）：`@testing-library/react` + `axe-core` 做 a11y，`asyncUtilTimeout` 放宽到 3s。没有真实 WebSocket，测事件处理走 mock event dispatch。

core（ctest）：`test_protocol.py` / `test_fs.py` / `test_abs_path.py` / `test_index_scan.py` / `test_index_extract.py` / `test_search_job.py` / `test_read_base64.py` / `test_pty.py` / `test_bindlink.py` / `test_overlay.py` / `test_bwrap.py` / `test_landlock_e2e.py` / `test_filtered.py` 是 Python 脚本喂 JSON-RPC 给编译出的 owc-exec 断言回包；`test_path_policy.c` / `test_sandbox.c` 是纯 C 单测。`repro_grep.py` / `stress_init.py` 是手动复现和压测脚本，不在 CTest 注册。

## 二次开发切入点

### 加一个内置工具

1. schema 写在 `server/src/agent/tool-schemas.ts`（内置工具 schema 的单一来源，主循环与子代理共用；简单工具是 `XXX_TOOL` 常量，需要上下文的像 `bashTool(...)` 是函数）。
2. `agent-runner.ts` 里把工具注册进 `builtInTools()` 和 `TOOL_EXECUTION_CLASS`，`executeTool()` 加执行分支。
3. 想自动放行（只读类）：加到 `permission-coordinator.ts` `needsApproval()` 首行的名单，并考虑 `tool-schemas.ts` 的 `READ_ONLY_TOOL_NAMES`。
4. 想给子代理用：只读工具进 `sub-agent.ts` 的 `SUB_AGENT_TOOL_NAMES`（explore 类型），可写通用集进 `GENERAL_AGENT_TOOL_NAMES`（general 类型，走会话权限链）。
5. 想在 plan 模式可用：加进 `agent-runner.ts` 的 `PLAN_READONLY`。
6. web 端要专门渲染的话改 `components/MessageCard.tsx` 的 `ContentBlock`。
7. 测试用 stub provider 回放工具调用 + 真实 `executeTool`，断言 tool_result。

### 加一个 LLM provider

1. `server/src/providers/` 下实现 `Provider` 接口（`name` + `streamChat(req): AsyncIterable<ProviderEvent>`），参照 `anthropic-provider.ts` / `openai-compatible-provider.ts` / `openai-responses-provider.ts`。事件类型见 `providers/provider.ts`：`text_delta` / `thinking_delta` / `tool_call` / `usage` / `done` 等。
2. 装配在 `provider-profiles-runtime.ts`：按服务商配置的 `interfaceType` 实例化并 `providers.register(...)`。新接口类型要同步加进 `provider-profiles.ts` 的 `ModelInterfaceType` 校验和设置页下拉。
3. 配置项走 `settings-service.ts` 的 `FIELDS` 声明式（group/label/env/validate/restartRequired）。
4. 测试参考现有 provider 的单测。

### 加一个快照后端

1. `server/src/snapshots/` 下加实现，参照 `btrfs.ts` / `zfs.ts` / `git-shadow.ts`，实现 `backend.ts` 的 `SnapshotBackend` 接口。
2. 探测链在 `snapshots/probe.ts` 的 `probeSnapshotBackend()`：Linux 依次试 btrfs → zfs → overlayfs → git shadow，Windows 试 ReFS → git shadow。任何一步失败静默回落，新后端按同样方式插进链里。
3. 需要 core 协助（新 RPC 方法）时走下面的六方同步流程。
4. 测试用 `recordingRunner` / `tableRunner` 注入探测命令的结果，参考 `server/test/snapshot-backends.test.ts`。

### 加一个 MCP 传输

`server/src/mcp/` 现有 stdio 和 Streamable HTTP 两种传输，加新的参照同一层抽象（`client.ts` / `manager.ts`）。配置来自 `<dataDir>/mcp.json` 和项目级 `<cwd>/.owc/mcp.json`。MCP 工具以 `mcp__<server>__<tool>` 命名空间注入，和内置工具走同一条权限链，不允许绕过。

### 改上下文策略

- 驱逐：`context/context-manager.ts`，按账本 policy（lag/interval/off + evictionMode + 豁免下限）算可驱逐集，纯账本运算；视图渲染在 `buildView` 返回前应用，不改缓存主本。
- 压缩：`fast-model.ts` + `context/compactor.ts` 两种策略；`extensions/compact-vault.ts` 是 compact-vault 官方扩展的 server 侧服务（归档完整上下文 + 快速模型整理 + 目录索引，host 侧 `extensions/compact-vault-host.ts` 提供 recall_memory 工具与索引回注）。
- 新增条目状态要动一串地方：`ContextLedger` 接口、`normalizeLedger` 兼容、`buildView` 渲染、`replaceLedger` 回滚。
- 前端始终拿全量历史，驱逐只影响发给 LLM 的视图——改策略不会破坏 UI。

### 改 UI

- UI 状态入 `src/app/` 下的自研 store（ui-store/session-store/live-store/prefs-store，useSyncExternalStore）；服务端数据走 `@tanstack/react-query`；WS 事件经 `app/ws.ts` + `app/event-router.ts` 集中路由。
- 样式在 `src/styles/` 十一份样式表（tokens/base/layout/chat-list/chat-cards/composer/sidebar/panels/editor/dialogs/settings），CSS 变量主题（亮/暗）。新组件按其域放 `chat/`、`composer/`、`workbench/`、`panels/`、`dialogs/`、`settings/`，基元放 `components/`。
- 新命令/快捷键：命令注册到 `app/commands.ts` 的 `registerBuiltinCommands`（含 `when` 上下文），默认键位加到 `DEFAULT_KEYBINDINGS`。`command-coverage.test.ts` 会校验每个 REST 动作都有对应命令。
- Markdown/LaTeX 渲染集中在 `components/Markdown.tsx`，不要为流式/历史/思考各维护一份解析器。
- 新增用户可见文案必须走 `useI18n()` 的 `t(中文, english)` 同时给中英文，不做运行时 DOM 文本替换。

### 写扩展

v1 扩展跑在独立的 Extension Host 子进程，经 IPC 拿到注入的 `ctx`，manifest 声明权限、能力调用逐项校验。能注册 agent 工具、读会话和上下文（含只读会话 `compact/` 归档的 `context.readVaultFile`）、订阅事件、私有存储、私有 HTTP 路由、快速模型通道、提示词钩子、工具塑形等。权限与能力的完整对照表看 `server/src/extensions/types.ts`，可运行的完整示例在 `examples/extensions/demo/`。扩展是可信代码（安全级别 ≈ yolo），只装自己信得过的。

manifest 可选声明 `configSchema`（JSON Schema 子集）：设置页据此把扩展配置渲染成类型化表单而不是原始 JSON 编辑，保存时 server 做松散校验（类型/枚举/未知键，只查顶层一层，`server/src/extensions/config-schema.ts`）。表单支持的属性形态（`web/src/settings/sections/ExtensionConfigForm.tsx` 的 `parseConfigSchema`）：`string`（可带 `enum` 渲染下拉）、`number`/`integer`（可带 `minimum`/`maximum`）、`boolean`、一层 `object` 嵌套组（带 `properties`）、字符串字典（`additionalProperties: { "type": "string" }`，按「键=值」行编辑）。每个属性应给 `title` 和 `description`，表单会展示为字段名与说明文字；未覆盖的既有配置键在保存时原样保留。官方扩展的英文字段文案映射在 `ExtensionsSection.tsx` 的 `OFFICIAL_FIELD_EN`。

## 架构边界（改动前必读）

这几条是硬约束，不是建议：

- **C↔Node 契约是 JSON-RPC 2.0 over stdio**，`Content-Length: N\r\n\r\n{json}` 分帧。WebUI、扩展和第三方代码不得直连 core 的 stdio/TCP/C ABI，一切经 `core-client.ts`。
- **改 core RPC 要六方同步**：`core/src/rpc.c` 参数白名单 → C 实现 → `server/src/core-client.ts` 类型/方法 → `docs/protocol.md` → 协议 fixture → CTest/Vitest。未知字段必须拒绝；`core.ping` 上报协议版本、capabilities 和 limits。
- **C 只是执行器**。不实现 HTTP/LLM 客户端，不碰 API Key、提示词、任意 URL。LLM、网络、凭据、策略全部留在 Node。
- **机制在核心，策略在扩展**。核心安全网（85% 上下文水位、当前轮保护、账本一致性、沙盒路径校验）不可绕过；Skills/Commands/Hooks/子代理/MCP/扩展只加策略。
- **权限与沙盒正交**。yolo 只跳过确认，不解除沙盒；`--no-sandbox` 才完全解除（不推荐）。Hooks 由 server 直接 spawn，安全级别等同 yolo，只能加载可信配置。
- **路径策略优先级固定**：`denyPaths > writeRoots > readRoots`。文件原语必须保持 root-bound + no-follow/reparse 防护。
- **无 TUI**。WebUI 是唯一交互界面，`owc run` CLI 只做非交互自动化（`--json` 出 NDJSON）。禁止引入 ncurses / bubbletea / ratatui / blessed 之类。

## CI

`.github/workflows/` 下五个工作流：

| 工作流 | 触发 | 干什么 |
|---|---|---|
| `core.yml` | 改 `core/**` | Linux gcc+clang（x64 + arm）/ loongarch64 交叉编译门禁 / Windows MSVC：configure → build → ctest |
| `server.yml` | 改 `server/**` 或 `core/**` | Ubuntu + Windows：先构建 core Debug，再 `npm ci && npm run build && npm test`（真实 owc-exec 端到端经 `OWC_CORE_PATH` 注入） |
| `web.yml` | 改 `web/**` | Ubuntu：`npm ci && npm run build && npm test` |
| `release.yml` | 打 `v*` tag 或手动 | 测试网关全绿后产 MSI / tar.gz 上传 Release，并跑性能基准归档 |
| `audit.yml` | 每周一定时 / 手动 | `npm audit --omit=dev --audit-level=high`，生产依赖有高危即失败 |

几点容易踩的：

- 三层各有独立 workflow，改 `web/` 不会触发 core 编译。
- core/server/web/audit 的 `concurrency` 是 `cancel-in-progress: true`（同分支新推送取消旧运行），`release.yml` 是 `false`——发布流程不可打断。
- Linux job 会装 bubblewrap 并放开 AppArmor 对 unprivileged userns 的限制（`sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`），否则 bwrap e2e 跑不起来。
- `release.yml` 的测试网关在 `npm prune --omit=dev` 之前跑，staging 里的 `node_modules/` 是 prune 后的生产依赖。
- 基准相对上一 release 的对比（回归 >15%）只警告不阻断，但基准脚本内置的绝对验收门禁失败会阻断发布——这是预期行为。

## 发布

`release.yml` 产四个包：`openwebcode-<version>-windows-x64.msi`（CPack/WiX）、`linux-x64.tar.gz`、`linux-arm64.tar.gz`（`ubuntu-24.04-arm` 原生构建）、`linux-loongarch64.tar.gz`（x64 runner 交叉编译，不跑测试、不内置 Node.js，安装走 `--use-system-node`）。捆绑的 Node 版本固定在 workflow 的 `env.NODE_DIST_VERSION`（当前 24.18.0），升级改这一个常量。

版本号机制：tag 完整版本号进 `CPACK_FULL_VERSION`（文件名），数值基版本进 `CPACK_PACKAGE_VERSION`（MSI ProductVersion 只收数值）；`server/package.json` 存完整版本号，`web/package.json` 跟随，`core/CMakeLists.txt` 的 `project(VERSION)` 存数值基版本，release.yml 校验四方一致。Release 说明从 `CHANGELOG.md` 提取对应版本段落，缺失则阻断发布。

staging 契约见 `core/CMakeLists.txt` 末尾注释；从干净源码到本地出包、冒烟的逐步命令见 [`../packaging/README.md`](../packaging/README.md)。

## 提交规范

- 提交信息中文，格式 `feat(scope): 标题` / `fix(scope): 标题`，正文列要点（参考 `git log --oneline`）。
- 不主动 `git push` / `rebase` / `reset`，只顺序 commit。
- `server/dist/`、`web/dist/` 不入库；`docs/` 和 `AGENTS.md` 仅本地维护（gitignored）；`help/` 入库，随 git 同步。
- `server/assets/*.ps1` 必须 UTF-8 带 BOM。

## 调试技巧

- core RPC 往来：server 把 core 的 stderr 归档到 `<数据目录>/logs/core.log`（5MB 轮转一代）。
- 事件流：WS `/api/events`，浏览器 DevTools → Network → WS 逐帧看。
- 上下文账本：`<数据目录>/sessions/<id>/ledger.json`；消息历史是同目录 `messages.jsonl`；子代理转录在 `subagents/<taskId>.json`。
- 单轮调试：把 `agentMaxTurns`（设置页，或 env `OWC_AGENT_MAX_TURNS`）调小。
- 断 core：杀掉 owc-exec 进程，观察 core-client 自动重启（指数退避封顶 30s，持续重试不放弃）和运行中工具标记失败。
