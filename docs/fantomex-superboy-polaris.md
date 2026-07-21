# OpenWebCode 路线图计划（12 项）

本计划覆盖用户列出的 12 项工作，按依赖与风险排序为 6 个阶段。每项标注涉及文件、改动要点与验证方式。所有改动遵循现有代码风格（server: TypeScript/ESM + vitest；core: C11 + ctest；web: React + 单文件 styles.css + 内联 `t(zh,en)` 本地化）。

## 当前执行状态（2026-07-21）

- 已完成：A1 图标、A2 AppContainer 允许目录与 ACL 快照还原、B1 移除 development provider、B2 模型能力（图片/视频输入 + `imageOutput`）、B3 远程模型/定价同步。
- 已完成：C1 Agent 提示词优化。
- 已完成：C2 第 4 个官方扩展——PDF 转图片与工作区上传（已完成跨会话、路径引用与上传安全审查修复）。
- 已完成：D1 Windows MSI 的图标、PATH、启动快捷方式与默认保留数据的显式清理配置；真实 WiX v3 MSI 编译/安装烟测待 CI 或具备 WiX 的隔离 Windows 环境执行。
- 已完成：D2 安装版/直接 Node 启动的数据目录说明统一，并修正 `server-settings.json` 位置与旧路径文案。
- 已完成：F1 Linux tar.gz 安装/健康检查发布门禁，及 Landlock `enforced` 时的实际越权写入拒绝测试。
- 已完成：F2 的用户级安装器核心与 TTY 交互配置；`--system`、`--with-desktop-entry` 和卸载器仍需单独设计。
- B2 约定：`video` 仅为输入模态；唯一输出字段为 `imageOutput`。不包含视频输出、视频生成或视频上传协议。

> 现状基线（来自代码探查）：
> - ACL grant/revoke 已实现（`core/src/platform/sandbox_win.c`），但只授权 cwd，且为「增删 ACE」式而非快照还原。
> - 图标资源完全缺失。MSI 由 CPack WIX 生成，无 PATH/快捷方式/卸载清数据配置。
> - 主提示词集中在 `server/src/agent/agent-runner.ts:418`（base + 各 section + 工具描述 36-160）。
> - PDF 无任何支持，无相关依赖。
> - "development" 供应商在 `server/src/providers/development-provider.ts`，被 `index.ts:64` 无条件注册，且是 `session-store.ts:35` 的默认 provider，约 30 处测试依赖。
> - 模型能力当前以输入模态 `ModelCapabilities.modalities` 表示，尚无图像输出方向标志。定价在 `server/src/cost/pricing-catalog.ts`。设置走 `settings-service.ts` 的 `FIELDS`/`effective()`。
> - 文档多处错写 `~/.openwebcode`，实际 Windows 默认是 `%LOCALAPPDATA%\openwebcode`。
> - Linux 由 CI 覆盖且通过；`packaging/install.sh` 已有带 TTY 防阻塞的交互配置、`--port`/`--data-dir`/`--host`/`--use-system-node`/`--yes` 与用户级 `--with-systemd`，系统级/桌面项仍待单独设计。

---

## 阶段 A — 核心 C 层（低风险、独立）

### A1. 图标（需求 1）
**设计概念**（来自用户手绘稿）：
- 外框：圆角矩形窗口/浏览器标签页样式，左上角一个标签凸起 + `+` 新建按钮，右上角 `— □ ×` 窗口控制按钮。
- 窗口标题栏/顶部区域：英文 "open" 四个字母变形——"o" 作为门框，"pen" 中的 "p" 竖画向下延伸成门铰链，整体呈现一扇半开的门的剪影。
- 窗口主体区域：代码编辑器界面（左侧行号列 + 右侧代码行），代码行的字母/色块排列拼出 "code" 四个字母（等宽字体风格）。
- 配色：使用应用强调色 teal（`--accent`）作为主色，背景用 panel 色，代码行用多色语法高亮色块。
- 风格：扁平 + 微圆角，适合 16×16 到 512×512 缩放。

**产出文件**：
- `assets/icon.svg`：源矢量文件（256×256 viewBox），手绘概念的精修矢量版本。
- `assets/icon.ico`：多尺寸 ICO（16/32/48/256），用于 Windows exe 资源 + MSI 图标。
- `assets/icon.png`：512×512 PNG，作为图标的位图衍生资产；Linux 桌面入口待 F2 后续范围实现。
- `web/public/favicon.svg`：简化版 SVG favicon（小尺寸可辨识）。

**转换工具**：Python + Pillow（隔离 venv 内安装，仅生成资产，不入运行时依赖）。从 SVG 用 `cairosvg` 或 `resvg` 渲染 PNG，再用 Pillow 打包 ICO。

**接线**：
- `web/index.html`：`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`。
- `core/CMakeLists.txt`：新增 `core/src/icon.rc`（`#include <winuser.h>` + `1 ICON "../../assets/icon.ico"`），Windows 下 `target_sources(owc-exec PRIVATE src/icon.rc)` 使 exe 带图标。
- CPack：`set(CPACK_WIX_PRODUCT_ICON "${CMAKE_SOURCE_DIR}/../assets/icon.ico")`。

**验证**：本地 `cmake --build` 看 exe 属性图标；浏览器打开看 favicon；MSI 安装后看"程序和功能"图标。

### A2. AppContainer ACL：可配置允许目录 + 快照式还原（需求 2）
- **可配置允许目录**：
  - `core/src/sandbox.h`：`owc_sandbox_options.write_roots` 已是数组，仅 `exec_win.c:89` 写死为单元素 `{cwd}`。
  - `core/src/rpc.c:169` `configure_policy`：新增解析 `sandbox.allowPaths`（与现有 `denyPaths` 并列，上限沿用 16）。
  - `core/src/platform/exec_win.c`：把 `cwd` + 配置的 allowPaths 合并进 `write_roots[]`（去重、规范化），传给 sandbox。
  - `server/src/settings-service.ts`/`config.ts`：新增 `sandbox.allowPaths` 设置项（数组型），下发到 `session.configure`。
- **快照式精确还原**（替代纯增删 ACE）：
  - 数据结构变更（`sandbox_win.c`）：
    ```c
    struct owc_acl_grant {
        wchar_t *path;
        PSECURITY_DESCRIPTOR original_sd;  // 新增：进入前完整安全描述符的深拷贝
        DWORD original_info;               // 新增：原始 SECURITY_INFORMATION 标志位
    };
    ```
  - `grant_one` 流程变更：
    1. 调用 `GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER|GROUP|DACL|SACL, ...)` 读取完整安全描述符。
    2. 用 `MakeSelfRelativeSD` 或手动 `LocalAlloc` + `CopySecurityDescriptor` 深拷贝一份保存为 `original_sd`。
    3. 再用 `SetEntriesInAclW` 追加 AppContainer ACE，`SetNamedSecurityInfoW` 写回。
    4. 记录 `original_info` 标志位（区分原本有无 DACL/SACL）。
  - `revoke_write_roots` 流程变更：
    1. 遍历 `grants[]`，对每个有 `original_sd` 的条目，调用 `SetNamedSecurityInfoW(path, SE_FILE_OBJECT, original_info, owner, group, dacl, sacl)` 直接覆写回原始安全描述符。
    2. `LocalFree(original_sd)`。
    3. 若某条目 `original_sd == NULL`（分配失败），退化为现有 `REVOKE_ACCESS` 逻辑做 best-effort。
  - 异常路径保障：`owc_sandbox_destroy` 在 cleanup 标签中**一定**被调用（现有代码已保证），还原逻辑在其中执行。即使进程 crash，下次启动时 AppContainer profile 已不存在（进程退出后 profile 被 `DeleteAppContainerProfile` 删除），残留 ACE 中引用的 SID 变为无效条目，不影响目录正常使用（Windows 对无效 SID 的 ACE 默认忽略）。额外保险：可在 `owc_sandbox_create` 时扫描上次残留的 grants 文件做清理（可选增强，非必须）。
- 验证：
  - 扩展 `core/tests/test_sandbox.c`：grant 前后用 `GetNamedSecurityInfoW` 对比 DACL，destroy 后确认 DACL 与原始字节一致。
  - 手动在 Windows 跑会话后用 `icacls` 检查目录 ACL 复原。
  - 测试 `allowPaths` 配置下发：`test_protocol.py` 新增用例，`session.configure` 带 `sandbox.allowPaths`，执行 `exec.run` 写入该路径成功。

---

## 阶段 B — Server 供应商与模型系统

### B1. 移除 development 供应商（需求 7）
- 删除 `server/src/providers/development-provider.ts`；移除 `index.ts:13,64` 的 import 与注册。
- **默认 provider 决策**（`session-store.ts:35-36`）：
  - 新增辅助函数 `resolveDefaultProvider(settings, providers)`：
    1. 若用户在创建会话时显式传了 `provider`/`model`，直接使用。
    2. 否则遍历 `providers.list()`，取第一个 `name !== "development"` 且凭据已配置的 provider（通过 `settings.effective()` 中对应 env key 非空判断）。
    3. 对应的 model：若该 provider 有 model registry 中的条目，取第一个；否则空字符串（后续由 UI 强制选择）。
    4. 若无任何可用 provider → 抛错 `{ code: "NO_PROVIDER", message: "请先在设置中配置至少一个 API 密钥" }`，`POST /api/sessions` 返回 400。
  - `NewSessionDialog.tsx`：当 providers 列表为空或均无凭据时，显示引导文案「请先在设置中配置 API 密钥」，禁用创建按钮。
- **测试迁移策略**（约 30 处）：
  - 创建 `server/test/helpers/stub-provider.ts`：导出 `makeStubProvider(name, handler?)` 工厂，返回 `{ name, async *streamChat(req) { yield* handler?.(req) ?? defaultEcho(req) } }`。
  - 凡 `register(new DevelopmentProvider())` 改为 `register(makeStubProvider("test-stub"))`。
  - 凡 `provider: "development"` 硬编码改为 `provider: "test-stub"`。
  - `multimodal.test.ts` 的 text-only profile 场景用 `makeStubProvider("text-stub", ...)` 替代。
  - `managed-disk.test.ts` 直接 import `DevelopmentProvider` 类 → 改为 import stub 工厂。
  - 断言语义不变：stub 的默认 echo 行为与 DevelopmentProvider 的 canned reply 对齐（返回固定文本 + 处理 `tool_result`）。
- UI 无需改（provider 列表动态来自 `/api/providers`，development 不注册则不出现）。
- 验证：`npm test`（server）全绿；手动创建会话验证无 development 选项。

### B2. 模型能力声明：图像输出标识 + 视频输入（需求 9）
- `model-profile.ts`：`ModelModality: "text"|"image"|"video"` 均作为输入侧声明；`ModelCapabilities` 增加图像输出方向标识：
  ```ts
  interface ModelCapabilities {
    modalities: ModelModality[];      // 输入侧文本/图像/视频
    imageOutput: boolean;             // 图像输出
    thinking: ThinkingMode[];
    effort: EffortLevel[];
    tools: boolean;
  }
  ```
  （图像、视频输入分别沿用 `modalities.includes("image")`、`modalities.includes("video")`；图像输出用 `imageOutput`。不增加视频输出字段或视频生成能力。）
- 联动更新：
  - `model-metadata.ts` `caps()` 默认值加 `imageOutput:false`，按需给特定前缀开启。
  - `app.ts:74-76,219-228` 校验白名单更新为 `MODEL_MODALITIES=["text","image","video"]`，manual 编辑校验接受新字段。
  - `web/src/lib/contracts.ts:136-141` 同步类型。
  - `web/src/components/SettingsDialog.tsx:638,674` 能力编辑表单保留视频输入选项并增加「图像输出」开关；模型卡片/选择器显示图像、视频输入及图像输出徽标（复用 `Icon.tsx`）。
  - 现有图像输入门控逻辑 `app.ts:784` 保持不变；视频输入在本项中保留为模型目录声明，暂不改变消息载荷协议。图像输出同样仅声明与展示。
- 验证：单测覆盖 `imageOutput` 序列化/校验；UI 编辑并保存后回显正确。

### B3. 从远程链接同步模型配置与定价（需求 8）
- **设置项**（`settings-service.ts` `FIELDS` + `config.ts`）：
  - `models.catalogSyncUrl`：类型 `string`，校验 `requireHttpUrl`，默认空（不同步）。
  - `models.pricingSyncUrl`：类型 `string`，校验 `requireHttpUrl`，默认空。
  - `models.syncIntervalMinutes`：类型 `number`，范围 `0–35791`，默认 `0`（仅手动同步且启动时不自动同步）；>0 时 `setInterval` 定时同步。上限保证换算为毫秒后不超过 Node.js timer 的 `0x7fffffff` 限制。
  - `effective()` 中映射到 `ServerConfig.models: { catalogSyncUrl?, pricingSyncUrl?, syncIntervalMinutes }`。
- **远程目录 JSON 契约**（`CatalogSyncDocument`）：
  ```ts
  interface CatalogSyncDocument {
    version: 1;
    updatedAt: string;       // ISO 8601
    models: Array<{
      id: string;
      provider: string;
      contextWindow?: number; // 缺省时回退内置元数据
      maxOutput?: number;     // 缺省时回退内置元数据
      displayName?: string;
      capabilities?: {
        modalities?: ("text"|"image"|"video")[];
        imageOutput?: boolean;
        thinking?: string[];
        effort?: string[];
        tools?: boolean;
      };
    }>;
  }
  ```
- **远程定价 JSON 契约**：复用现有 `PricingDocument` 结构（`version:1, updatedAt, entries[]`），即 `PricingCatalog.replace()` 直接接受。
- **目录同步实现**（`model-registry.ts` 新增方法）：
  ```ts
  async syncCatalogFromUrl(url: string, opts?: { fetchImpl?, timeoutMs? }): Promise<SyncResult>
  ```
  - `fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 15000) })`。
  - 解析 JSON → 校验 `version === 1`、ISO `updatedAt` 与非空数组。
  - 对每条 model 做 `lookupModelMetadata` 合并（远程 > builtin prefix > fallback）。
  - 原子写入 `<dataDir>/models.synced.json`（tmp+rename）。
  - 重新合并三方（builtin → synced → manual），广播 `models.updated`。
  - 返回 `{ ok: true, count, updatedAt }` 或 `{ ok: false, error }`。
- **定价同步实现**（`pricing-catalog.ts` 新增方法）：
  ```ts
  async syncFromUrl(url: string, opts?: { fetchImpl?, timeoutMs? }): Promise<SyncResult>
  ```
  - fetch → 解析 → `validateIntervals` → 原子 `replace(document)`；调用方在成功后广播 `model.pricing_updated`。
- **触发时机**：
  - 手动：`POST /api/models/refresh` 在 `catalogSyncUrl` 非空时调用 `syncCatalogFromUrl`；`POST /api/models/sync` 与 `POST /api/model-pricing/sync` 分别提供单独同步入口。
  - 定时：`syncIntervalMinutes > 0` 时启动时立即同步一次，并以 `setInterval(..., ms).unref()` 触发后续两个同步（各自 try/catch 独立失败）；`0` 不创建 timer，也不在启动时同步。
  - 设置变更：检测 URL 或 interval 变更 → 取消旧 interval → 建新 interval → 立即触发一次同步（包括切换到 `0`，以便确认用户刚保存的 URL）。
- **UI**（`SettingsDialog.tsx` models/pricing 区域）：
  - 两个 URL 输入框 + 间隔输入（通用 FieldSpec 自动渲染）。
  - 「立即同步」按钮 → 调 API → 显示结果（成功 N 条 / 失败原因）。
  - 最近同步时间显示（从 `models.synced.json` / `model-pricing.json` 的 `updatedAt` 读取）。
- **失败处理**：网络超时/非法 JSON/校验失败 → 不修改本地数据，返回结构化错误，UI 红字提示。
- 验证：单测用注入 `fetchImpl` 覆盖：成功同步、超时、非法 JSON、version 不匹配、区间冲突。

---

## 阶段 C — 提示词与 PDF 扩展

### C1. 优化提示词（需求 3，四方面）
目标文件 `server/src/agent/agent-runner.ts`（base prompt 418 + 工具描述 36-160 + section 构建）。
- **工具调用与任务完成质量**：强化「先探查再动手、并行只读调用、完成前自检（跑测试/验证）」的指引；明确何时该用 Read/Glob/Grep 而非 shell；减少无效重试。
- **更简洁、减少啰嗦**：要求简短状态说明（8-10 词）、不堆砌解释、不用占位符、交付完整改动。
- **添加中文提示词 表达/本地化**：在 `defaultLanguage` 基础上补充中文术语一致性与「用用户语言回复」的措辞（不改本地化机制本身，仅提示词）。
- **安全与权限边界措辞**：强化破坏性/不可逆操作需确认、不越权访问工作目录外文件、不擅自执行 git 变更等约束。
- 保持结构：仍为代码内拼装，不引入模板文件；改动控制在现有 section 框架内，逐段润色，不重写无关逻辑。
- 验证：`npm test`（涉及 prompt 快照的测试按需更新）；人工对比一次会话输出质量。

### C2. 第 4 个官方扩展：PDF 转图片（需求 4）

PDF 转图片作为官方扩展 `pdf-to-image` 实现，而不是永远启用的 Composer 内置行为。它与 context-manager、attention-optimizer、content-lens 并列为第 4 个官方扩展，可在“设置 → 扩展”中启停和配置。

- **官方扩展注册**（`server/src/extensions/official.ts`）：
  - `id: "pdf-to-image"`，默认启用；默认配置 `{ maxPages: 4, dpi: 150, maxDimension: 2048 }`。
  - 扩展状态通过现有 Extension Host / `extensions.json` 持久化；前端只在该扩展启用时加载 PDF.js 与执行转换。
  - Web 选择、粘贴或拖入 PDF 时，Composer 都先上传到当前会话工作区的 `.owc/uploads/`，取得服务端返回的真实工作区相对路径。扩展关闭时不转码，直接把该路径作为明确文本引用写入待发送消息，让模型按路径处理。
  - 每个异步上传/渲染任务绑定 `sessionId + generation`；切换会话时立即丢弃旧任务结果、重置 PDF 进度与队列，保证 A 会话的 PDF 绝不写入 B 会话的草稿或图片附件。
  - 扩展目录或模型图片能力仍在加载时不接受 PDF，以免把未知状态误判为“扩展关闭”或“不支持图片”。模型不支持图片、图片槽位耗尽或渲染失败时，同样回退为工作区路径引用，避免已上传文件对模型不可见。
- **依赖**：`web/package.json` 使用精确版本 `pdfjs-dist@4.10.38`（兼容项目 Node 20 下限）。Vite 通过 `pdf.worker.min.mjs?url` 延迟打包 worker，不依赖 CDN。
- **启用时的渲染管线**（新增 `web/src/lib/pdf-to-images.ts`）：
  ```ts
  interface PdfRenderOptions {
    maxPages?: number;       // 默认 10；Composer 传剩余图片槽位
    dpi?: number;            // 默认 150
    maxDimension?: number;   // 单页最长边默认 2048
  }
  async function renderPdfToImages(
    file: File,
    opts?: PdfRenderOptions,
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<{ images: PendingImage[]; totalPages: number; truncated: boolean }>;
  ```
  - 用 `getDocument({ data })` 加载，逐页渲染至离屏 canvas；输出 `image/png` base64 与可预览 data URL。
  - 页序串行以限制峰值内存；按 DPI 缩放后再限制最长边。
  - PNG 超过消息上限时最多重渲染 10 次并逐次降采样，避免高度不可压缩页面造成无界 UI 工作。
  - 无论成功或失败都释放 canvas、page、document 与 loading task；渲染错误向调用方返回可读失败。
- **Composer 集成**（`web/src/components/Composer.tsx`）：
  - `addFiles`、粘贴与拖放均接受 `application/pdf`（及 `.pdf` 后缀），并先调用 PDF 上传接口落盘到当前工作区。扩展启用时，PDF 转出的页面复用既有图片附件状态；关闭时直接插入服务端返回的路径引用，不调用 PDF.js。
  - 启用时仅在模型支持图片输入时转换；页数受扩展配置与剩余 `MAX_ATTACHMENTS`（4）共同限制。超过槽位时提示只转换前 N 页；不支持/耗尽/失败时改插入路径引用。
  - 转换过程中显示「正在转换 PDF 第 X/Y 页…」，并禁止发送以避免附件尚未写入时提交；损坏 PDF 或渲染错误只提示失败，不影响现有附件。
- **上传与消息传输边界**：保持 Fastify 全局 `1 MiB` 限制；仅 `POST /api/sessions/:id/messages` 和 `POST /api/sessions/:id/pdf-upload` 设为 `30 MiB`。浏览器与服务端共同限制原始 PDF 最多 20 MiB；接口只接受规范 base64、PDF header 与安全文件名。服务端验证后调用 core 私有 `fs.writeBase64`，由 core 以 `<safe-stem>-<UUID>.pdf` 写入 `<cwd>/.owc/uploads/`、返回相对路径；这消除了 Node 层的 `lstat → mkdir/writeFile` TOCTOU，且不把原始 PDF 写入消息载荷。上传名会消除 `@`，且 `extractAttachmentPaths` 把 `[PDF path: …]` 标记视为不透明文本，双重防止路径文字意外读取其他工作区文件。core/server RPC 帧上限相应为 32 MiB；消息路由的 30 MiB 覆盖最多 4 张、每张最多 7,000,000 个 base64 字符的图片及 JSON 包装余量；渲染页仍走既有图像能力门控和单图/数量校验。
- **审查遗留（Windows core）**：`fs_win.c` 现有实现仍在验证父目录句柄后关闭句柄、再按路径创建临时文件；恶意本地进程替换父目录为 reparse point 时理论上仍有极窄窗口。POSIX 已用 `openat/O_NOFOLLOW` 绑定目录。完全修复 Windows 侧需 handle-relative create/rename（例如原生 `NtCreateFile` 路径），属于后续核心平台加固，不能把本项表述为“所有平台 TOCTOU 已消除”。
- **验证**：
  - 扩展清单与设置页列出 4 个官方扩展；启停和配置重启后保持。
  - helper 单测 mock `pdfjs-dist`/canvas，覆盖页序、截断、缩放、进度、资源释放及错误。
  - Composer 单测 mock helper，覆盖 PDF 拖放/粘贴、槽位预算、转换中禁发、模型不支持与失败路径回退、扩展/模型状态加载，以及关闭扩展后的纯路径引用（不调用 helper）。
  - 回归用例覆盖 PDF 渲染中的 A→B 会话切换，断言 B 不显示 A 的附件且不被处理状态锁定。
  - 上传接口测试覆盖 PDF header/尺寸/路径净化、`@` 规范化、agent 运行中拒绝、core binary 写入参数、工作区 `.owc/uploads/` 写入和不影响消息接口的全局限额；core 协议测试覆盖严格 base64/binary 写入与 20 MiB 边界。
  - 服务端回归测试证明超过 `1 MiB` 的图片消息进入语义校验而非提前 413。
  - PDF.js 实际烟测：本地生成两页 PDF，`getDocument()` 确认页数与两个页面视图；当前环境没有可用的内置浏览器实例，因此未执行浏览器拖入的视觉烟测。

---

## 阶段 D — 打包与安装

### D1. MSI：PATH + 快捷方式 + 卸载清数据（需求 5）
**实现状态：已完成配置与静态生成验证；待有 WiX v3 的机器/CI 做真实 MSI 编译、安装、卸载冒烟。**

- `core/src/icon.rc` 已接入 `owc-exec`，`assets/icon.ico` 同时用于 exe 与 `CPACK_WIX_PRODUCT_ICON`。
- 真实 CPack 生成的 `files.wxs` 已核验启动器组件为 `CM_CP_bin.owc.cmd`；不手写无 Target 的 WiX `Shortcut`，而是使用 CPack 原生安装文件属性：

  ```cmake
  set(CPACK_WIX_PROGRAM_MENU_FOLDER "OpenWebCode")
  set_property(INSTALL "bin/owc.cmd" PROPERTY CPACK_START_MENU_SHORTCUTS "OpenWebCode")
  set_property(INSTALL "bin/owc.cmd" PROPERTY CPACK_DESKTOP_SHORTCUTS "OpenWebCode")
  ```

  生成的两个快捷方式都以 `[#CM_FP_bin.owc.cmd]` 为目标，而不是只提供 RPC 的 `owc-exec.exe`。
- 不使用不存在的 `CPACK_WIX_PROPERTY_ADD_TO_PATH`。`packaging/wix-patch.xml` 在 `CM_CP_bin.owc.cmd` 中注入 WiX `<Environment>`：`PATH=[INSTALL_ROOT]bin`、`Action=set`、`Part=last`、`Permanent=no`、`System=no`，即只更新安装用户的 PATH，并在卸载时移除对应项。
- 默认卸载严格保留数据。补丁声明 `PURGE_DATA=0`，并在 WiX v3 的既有 `WixRemoveFoldersEx` action 上注入条件：

  ```xml
  <Custom Action="WixRemoveFoldersEx">
    NOT UPGRADINGPRODUCTCODE AND PURGE_DATA=1 AND REMOVE="ALL"
  </Custom>
  ```

  `RemoveFolderEx` 只指向 `%LOCALAPPDATA%\openwebcode`；用户需显式运行 `msiexec /x package.msi PURGE_DATA=1` 才会清除默认数据。`OWC_DATA_DIR` 覆盖目录、任意工作区及其 `.owc/uploads/`（包括 PDF 原件）绝不在清理范围内，major upgrade 也不会清理。
- CMake 设置 `CPACK_WIX_PATCH_FILE`、`CPACK_WIX_CUSTOM_XMLNS` 与 `CPACK_WIX_EXTENSIONS=WixUtilExtension`。WiX v3 的 `RemoveFolderEx` 不支持 `Condition` 属性，条件必须写到既有 custom action 上；不要退回为 `cmd /c rmdir`。
- 不提供伪装成已实现的卸载 GUI 复选框。若未来必须提供，需要自定义 WiX UI/模板；当前以显式 MSI 属性为唯一 opt-in 接口。

**验证**：
- Visual Studio/MSVC Release `owc-exec`（含 `.rc`）构建通过；Debug CTest 4/4 通过。
- 隔离 CPack WXS probe 核对图标、`WixUtilExtension`、PATH、`RemoveFolderEx`、两种快捷方式及已核验组件 ID。
- 本机缺 `candle.exe`/`light.exe`，真实 `cpack -G WIX` 正确报缺 WiX，未伪造 MSI 成功。发布 CI 的 WiX v3.14 仍须作为真实编译门禁；后续应在隔离 Windows 环境验证 PATH、快捷方式、`PURGE_DATA=0/1` 与升级不清理。

### D2. 文档：Windows 默认目录修正（需求 6）
修正以下错误表述为 `%LOCALAPPDATA%\openwebcode`（即 `AppData\Local\openwebcode`），并区分「安装版」与「源码运行」：
- `README.md:104-109,142`
- `help/usage.md:120-127`
- `help/faq.md:21,169,193`
- `help/development.md:190,266,268-271`
- `server/src/settings-service.ts:174` 的 `defaultValue: "../.openwebcode"` 显示文案补充说明（安装版实际为 `%LOCALAPPDATA%\openwebcode`）。
- 统一说明优先级：`OWC_DATA_DIR` > 平台默认（Win `%LOCALAPPDATA%\openwebcode` / Linux `${XDG_DATA_HOME:-~/.local/share}/openwebcode`）> 源码兜底 `../.openwebcode`。
- 验证：grep 复查无残留错误路径；文档表述自洽。

---

## 阶段 E — UI 优化（需求 10，四方向）
目标 `web/src/styles.css`（设计 token + 组件样式）+ 相关组件。
- **视觉精致度**：统一间距/圆角/阴影层级，补充过渡动效（hover/focus/进入），优化卡片与面板质感。
- **信息密度与可读性**：调整布局密度、字体层级（标题/正文/辅助文本）、长内容（代码块、消息流）可读性。
- **主题与强调色完善**：核对 6 种强调色 × 明/暗共 12 组合的对比度与一致性，修补缺陷；确保 token 语义清晰。
- **交互可用性**：加载/空状态、操作反馈（Toast/按钮态）、响应式适配（窄屏布局）、可见焦点环与键盘可达性。
- 约束：仅改样式与少量组件标记，不动业务逻辑；保持单文件 styles.css 与现有 token 体系。
- 验证：`npm run build`（web）通过；本地启动目测各主题/布局；a11y 测试不回归。

---

## 阶段 F — Linux

### F1. 测试 Linux 版（需求 11）
- 现状 CI 已覆盖 core(gcc+clang)/server(ubuntu)/release tar.gz 且通过。补齐缺口：
  - 新增 **install.sh 冒烟测试**：在 `release.yml` 或新 workflow 中，解压 tar.gz → `./install.sh --yes --prefix <绝对临时目录>` → 启动 → `curl /api/health` 断言 200。
  - `core/tests`：增加 Landlock 实际隔离断言（在支持内核上验证越权路径被拒），不可用时优雅跳过。
- 验证：本地（若为 WSL/有 Linux 环境）跑通；否则依赖 CI 结果。

### F2. install.sh 增加配置项（需求 12，核心 CLI 已完成）
`packaging/install.sh` 现保持 POSIX sh 与幂等，并实现安全的用户级安装核心：
- [x] `--port <n>`：只接受 1–65535，写入启动器 `OWC_PORT` 默认值；运行时环境变量仍优先。
- [x] `--data-dir <绝对路径>`：写入 `OWC_DATA_DIR` 默认值，拒绝空值、根目录和控制字符。
- [x] `--host <addr>`：写入 `OWC_HOST` 默认值；非回环地址警告当前无内置 HTTP 鉴权，交互流程还会二次确认。
- [x] `--use-system-node`：不复制包内 `node/`，安装时验证 `PATH` 中的绝对 Node.js 可执行文件为 20+；包内 Node 缺失时自动转入同一安全路径。
- [x] `--yes` / `-y`：静默/非交互。仅当 stdin/stdout 都是 TTY 且未传该参数时，才询问未由 flags 指定的 prefix、port、data-dir、host、系统 Node 与用户级 systemd；flags 优先，非 TTY/CI 绝不读输入。
- [x] prefix 必须为绝对路径，并在 `mkdir -p` 后以 `cd -P && pwd` 物理规范化、再次拒绝 `/`，使启动器和覆盖边界不依赖调用 CWD 或 `/tmp/..`/符号链接写法。
- [x] 新增 `packaging/test-install.sh`，覆盖 `sh -n`、非 TTY 不提问、空格/单引号路径、运行时 env 覆盖、无包内 Node 的 `--use-system-node` 以及非法 prefix/port。
- [x] 更新 `README*`、`help/*`、`packaging/README*` 的安装说明。
- [ ] `--system`（`/opt` + 系统级 systemd）、对称 `uninstall.sh --purge` 与 `--with-desktop-entry` 仍未实现；脚本对 `--system` 和 `--with-desktop-entry` 显式报错，绝不伪装为已执行。它们需要 root/桌面环境范围与数据清理 UX 的单独设计后再做。

---

## 执行顺序与风险
1. **阶段 A**（图标 + ACL）：独立、低风险，先做。A2 涉及 C 层安全代码，需重点测试还原正确性。
2. **阶段 B**（供应商/模型）：B1 改动面广（测试多）但机械；B2/B3 中等。
3. **阶段 C**（提示词/PDF）：C1 纯文本低风险；C2 引入新前端依赖。
4. **阶段 D**（打包/文档）：D1 WiX 自定义较繁琐，需本地或 CI 验证 MSI。
5. **阶段 E**（UI）：纯前端，可独立推进。
6. **阶段 F**（Linux）：依赖阶段 A 图标（桌面项）与 D 文档。
