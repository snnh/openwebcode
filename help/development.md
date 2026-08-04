# 编译与二次开发

面向想从源码构建、调试或扩展 openwebcode 的开发者。用户侧使用见 [`usage.md`](./usage.md)。

## 仓库布局

```
openwebcode/
├── core/                 # C 执行器（owc-exec）：命令、文件、沙盒、快照后端
│   ├── CMakeLists.txt
│   ├── src/
│   │   ├── main.c        # stdio JSON-RPC 主循环
│   │   ├── rpc.c/.h      # Content-Length 分帧、参数白名单、方法分发
│   │   ├── json.c/.h     # 手写 JSON 解析/序列化（无第三方依赖）
│   │   ├── exec.c/.h     # 命令执行（超时、输出捕获、进程树 kill、shell 后端）
│   │   ├── fs.c/.h       # read/write/edit/glob/grep/scan/watch/hash
│   │   ├── symbol_extract.c # index.extract job 的 9 语言行匹配符号提取
│   │   ├── path_policy.c # 沙盒路径校验（denyPaths > writeRoots > readRoots）
│   │   ├── pty.h         # PTY 抽象（pty.open/input/resize/close + 通知）
│   │   ├── bindlink.h    # Windows Bind Link API 抽象（运行时探测 dll）
│   │   ├── version.h.in  # 版本模板（configure_file 生成 version.h）
│   │   └── platform/     # 平台代码分文件：exec/fs/path/sandbox/pty/bindlink
│   │                     #   各分 {posix,win}.c
│   └── tests/            # Python 脚本喂 RPC（protocol/fs/abs_path/index_scan/
│                         #   index_extract/search_job/pty/bindlink）+ C 单测
│                         #   （path-policy、sandbox-capability）
├── server/               # Node.js 服务层（TypeScript，ESM）
│   ├── src/
│   │   ├── index.ts      # 全局单例装配 + buildServer({...})
│   │   ├── app.ts        # Fastify HTTP/WS、REST 路由、buildServer(deps) 注入面
│   │   ├── core-client.ts# C 子进程管理 + RPC 客户端（崩溃自动重启）
│   │   ├── agent/        # agent loop、工具调度、权限、状态机、护栏、子代理、后台任务、消息队列
│   │   │   ├── tool-schemas.ts # 内置工具 schema 单一来源（agent-runner 与 sub-agent 共用）
│   │   │   ├── shell-detect.ts # shell 探测/解析单一来源（pwsh/Git Bash/cmd/bash/$SHELL）
│   │   │   ├── persistent-shell.ts # agent bash 持久 shell（沙盒内 pty，cd/env 跨调用保持）
│   │   │   └── sub-agent.ts    # 内置类型注册表：explore（只读，缺省）/ general（可写，走权限链）
│   │   ├── providers/    # anthropic / openai-chat-completions / openai-responses + 统一流式接口
│   │   ├── context/      # 账本、buildView、驱逐、artifact、压缩
│   │   ├── sessions/     # 多会话管理、JSONL 持久化、session-tree.ts（activePathMessages 等树导航辅助）
│   │   ├── cost/         # 定价目录、汇率、成本核算
│   │   ├── events/       # EventBus（EventEmitter 子类）
│   │   ├── snapshots/    # 快照后端探测链、git 影子、托管工作区
│   │   ├── sandbox/      # core-router 策略映射
│   │   ├── mcp/          # MCP 客户端（stdio + HTTP）
│   │   ├── index/        # 符号提取、索引存储、code_search/repo_map 供数（0.4.0）
│   │   ├── diagnostics/  # test_runner 检测、四类生态解析器、DiagnosticSet（0.4.0）
│   │   ├── scm/          # git status/diff/commit 编排、worktree 生命周期（0.4.0）
│   │   ├── extensions/   # Extension Host 子进程、扩展 API、官方扩展（含 env-sim/：环境模拟，
│   │   │                 #   builtin-personas/preset-store/index）；config-schema.ts 做 configSchema 松散校验
│   │   ├── eval/         # owc-eval 评测服务（默认关闭）
│   │   ├── export-markdown.ts / export-html.ts # 会话导出（活动路径 Markdown / 自包含分享页）
│   │   ├── config/       # defaults.json：安装默认配置（随发布更新，构建进 dist/config/）
│   │   └── rpc/          # C RPC 类型定义
│   ├── test/             # vitest 测试（单元、HTTP、真实 core 端到端）
│   └── dist/             # 编译产物（ts 输出，不 git 跟踪；打包时整体进 staging）
├── web/                  # React + Vite 前端
│   ├── src/
│   │   ├── App.tsx       # 顶层组件、WS 事件流、状态管理
│   │   ├── workbench/    # 五区布局外壳、活动栏、布局持久化（0.4.0）
│   │   ├── commands/     # 命令注册表、keybindings 注册表与默认集、覆盖审计（0.4.0）
│   │   ├── components/   # Composer / ExecutionTrack / MessageCard / JobHeader /
│   │   │                 #   CommandPalette / QuickOpen / ShortcutsDialog /
│   │   │                 #   LiveActivity / SessionSkeleton / ConversationSearch 等
│   │   │   ├── editor/   # 只读 CodeView、Monaco 编辑器、DiffPane（0.5.0）
│   │   │   ├── panels/   # Context / Cost / Files / Problems / Sandbox / Scm / Timeline / Perf
│   │   │   └── settings/ # SettingsDialog 按页签拆成 16 个分区组件 + shared.ts，
│   │   │                 #   外壳只剩导航/脏状态/深链
│   │   ├── lib/          # api.ts（REST 客户端）、contracts.ts（类型契约）、recent-models.ts
│   │   │                 #   （输入框 Ctrl+P 模型循环）、perf-sampler.ts（帧率采样）
│   │   └── styles.css    # 全部样式（含窄窗口 ≤1024px 响应式）
│   └── src/test/         # vitest + jsdom + Testing Library + axe
├── packaging/            # 分发布局、安装脚本、owc.cmd、CI 发布流水线
├── scripts/bench/        # 性能基准体系（Node + Playwright）
│   ├── lib/common.mjs    # 共享工具：startBenchServer、writeResult、percentile
│   ├── generate-dataset.mjs # 确定性数据集生成（固定 seed）
│   ├── bench-*.mjs       # 各场景基准脚本
│   ├── browser/          # Playwright 浏览器渲染基准
│   ├── compare.mjs       # 结果对比（回归 >15% 标红）
│   └── results/          # 结果 JSON（gitignore）
└── .github/workflows/    # core.yml / server.yml / web.yml（CI）+ release.yml（发布 + 基准）
```

## 构建三件套

### 1. core（C 执行器）

依赖：CMake ≥ 3.19、C11 编译器（Windows MSVC / Linux gcc/clang）、Python 3（跑协议测试）。

```sh
cmake -S core -B build
cmake --build build --config Debug        # Windows 多配置用 --config，Linux 单配置可省
ctest --test-dir build -C Debug --output-on-failure
```

Windows MSVC 默认 `/W4 /WX`（警告即错误）。**C 源文件注释必须纯 ASCII**——GBK 代码页下 `/WX` 会把 C4819（非 ASCII 字符）当错误。

core 无第三方依赖：JSON 解析/序列化由 `core/src/json.c` 手写实现（递归下降解析器）。

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

tsconfig 严格档：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。`dist/` 不 git 跟踪（曾误入库，`.gitignore` 已排除）；发布打包时整体复制进 staging，`config/defaults.json` 随 `dist/config/` 一起分发。

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

三种运行方式，按需选择：

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

用户显式设置的 `OWC_DATA_DIR` 优先。未设置时，安装版启动器会注入平台默认值（Windows `%USERPROFILE%\openwebcode`；Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）；只有绕过启动器直接运行 `node server/dist/index.js` 时，才以相对 `server` 目录的 `../.openwebcode` 作为启动/设置目录兜底。设置文件固定在 `<启动/设置目录>/server-settings.json`；其已保存的 `dataDir` 会在未设置 `OWC_DATA_DIR` 时、下次启动后选择 `<业务数据目录>`，但不会移动设置文件。未保存覆盖时两者相同。默认配置随安装目录分发：`server/src/config/defaults.json`（构建进 `dist/config/`）是默认来源，`server-settings.json` 只存用户覆盖，生效值按 env > 用户覆盖 > 安装默认 > 代码兜底（`FIELDS.defaultValue`）组合，两处默认由 `test/defaults-sync.test.ts` 强制一致。为避免相对路径按 `server` 目录解析，建议两处都使用绝对路径；源码联调若想隔离数据，可显式设置 `OWC_DATA_DIR`。

### B. 测试用 provider（无需真实 LLM）

运行时不再内置模拟 provider。端到端和单元测试使用 `server/test/helpers/stub-provider.ts` 的 `makeStubProvider()` 注入一个确定性 provider；它支持 `run: <cmd>` 的工具调用回放与 `tool_result` 回包，因此测试无需消耗 token，也不会把开发用途的 provider 暴露给实际用户。

本地联调请在设置页添加并启用 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses 服务商配置，刷新模型目录后创建会话。

### C. 真实 LLM + 本地三件套

设置页添加具名服务商配置（接口类型 + Base URL + API Key），启用后点「刷新模型目录」。正常会话流程即此路径。

## 测试约定

### server（vitest）

- 临时目录：`mkdtemp(os.tmpdir())` + 模块级 `roots[]` + `afterEach` 递归清理（防 Windows ENOTEMPTY 竞态）
- fake provider：参考 `test/shell.test.ts`、`test/memory.test.ts`——返回 `AsyncIterable<ProviderEvent>` 的最小实现
- HTTP 层：`buildServer(deps)` 注入 fake provider/core 后 `app.inject({...})`，不起真实端口
- 权限响应：`POST /permissions/respond` 必须先完成 HTTP 响应，再恢复挂起工具；测试需覆盖 allow / allow_always / deny 与响应后执行顺序
- 外部命令：`recordingRunner` / `tableRunner`（参考 `test/snapshot-backends.test.ts`）
- 异步落盘竞态：用 `vi.waitFor(() => expect(...), { timeout: 5000 })` 轮询，不要在 `finally` 里直接 `app.close()` 配 `rm -rf`（Windows 会撞 ENOTEMPTY）

### web（vitest + jsdom）

- `@testing-library/react` + `axe-core`（a11y）
- 组件渲染用 jsdom，无真实 WebSocket——测事件处理走 mock event dispatch

### core（ctest）

- `test_protocol.py` / `test_fs.py` / `test_abs_path.py` / `test_index_scan.py` / `test_index_extract.py` / `test_search_job.py` / `test_pty.py` / `test_bindlink.py`：Python 脚本喂 JSON-RPC 给编译出的 owc-exec，断言回包
- `test_path_policy.c` / `test_sandbox.c`：纯 C 单测
- `repro_grep.py` / `stress_init.py` 是手动复现/压测脚本，不在 CTest 注册

## 二次开发切入点

### 加一个内置工具

1. 在 `agent/tool-schemas.ts` 定义 `XXX_TOOL`（内置工具 schema 的单一来源，agent-runner 与 sub-agent 共用），并在 `agent-runner.ts` 注册进 `builtInTools()` 与 `TOOL_EXECUTION_CLASS`
2. `executeTool()` 的 if 链加分支（或抽 `executeBash` 那样的私有方法）
3. 想自动放行：加到 `permission-coordinator.ts` 的只读白名单首行
4. 想进子代理：只读工具加到 `sub-agent.ts` 的 `SUB_AGENT_TOOL_NAMES`（explore/自定义类型）；可写通用集另见 `GENERAL_AGENT_TOOL_NAMES`（general 类型，工具经会话权限链执行）
5. 想进 plan 模式白名单：加到 `agent-runner.ts` 的 `PLAN_READONLY`
6. web 端如要专门渲染：`MessageCard.tsx` 的 `ContentBlock` switch
7. 测试：端到端用 fake provider 回放工具调用 + 真实 `executeTool`，断言 tool_result

### 加一个 LLM provider

1. `server/src/providers/xxx.ts` 实现 `Provider` 接口（`name` + `async *streamChat(req): AsyncIterable<ProviderEvent>`），参考 `anthropic-provider.ts` / `openai-compatible-provider.ts` / `openai-responses-provider.ts`
2. `ProviderEvent` 类型见 `providers/provider.ts`：`text_delta` / `thinking_delta` / `tool_call` / `usage` / `done`
3. 装配：`provider-profiles-runtime.ts` 按服务商配置的 `interfaceType` 实例化并 `providers.register(...)`；新接口类型同时加入 `provider-profiles.ts` 的 `ModelInterfaceType` 校验与设置页下拉
4. config 加配置项：参考 `config.ts` 现有 provider 结构 + `settings-service.ts` 的 `FIELDS` 声明式（group/label/env/validate/restartRequired）
5. 缓存断点：Anthropic 用显式 `cache_control`，OpenAI 系自动缓存——按你 provider 能力选
6. 测试：fake provider 参考现有点用例

### 按角色路由模型（model-roles）

四档角色 premium（极致）/ balanced（平衡）/ fast（快速）/ cheap（廉价）把「用途」映射到 `[provider, model]`：

1. 配置面：`settings-service.ts` 的 `modelSelection` 组——`defaultModel`（会话默认）、`roleModelPremium` / `roleModelBalanced` / `roleModelCheap`，快速档即既有 `fastModel` 键；编码、选项、校验、热生效全部复用 fastModel 模式
2. 解析面：`server/src/model-roles.ts` 的 `ModelRoleResolver`（index.ts 装配注入 AgentRunner）：`resolve(role)` 读当前映射；回落链 = 角色未配置 → balanced → 会话默认；provider 已注销按未配置处理
3. 消费面：子代理派发（`resolveSubAgent` + 三个 `runSubAgent` 调用点）按「frontmatter provider/model > frontmatter role > 调用参数 role > 会话默认」解析生效 provider/model；`spawn_task`/`spawn_swarm` 的 `role` 参数与自定义子代理 frontmatter 的 `role:`/`provider:` 都汇到这一条链；用量记账传生效 provider 名即可（`recordUsageEvent` 已参数化）
4. 加新角色档位：settings 加键 → resolver 加分支 → spawn schema 枚举与提示词目录段同步；`defaultModel` 只在会话创建（`resolveDefaultProvider`/`resolveDefaultModel`）消费
5. 测试模板：`server/test/model-roles.test.ts`（回落链）、`agents.test.ts` 的 frontmatter 断言、`spawn-task.test.ts` 的双 provider stub

### 加一个快照后端

1. `server/src/snapshots/` 下加后端实现，参照现有 `git-shadow.ts` / `btrfs.ts` 模式
2. 探测链在 `snapshots/index.ts`（或探测入口），按能力自上而下尝试
3. RPC 方法走 core 侧 `snapshot.*`（如需 core 协助），以 `core/src/rpc.c` 和 `server/src/core-client.ts` 的当前实现为准
4. 测试：`test/snapshot-backends.test.ts` 用 `recordingRunner` / `tableRunner`

### 加一个 MCP 客户端传输

1. `server/src/mcp/` 现有 stdio + Streamable HTTP，加新传输参照同样抽象
2. 配置在 `<业务数据目录>/mcp.json` 或 `<cwd>/.owc/mcp.json`
3. 工具注入命名空间 `mcp__<server>__<tool>`，走与内置工具相同的权限链

### 写一个扩展（扩展 API）

v1 扩展运行于独立 Extension Host 子进程（可信代码，安全级别 ≈ yolo），经 IPC 拿到注入的 `ctx`。manifest 声明权限，能力调用逐项校验，缺权限在 activate 时抛错并把扩展状态标为 error。官方扩展（env-sim/content-lens 等）使用的内部能力已对第三方开放：第三方可以做出与官方扩展同类的扩展。完整可运行示例见 `examples/extensions/demo/`。

**manifest 字段**：`id`（`[a-z0-9][a-z0-9-]{1,63}`）/ `name` / `version` / `description` / `apiVersion: "1"` / `permissions` / `entry`（缺省 `index.js`）必填；可选 `configSchema`、`routes`、`toolShaping`（后两个需对应权限，见下表）。

**权限语义表**：

| 权限 | 能力 |
|---|---|
| `tools:register` | `ctx.registerTool(...)`、`tool.beforeExecute` 钩子 |
| `sessions:read` | `ctx.sessions.*`、`ctx.events.subscribe(...)` |
| `context:read` / `context:mutate` | `ctx.context.*`；`context.beforeBuild` / `message.beforeSend` 钩子（两个都要） |
| `http:route` | manifest `routes` 声明 + `ctx.registerRoute(...)` |
| `model:fast` | `ctx.model.complete(...)` |
| `prompt:shape` | `prompt.beforeBuild` 钩子 |
| `tools:shaping` | manifest `toolShaping` 声明 |
| `ui:panel` / `ui:messageAttachment` / `network:fetch` | 已声明、机制规划中（目前无对应能力面） |

**能力一览**：

- **注册 agent 工具**（权限 `tools:register`）：`ctx.registerTool({ name, description, inputSchema }, handler)`；工具以 `ext__<扩展id>__<name>` 注入 agent（仅扩展启用时），与 `mcp__` 工具共用权限链（ask / yolo / allow_always）、plan 模式拦截与 `executionClass: "external"`；server→host `tool.invoke` 单次 5 秒超时。
- **只读会话**（权限 `sessions:read`）：`ctx.sessions.list()` 返回脱敏元信息（白名单字段，不含 sandbox/setupScript 等内部配置）；`ctx.sessions.get(id)` 附加完整消息历史。
- **只读上下文**（权限 `context:read`）：`ctx.context.getView(sessionId)`（buildView 结果）、`ctx.context.readArtifact(sessionId, artifactId, offset?, limit?)`。
- **订阅事件**（权限 `sessions:read`）：`ctx.events.subscribe(types, handler)`，类型白名单 `agent.state` / `tool.start` / `tool.end` / `context.*` / `checkpoint.*` / `subagent.*`，host 断线自动退订。
- **私有存储**（无需权限，1.1.0 起）：`ctx.storage.read(path)` / `write(path, content)` / `delete(path)` / `list(prefix?)`，映射 `<dataDir>/extensions-data/<扩展id>/` 下的相对路径。私有目录天然隔离所以不加 manifest 权限；路径禁绝对路径与 `..` 逃逸，配额单文件 ≤1 MiB、目录总量 ≤50 MiB（write 时统计）。content 为 UTF-8 字符串；read 未命中返回 `{ content: null }`。
- **私有 HTTP 路由**（权限 `http:route`，1.1.0 起）：manifest 声明 `routes: [{ method: "GET"|"POST"|"DELETE", path: "/..." }]`（path 以 `/` 开头、禁 `..`），activate 里 `ctx.registerRoute(method, path, handler)`（必须与声明对表）；server 把 `/api/ext/<扩展id><path>` 按路由表精确匹配后经 IPC（`http.request`，5 秒超时）转发 host，handler 收 `{ method, path, query, body? }`、返回 `{ status?, body? }` 原样响应。扩展未启用/未运行 → 503；路由未声明 → 404；host 超时 → 504。
- **快速模型通道**（权限 `model:fast`，1.1.0 起）：`ctx.model.complete({ prompt, maxTokens? })`，经 server 侧已配置的快速模型（FastModelClient）补全；强制上限 prompt ≤32 KiB、maxTokens ≤4096（缺省 1024），未配置快速模型时返回清晰错误。
- **提示词钩子** `prompt.beforeBuild`（0.9.0 起；1.1.0 起要求 `prompt:shape` 权限）：在系统提示词组装前回调，载荷 `{ sessionId, cwd, identity, basePrompt, productSections, extensionState? }`，可返回 `{ identity?, basePromptOverride?, productSections?, prependSections? }` 逐项覆盖；身份行、基线提示词均可替换，但安全约束段（SAFETY_BOUNDARY）始终由核心追加，扩展不可移除。文件级覆盖（`system-prompt.md`）先加载，钩子在其结果上再变换，钩子结果不跨 run 缓存。多个扩展按「官方优先」顺序链式应用。
- **工具塑形** `toolShaping`（0.9.0 起官方扩展；1.1.0 起第三方带 `tools:shaping` 权限可声明）：manifest 声明 `{ hideBuiltIns?: string[], aliases?: [{ from, as, description?, inputSchema?, argMap? }] }`，在 server 侧对每轮工具表做隐藏/重命名；别名工具保留原权限类别与 plan 门禁（不降级 external）。无权限的第三方 manifest 携带该字段直接拒绝。
- **会话级扩展状态**（1.1.0 起）：`SessionMeta.extensionState` 为 `Record<扩展id, JSON对象>`，经 `PUT /api/sessions/:id/config` 的 `extensionState` 字段打补丁（key 必须是已安装扩展 id，value 为对象整体替换或 null 清除），GET 会话详情透出；同时随 `prompt.beforeBuild` 载荷下发，扩展可读取自己的会话级配置（env-sim 的会话级 persona 即经此通道，旧 `persona` 字段保留兼容）。
- **配置表单** `configSchema`（0.9.0 起）：manifest 声明 JSON Schema 子集（type/properties/required/enum/default），设置页渲染 typed 表单（enum 下拉/数字/布尔），无 schema 回退原始 JSON 编辑；server 对配置更新做松散校验（类型/枚举/未知键）。

实现参考：`extensions/types.ts`（协议与权限）、`extension-host-process.ts`（ctx 注入与 `tool.invoke`/`http.request` 处理）、`extension-manager.ts`（工具注册表 / API 分发 / 存储与模型通道 / 路由转发 / transformPrompt / activeToolShaping）、`extensions/env-sim/`（官方预设与 persona 加载范例）、`agent-runner.ts` 的 `ext__` 分支（与 `mcp__` 共用 `executeExternalTool`）。测试样例：`server/test/extension-api.test.ts`、`server/test/extension-public-api.test.ts`、`server/test/env-sim.test.ts`。

### 改上下文策略

- 驱逐策略：`context/context-manager.ts` 的 `evict()`——按账本 policy（lag/interval/off + evictionMode 占位符/超级节省 + 豁免下限）计算可驱逐集，纯账本运算；超级节省的结构后处理在 `buildView` 返回前应用（不改缓存主本）
- 压缩：`fast-model.ts` + `context/compactor.ts`
- 新增占位/回写状态：改 `ContextLedger` 接口 + `normalizeLedger` 兼容 + `buildView` 渲染 + `replaceLedger` 回滚
- 前端始终用全量历史，驱逐只影响 LLM 视图——改策略不会破坏 UI

### 改 UI

- 状态：`App.tsx` 顶层组件状态（偏好/布局，localStorage 持久化）
- 数据：`@tanstack/react-query`（`queryKeys` 集中定义）
- WS 事件流：`App.tsx` 的 onmessage 分发到 state + react-query invalidate
- 样式：单文件 `styles.css`，CSS 变量主题（亮/暗）
- 新组件：`components/` 下独立文件，参照现有命名（`JobHeader.tsx` / `MessageCard.tsx`）
- 新命令/快捷键：在 `commands/builtin.ts` 注册命令（含 `when` 上下文），默认键位加到 `commands/keybindings.ts`；`command-coverage` 审计测试会校验每个 REST 动作都有对应命令
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
| `core.yml` | 改 `core/**` | Linux gcc+clang（x64 与 `ubuntu-24.04-arm` 两个架构）/ 龙芯 loongarch64 交叉编译（x64 runner，仅编译门禁）/ Windows MSVC：configure→build→ctest（C 单测 + Python 协议/fs 脚本） |
| `server.yml` | 改 `server/**` 或 `core/**` | Ubuntu + Windows：先构建 core Debug，再 `npm ci && npm run build && npm test`（含依赖真实 owc-exec 的 core-client / core-tcp / stage3-e2e / web-e2e——通过 `OWC_CORE_PATH` 注入路径） |
| `web.yml` | 改 `web/**` | Ubuntu：`npm ci && npm run build && npm test`（vitest + jsdom + Testing Library + axe） |
| `release.yml` | 打 `v*` tag 或手动触发 | 发布前先跑 server + web 全测试网关，再产 MSI / tar.gz；benchmark job（与 windows/linux 并行）跑全部 Node + Playwright 基准并归档结果，与上一 release 基线的对比仅产出警告（回归 >15% 或缺基线均不阻断发布；基准运行本身不完整仍失败）。手动触发可显式设置 `skip_performance_tests`，tag 发布不可跳过 |

关键点：

- 三件套各有独立 workflow，写哪个跑哪个——改 `web/` 不会触发 core 编译
- `server.yml` 和 `release.yml` 都构建 core Debug 给真实 owc-exec 测例使用；测例用 `OWC_CORE_PATH` 或 `skipIf(existsSync)` 兜底，缺二进制时跳过而非挂
- 所有 workflow 有 `concurrency`，同分支新推送取消旧运行
- npm 用 `setup-node` 的 cache，依赖 lockfile 路径
- `release.yml` 的测试网关在 `npm prune --omit=dev` 之前跑——staging 的 `node_modules/` 是 prune 后的生产依赖

## 发布

`release.yml` 在测试全绿后产以下分发物并上传到该 tag 的 GitHub Release：

| 产物 | 平台 | 内容 |
|---|---|---|
| `openwebcode-<version>-windows-x64.msi` | Windows | CPack/WiX 安装包 |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux x86_64 | tar.gz + 顶层 `install.sh` |
| `openwebcode-<version>-linux-arm64.tar.gz` | Linux aarch64 | 同上（`ubuntu-24.04-arm` 原生构建） |
| `openwebcode-<version>-linux-loongarch64.tar.gz` | Linux 龙芯 | 同上（x64 runner 交叉编译；不内置 Node.js，安装走 `--use-system-node`） |

- Windows：`npm ci/build`（server+web）→ CMake Release 构建 core → 按 `core/CMakeLists.txt` 末尾契约组装 `build/stage/` → `cpack -G WIX`
- Linux：按 `arch: [x64, arm64, loongarch64]` 矩阵出包——x64/arm64（`ubuntu-24.04-arm` 原生 runner）同样构建后组装 `build/stage/` + 下载固定版本 Node 24 整树解入 `node/` → `tar` 打包；loongarch64 在 x64 runner 用 `gcc-loongarch64-linux-gnu` 交叉编译（`core/toolchains/loongarch64-linux-gnu.cmake`），不跑 ctest/冒烟，不内置 `node/`（安装自动走 `--use-system-node`）
- bundled Node 版本固定在 workflow 的 `env.NODE_DIST_VERSION`，升级改这一个常量
- Linux 安装器的 portable 回归可在 checkout 中运行 `sh packaging/test-install.sh`；它覆盖非 TTY 不提问、带空格/单引号路径、`--use-system-node`、uid 分层默认（root 系统级路径）、systemd unit 生成（root/用户级分支）、`--lan` 快捷方式与访问链接打印、严格参数校验。发布冒烟应使用 `./install.sh --yes --prefix <临时绝对路径>`，避免 CI 被交互式配置卡住。
- staging 契约细节见 `core/CMakeLists.txt` 末尾注释；从干净源码执行测试门禁、组装 staging、本地生成 MSI/tar.gz、冒烟与发布检查的逐步命令见 [`../packaging/README.md`](../packaging/README.md)
- 本地替换 staging 前端时应整体替换 `web/dist/` 并重启 server；若 UI 仍显示旧布局，用 `Ctrl+F5` 清掉旧入口缓存。只覆盖部分 assets 会留下入口与哈希文件不匹配的风险

## 提交与代码规范

- 提交信息中文，格式 `feat(scope): 标题` / `fix(scope): 标题`，正文列要点（参考 `git log --oneline`）
- 不主动 `git push` / `rebase` / `reset`，只顺序 commit
- `server/dist/` 不 git 跟踪（曾误入库，`.gitignore` 已排除）；发布打包时整体复制进 staging
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
- **强制单轮**：`agentMaxTurns` 在设置页可调（或 `OWC_AGENT_MAX_TURNS`），调试时设小
- **断 core**：杀 owc-exec 进程，观察 core-client 自动重启（指数退避封顶 30s，持续重试）与运行中工具标记失败
