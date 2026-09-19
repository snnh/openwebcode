# dsh 兼容模式

在 openwebcode 里加载 **dsh（DeepSeek Harness）官方 SPA 与插件**的兼容层。默认关闭，开启后在**独立端口**（默认 3211）托管 dsh 的 Web 界面，并把 owc 的会话/事件/审批投影成 dsh 的 wire 协议，让 dsh 生态的插件可以直接跑在 owc 上。

面向对象：想用 dsh 插件生态、或想在 dsh UI 里操作 owc 会话的人。日常使用 openwebcode 不需要打开它。

> 术语：**dsh** = DeepSeek Harness（上游 developer preview）；**vendor** = 随 owc 发布或本地抓取的 dsh 前端与插件产物。

---

## 目录

1. [开启方式](#开启方式)
2. [界面与入口](#界面与入口)
3. [安装 dsh 插件](#安装-dsh-插件)
4. [支持清单](#支持清单)
5. [不支持清单](#不支持清单)
6. [可信边界](#可信边界)
7. [ask 降级](#ask-降级)
8. [自选 UI 目录（不提供维护承诺）](#自选-ui-目录不提供维护承诺)
9. [故障排查](#故障排查)
10. [vendor 来源与许可](#vendor-来源与许可)

---

## 开启方式

**设置 → 通用**（热生效，无需重启）：

| 设置项 | 默认 | 说明 |
|---|---|---|
| **启用 dsh 兼容模式** `dshCompatEnabled` | 关 | 打开后按下面端口启动 dsh 端口服务；关闭时**进程内零常驻**——端口不监听、不加载 vendor、不建事件桥 |
| **dsh 兼容模式端口** `dshPort` | `3211` | 独立监听端口（1024–65535）；与主端口分离，避免 `/api`、`/plugins` 前缀冲突 |
| **自选 dsh UI 目录** `dshUiPath` | 空 | 空 = 用内置 vendor；填目录则用该目录下的 `manifest.json` + `static/` + `plugins/` |

环境变量同名可覆盖：`OWC_DSH_COMPAT_ENABLED`、`OWC_DSH_PORT`、`OWC_DSH_UI_PATH`。

开启后 dsh 端口只监听主服务**同一个 host**（`host` 设置），鉴权与主端口一致（访问令牌 cookie / `?token=` 换 cookie）。

### 没有 vendor 时

- **官方发布包与 Docker 镜像已内置 vendor**（发布流程会跑 `scripts/fetch-dsh-web.mjs`），开箱可用。
- **从源码跑**（`npm run dev` / 自建 dist）默认没有 vendor，需要先执行一次：

```sh
node scripts/fetch-dsh-web.mjs          # 产物写到 server/assets/dsh-web/（gitignored，不进仓库）
node scripts/fetch-dsh-web.mjs --help   # 看可用参数（版本钉版、输出目录、镜像源）
```

缺 vendor 时服务端**不会半启动**：端口不监听，stderr 记录一条原因（`[dsh] 未找到 dsh UI 产物（…）：先运行 node scripts/fetch-dsh-web.mjs 再打开该模式`）。

---

## 界面与入口

开启后，工作台左侧活动栏底部出现 **`layers` 图标**（悬浮提示「dsh 兼容模式（新标签打开）」），点击在新标签打开 dsh UI。

- dsh UI 与原工作台是**同一个服务、两个端口**，会话数据、模型配置、权限模式全部共用（不是第二套状态）。
- dsh UI 右下角有 **「返回 Workbench」悬浮入口**（由随 owc 发布的 `owc-dsh-bridge` 插件提供），回到主端口工作台；已带访问令牌 cookie 时回跳 URL 不带令牌参数。
- 两个端口共用同一张 HttpOnly 访问令牌 cookie，所以通常不需要重新登录；若直接手输 `http://<host>:3211/` 遇到 401，用 `http://<host>:3211/?token=<访问令牌>` 打开一次即可（与主 SPA 行为一致）。

---

## 安装 dsh 插件

dsh 插件就是普通 npm 包（与 dsh 上游经 `cordis.yml` 挂载的是同一份包）。owc 侧的约定：

```
<数据目录>/dsh-plugins/<包目录>/      # 插件本体（解开后的 npm 包，含 package.json）
<数据目录>/dsh.json                   # 每个插件的 enabled / config（可省：缺省 = 全部启用）
```

数据目录见 [使用帮助 § 配置文件位置](./usage.md#配置文件位置)（Linux 默认 `~/.local/share/openwebcode`，Windows 默认 `%USERPROFILE%\openwebcode`）。安装示例：

```sh
cd <数据目录>
mkdir -p dsh-plugins && cd dsh-plugins
npm pack <插件包名>              # 或 npm install <插件包名>，得到一个包目录
tar -xzf <插件包名>-<版本>.tgz   # 解开后把 package/ 改名成插件目录名
npm install --omit=dev           # 插件若有第三方依赖，装进它自己的目录（owc 不代装）
```

dsh 插件**只在「启用 dsh 兼容模式」打开时加载**（它们是可信代码，装了就生效不符合最小暴露原则）；加载计划在以下时机下发/重放：模式开关打开时、扩展宿主启动或崩溃重启后、插件启用态改变后。

生效时机：改完目录或 `dsh.json` 后**重启服务**，或者在设置里把「启用 dsh 兼容模式」关一下再开（触发一次加载计划重放）。插件在 Extension Host 子进程里激活，与 owc 官方扩展同一隔离层。

- **启用/停用**：改 `<数据目录>/dsh.json` 里该插件的 `enabled`（缺省 true，与 dsh「列出即挂载」语义一致）；停用会卸载插件并回滚它注册的工具。
- **配置**：`<数据目录>/dsh.json` 的 `config` 字段；校验与默认值由插件自己的 schemastery `Config` 完成。
- **工具**：插件注册的工具在 owc 侧显示为 `ext__dsh-<插件id>__<工具名>`，与 owc 官方扩展工具并列，走同一套权限与沙盒门禁。
- **钩子**：支持 `tools/pre-execute`（放行 / 拒绝 / 取消）与 `tools/post-execute`（改结果 / 否决）。
- **兼容探测**：翻译层只提供三个垫片包（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`）。插件运行期依赖其它 `@deepseek-ai/*` 包时判 **`incompatible`**（对应服务缝不存在，如实报错而不是静默错校验）；插件自己的第三方 npm 依赖走 Node 常规解析。
- **怎么知道插件到底有没有起来**：当前版本没有插件管理界面，以服务端日志为准（`[dsh]` 前缀，Extension Host 的 stderr 会转发到服务端）：激活失败、`missing-services`、`incompatible`、ask 降级审计都在这里出现。`<数据目录>/dsh.json` 是启用态的唯一事实来源。

---

## 支持清单

翻译层面向 dsh **0.1.6-alpha.2**（上游提交 `ddefc45fbc`）实现，按最小充分面裁剪：

| 已支持 | 说明 |
|---|---|
| 会话列表 / 新建 | `session/list`、`session/create`（按 id 幂等） |
| 打开会话与历史 | `session/follow`（快照 + 增量事件 + 助手流式）、`session/page`（向前翻旧历史） |
| 发消息 / 中断 / 队列 | `session/prompt`（`queue` / `steer`）、`session/cancel`、`session/updateQueue` |
| 运行态 | `session/control`（待发送队列、投影基线；后台任务见下） |
| 模型选择 | `session/modelCatalog`（服务商分组的模型目录 + 部署默认 + 可路由服务商）、`session/selectModel`（空闲时切模型，校验口径与主工作台一致：服务商须已配置、模型须在目录中、力度须在模型声明档位内）、会话 `modelSelection` 投影（composer 的模型座位显示当前会话模型） |
| 插件清单 | `pluginInventory/list`（只读投影 `<dataDir>/dsh-plugins` 里的 dsh 插件与启停状态；`managementAvailable=false`——插件安装/启停在 owc 侧管理） |
| 历史图片 | `session/attachment`（owc 内联 base64 图片可回读；仅落盘引用的图片返回明确错误） |
| 审批与提问 | `$events` 逻辑流 + `POST /api/$events/result` 回路：dsh UI 里点「允许/拒绝」会真正作用于 owc 权限链 |
| 工作区视图 | `workspace/follow`（按会话 cwd 派生工作区条目） |
| 逻辑流复用 | 单条 WebSocket `/api/remote.mux`（多路复用 `session/follow`、`session/control`、`$events`、`workspace/follow`） |
| 插件面 | `/plugins/<id>/client.js` 单文件与 combo 两种形态、`?rev=` 校验、按需分块回源；boot graph 由 vendor 清单生成 |
| 桥接插件 | `owc-dsh-bridge`：`/dsh-owc/status` 提供 owc 版本与 Workbench 回跳入口 |

---

## 不支持清单

以下 dsh 端点 v1 返回明确错误（不会静默给假数据），多数在 dsh UI 里表现为报错卡片或空面板：

- **设置与凭据面**：`settings/*`、`credentials/*`、`llm/*`、`agentPresets/*`
- **插件与文件面**：`pluginManager/*`（dsh 面板里的插件安装/启停管理）、`workspaceFiles/*`、`directoryPicker/*`、`fileReferences/*`
- **工作区写操作**：`workspace/create|rename|delete|insertBefore|insertSessionBefore|archiveSession|unarchiveSession`
- **会话扩展操作**：`session/search|rename|fork|openWorkspacePath|canOpenWorkspacePath`
- **其它**：`goal/*`、`skills/list`、`subagents/*`、`terminal/*`、`messageFeedback/*`、`sessionFeedback/record`、`dynamicCordisRunner/*`

**后台任务不投影**：`session/control` 的 jobs 字段如实留空（owc 的后台任务只在主工作台可见）。

需要凭据配置、权限模式、扩展设置、dsh 插件安装这些操作时，回主工作台做——dsh UI 的设置页不接 owc 的设置面。

**模型选择器**：dsh composer 的模型座位读 `session/modelCatalog` + 会话 `modelSelection` 投影；新建会话按主工作台同一套默认（`settings.defaultModel` + 校验过的 `defaultEffort`）落 provider/model，所以从 dsh UI 直接开新会话就能用。模型未配置 / 会话运行中切模型会给出明确 wire 错误，不静默改配置。

---

## 可信边界

- **dsh 插件（Host 与 Client 入口）是可信代码**，与「Hooks / 项目 MCP / v1 扩展」同档：**安装即信任（≈ yolo）**，不经沙盒、不经过权限确认链；插件注册的工具在**被 agent 调用汇总时**仍走 owc 的权限与沙盒门禁，但插件自身的代码（含读取文件、发起网络请求）不做拦截。只装你信任的插件。
- **dsh SPA 与 client 插件代码同为可信代码**，运行在你的浏览器里，与 owc 主 SPA 共享同一 host 的 cookie；它们**拿不到** owc 的 core 通道、数据目录路径与原始 API Key。
- **不进沙盒**：dsh 插件不是被沙盒包裹的第三方代码；界面上的隔离状态如实展示，不把「独立进程」宣传成沙盒。
- **模式关闭 = 零常驻**：`dshCompatEnabled=false` 时不监听端口、不加载 vendor、不建事件桥；模式本身出故障只降级（发布包缺 vendor、插件加载失败），不阻塞消息提交、会话加载与 Run 收尾。
- **性能**：开启后 agent 循环、账本、工具执行、快照、索引等敏感路径仍走 owc 自有实现，翻译层只做投影，不复制状态、不引入 dsh 运行时。

---

## ask 降级

dsh 的 `tools/pre-execute` 钩子可以返回 `ask`（要求向用户提问后再继续）。**v1 把 `ask` 降级为放行**，并写一条审计日志：

```
dsh tools/pre-execute ask 降级为放行：<reason>（tool=<工具名>, session=<会话 id>）
```

原因：owc 的审批链已经覆盖工具调用审批，若再叠一层 dsh 审批会重复提问、甚至在无 UI 的场景下死锁。`deny` 与 `cancel` 正常生效（分别拒绝、中止工具调用）。

---

## 自选 UI 目录（不提供维护承诺）

`dshUiPath` 允许指向你自己准备的 dsh UI 目录（结构：`manifest.json` + `static/` + `plugins/`），用来试更新的 dsh 版本或自行裁剪插件。

- **本项目只维护内置 vendor 的钉版兼容**；自选目录**不受本项目维护承诺**，仅按协议面「尽力兼容」。
- 版本漂移的典型症状：dsh UI 白屏或打开会话报错（wire 字段校验失败）、插件面板空白。遇到时先回退到内置 vendor（把设置清空）。
- 自选目录里的插件同样按[可信边界](#可信边界)对待。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 活动栏没有 `layers` 图标 | `dshCompatEnabled` 未开（或设置未加载完成）。去 设置 → 通用 打开；保存后无需刷新 |
| 图标在，但打开 `<host>:3211` 连不上 | 服务端没有 vendor（源码构建常见）：跑 `node scripts/fetch-dsh-web.mjs`；看 server stderr 的 `[dsh] 未找到 dsh UI 产物` 提示 |
| 打开端口报 401 | 用 `http://<host>:3211/?token=<访问令牌>` 打开一次换 cookie；令牌见 `<数据目录>/access-token` |
| 打开端口报 503 | 该请求到达时 `dshCompatEnabled` 为关。检查设置是否被环境变量覆盖（`OWC_DSH_COMPAT_ENABLED`） |
| 端口起不来 / 提示占用 | `dshPort` 与其它进程冲突，换端口（如 3212）后保存即热生效 |
| 插件注册的工具没出现 | 先确认「启用 dsh 兼容模式」是开的（关着就不下发加载计划）；再看 `<数据目录>/dsh.json` 是否把它 `enabled: false`；最后看服务端日志的 `[dsh]` 行 |
| 日志出现 `incompatible`（依赖 `@deepseek-ai/*`） | 插件依赖了三个垫片之外的 `@deepseek-ai/*` 运行期包（对应服务缝不存在），不会被加载。换插件版本或换插件 |
| 日志出现 `missing-services` | 插件声明的服务翻译层未提供，插件保持未激活（日志会列出缺失服务名） |
| 日志出现 `ask 降级为放行` | 这是设计内行为，见 [ask 降级](#ask-降级)；`deny` / `cancel` 仍正常生效 |
| dsh UI 里设置/凭据/终端页报错 | 见[不支持清单](#不支持清单)，这些面 v1 不接；回主工作台操作 |
| 非回环 host 上 dsh 端口不起来 | 服务端拿不到访问令牌时**拒绝**在非回环地址裸开该端口（避免免鉴权暴露），日志写 `未取得访问令牌（host=…，非回环）`。设 `OWC_ACCESS_TOKEN`（≥32 字符）或用默认回环监听 |
| dsh UI 白屏 | 多半是 vendor 与 dsh UI 版本不匹配（改过 `dshUiPath`）：清空该设置回内置 vendor；仍白屏则重跑 `node scripts/fetch-dsh-web.mjs` |
| 会话里消息重复/回退 | 记下时间与操作，附 server 日志的 `[dsh]` 行反馈；翻译层投影不是权威数据，`messages.jsonl` 始终是权威来源 |
| 「返回 Workbench」按钮没出现 | 桥接插件产物缺失（`server/assets/dsh-bridge/client.js`）或 `/dsh-owc/status` 请求失败；看浏览器控制台 `[owc-dsh-bridge]` 日志 |

---

## vendor 来源与许可

- **前端 dist**：npm `@deepseek-ai/dsh-web-frontend@0.1.6-alpha.2`（含 `index.html` + `assets/`）。
- **插件 bundle**：从 `@deepseek-ai/dsh-web-app@0.1.6-alpha.2` 出发按**依赖闭包**（`dependencies` + `peerDependencies`）取得候选，再按**官方挂载规则**筛选：`cordis.patch.yml` 名单里的插件，加上被其它插件 `inject`/`external` 引用的依赖行（如提供连接服务的 `dsh-api-gateway`）；只作为依赖存在、官方并未挂载的包会被跳过（例如 `dsh-client-ui-directory-picker-{browse,native}`——强行为插件会在 dsh 启动自检里 `failed` 并让整个 SPA 落到错误页）。当前产物 **58 个插件**，外加随 owc 发布的 `owc-dsh-bridge`。
- **版本钉死**：翻译层按 0.1.6-alpha.2 实现；dsh 升级后需要按 `docs/dsh-protocol-map.md` 的映射表复核（该表在 dsh 升级时先行更新）。
- **许可**：dsh 为 MIT。vendor 产物随发布包带 `server/assets/dsh-web/THIRD_PARTY_NOTICES.md` 与 `licenses/<包名>.txt`（各包原始 LICENSE）。
- **不进仓库**：`server/assets/dsh-web/` 是抓取产物（gitignored），由发布流程或你本地执行脚本生成。

> 相关内部文档（随版本归档）：`docs/dsh-protocol-map.md`（协议映射表）、`docs/dsh-wire-contract.md`（wire 字段契约）、`docs/dsh-compat-plan.md`（实施计划）。
