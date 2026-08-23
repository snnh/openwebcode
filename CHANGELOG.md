# 更新日志

本文记录 OpenWebCode 从首次公开版本 `v0.1.0` 到当前版本的用户可感知变化。日期以 Git 标签发布日期为准。

## [1.9.7] - 2026-08-22

### 修复

- **OpenAI Responses 回放与流式收尾加固**：
  - 工具调用聚合改用稳定键（端点未携带 item_id 时按输出槽位索引聚合）：同一工具调用的多次增量不再被拆成多条 `tool_call`（旧实现按调用计数派生键，随增量变化而错位）。
  - 流结束未收到 `completed`/`incomplete` 终态但已有文本产出时按正常结束处理：只发 `[DONE]` 的兼容端点不再被误判为错误并触发重试/报错。
  - 会话格式升级与消息追加串行化：升级执行期间会话若有消息写入，排队而非整表覆盖（此前并发下升级可能覆盖运行中追加的消息）。
  - 流内失败按错误码**前缀**判定可重试：`rate_limit_exceeded` 等变体码与 `server_error`/`overloaded` 前缀码均正确走重试（此前精确匹配把这些高频码判为不可重试）。
  - `output_item.done` 权威文本与流式累积不一致时不再重发完整文本：端点重复下发增量导致流式文本重复错乱的问题消除，收尾统一以权威文本为准。
- **思考开关语义修正（effort_only 模型）**：官方 OpenAI gpt/o 系等 `thinkingStyle=effort_only` 模型，思考开关只表达启用/关闭——开启即下发默认强度档（取模型声明档位的中位值，未声明时取五档兜底中位），不再发送语义相左的 `thinking:"enabled"`；选择具体强度档同样只带 effort 参数。

### 优化

- **升级备份保留最近 3 份**：会话格式升级产生的 `messages.jsonl.upgrade-*` 备份不再无限占用磁盘（回滚只需最近一份），清理失败不阻断升级。
- 回放签名派生助手统一（rs_/msg_ 同一实现）、`function_call` 派生 id 空尾兜底、诊断留痕按 provider 键控（多模型目录下不再漏报/串报）。
- 测试侧：模型目录具体窗口值改为区间与行为断言、min tokens 与重试次数引实现常量、重复用例逐条核查（均保留——覆盖点不同）。

## [1.9.8] - 2026-08-23

### 新增功能

- **任务清单移入会话标签栏右端**：会话主区标签栏（主对话/终端/子代理）右端新增「任务清单 · x/y」折叠 chip——默认折叠、点击展开下拉清单（完成项划线、进行中高亮），不再嵌入消息流顶部占位；任务清单随 run 结束**保留**（下一轮任务开始时整组替换），停止回复后仍可随时查看。

### 优化

- **窄屏（≤768px）会话头行距收紧**：第二行（cwd/状态/展开钮）上移 10px，行1 44px 触达盒与桌面端布局不变。

## [1.9.6] - 2026-08-22

### 修复

- **DeepSeek Responses 并行工具调用回放 400 问题解决**（`reasoning_text must be passed back`）：同一 assistant 轮内并行多个 `function_call` 时，回放按 `fc1,fco1,fc2,fco2` 逐对排列发送，DeepSeek 服务端按「归并到相邻 assistant 消息」解析输入，会把逐对排列拆成多条**虚拟 assistant 轮**，第二条起没有归属的 reasoning item → 立即 400。现改为**并行 `function_call` 全前置**（`fc…fc → fco…fco`），服务端正确归并为一条轮次，与单条 reasoning 配对。真机验证：失败会话（clear 后多轮并行工具）原布局 400、全前置布局 200；单工具轮两种排列等价不受影响。
- **思考强度滑块按模型声明显示，未声明不默认声明 ultra**：模型未声明 `effort` 子集时滑块兜底档位由「低/中/高/极高/max/ultra」六档改为「低/中/高/极高/max」五档（`ultra` 仅当模型目录显式声明后出现，如 glm-5 系）；仅声明思考开关而未声明强度（如 deepseek-reasoner）的模型不再显示强度滑块——所有模型按「声明什么显示什么」呈现，不再用默认集冒充声明。

### 新增功能

- **模型能力体系引入思考方式（thinkingStyle）与视觉/窗口元数据**：新增 `thinkingStyle` 能力声明（thinking / enable_thinking / effort_only / fixed / extended / adaptive），按模型族设内置默认（deepseek/glm/kimi-k2.6=thinking、qwen=enable_thinking、kimi-k3/gpt/o 系=effort_only、kimi-for-coding/glm-5.3=fixed、claude 4.5 及以前=extended、4.6+/国产=adaptive），agent 主循环/子代理/chat 模式按此分发各端点思考参数 key；模型名含 vision/`-vl-` 等标记默认声明图片输入能力（用户目录显式声明仍优先）；更新内置元数据（deepseek 1M、glm-5.x 1M 含 `[1m]` 后缀与 ultra 档、kimi-k3 1M、gemini 1M 多模态等）。推理参数（thinking/effort）改为**用户优先、不设限透传**，仅做全局枚举校验，不再按模型能力白名单过滤。

### 优化

- **官方扩展会话格式升级（session-format-upgrade）v0.1.0 → v0.1.1**：描述同步当前行为——并行工具调用回放修复在 provider 层直接生效，旧会话无需升级即可续跑；扩展仅用于为严格端点补齐回放字段（thinking signature / tool_call itemId / textSignature）。
- **文案「缺省」统一为「默认」**：web 端界面文案与代码注释中的「缺省」全部改为「默认」，统一术语。

## [1.9.5] - 2026-08-21

### 修复

- **模型能力以用户声明优先，不再被内置兜底覆盖**：模型目录存在同 id、多 provider 条目时（如同一模型同时被聚合网关与官方端点拉取），能力判定此前按目录合并顺序取最先出现的自动拉取条目，其保守兜底能力（无图像输入）会盖过用户在模型目录里显式声明的能力。现按声明优先级解析：**用户手动声明（manual）> 远程同步（synced）> 自动拉取（api）> 内置元数据**；`list()` 展示层不变（不同 provider 的同 id 条目仍全部列出）。
- **上传图片门禁按会话 provider 精确判定**：会话带图消息的能力检查改用 `get(model, provider)`，与前端模型选择口径一致；此前无 provider 查询可能命中其他 provider 的同 id 条目，误报「模型 X 不支持图片输入」。
- **扩展宿主 `models.getCapabilities` 同步修复**：vision-tools 等扩展查询主模型视觉能力时改经模型注册表解析（未命中回落静态元数据），不再因内置兜底误判主模型不支持视觉而降级图片为文字描述。

## [1.9.4] - 2026-08-21

### 修复

- **DeepSeek Responses 思维链回放 400 问题解决**（`reasoning_text must be passed back`）：官方规则要求带 `tools` 的请求中历史 `reasoning_text` 必须完整回传，且 reasoning item 须置于其归属的 assistant 消息**之前**（plain-text content 合并进相邻 assistant 消息）。此前「文本先行、reasoning 逐 function_call 前置」的布局全部错位，端点立即 400。现按规范序回放：逐 thinking 块合并 reasoning_text → 完整 message item（`textSignature` 还原 id/phase）→ 逐 function_call + output；多工具调用轮不再逐调用重复 reasoning；缺同源 thinking 素材的轮不再补占位（真机验证均不需要）；仅当输入最后一条是 assistant 消息且无任何 thinking 素材时补诚实占位（该场景端点直接 400）。

### 新增功能

- **服务端联网搜索回放（web_search_call）**：模型服务端执行搜索（`web_search` 工具）的完整 item（id/status/action）随 assistant 消息持久化，回放时按官方文档「Pass back as-is」原样回传，服务端自动恢复搜索结果；UI 以「联网搜索」标签展示。此前搜索过程仅实时展示、不落盘，多轮续跑时搜索结果上下文丢失。

### 优化

- **模型元数据**：`responsesEncryptedReplay`（加密思维链回放）默认关闭——此前 gpt/o 系内置条目默认开启，现改为默认 false（官方 OpenAI 模型如需加密回放可在模型目录 UI 手动开启）；DeepSeek 模型补充 `thinking:["enabled","disabled"]` 与 `effort:["low","medium","high","xhigh","max"]` 能力声明（与官方文档一致）。
- **思考开关生效**：DeepSeek 模型 `thinking=disabled` 现映射为 `reasoning.effort:"none"`（官方文档：none 禁用思考模式）；Chat Completions 路径同步补 `thinking:{"type":...}` 映射。此前该开关对 Responses 路径完全无效。
## [1.9.3] - 2026-08-20

### 新增功能

- **模型能力「加密思维链回放」（responsesEncryptedReplay）**：官方 OpenAI Responses 的无状态多轮回放——请求侧按需发送 `include:["reasoning.encrypted_content"]`，历史 reasoning item 原样回放（`rs_` id / `encrypted_content` / summary），assistant 文本以完整 message item 回放（`textSignature` 还原 id/phase），`function_call` 条件性携带原生 `fc_` id；Azure 在 `output_item.done` 缺失密文时由终态响应回填。gpt/o 系模型默认开启、其余模型族默认关闭，模型目录 UI 可手动配置（与思维链回传开关同款交互）。
- **思考强度新增 minimal 档**：仅作为能力/配置声明与 UI 选项（模型目录可手动勾选、会话可手动选择），不写入任何模型族默认；选中后按原样透传 `reasoning_effort` / `reasoning.effort`（Anthropic 端点因枚举不含 minimal，回落 low 透传）。
- **会话格式升级新增「responses-text-signature」步骤**：为旧会话文本块固化 v1 message id 签名（官方 OpenAI Responses message item 回放的前置字段）；与既有思维链回放字段步骤一样幂等、升级前自动备份。

### 优化

- **OpenAI Responses provider 按 DeepSeek Harness（dsh）同口径全面对齐**：`store:false` 服务端无状态；`max_output_tokens` 显式设置时下限 16；user 消息统一 parts 数组并保持原始块序（`input_image` 带 `detail:"auto"`）；refusal 文本以正文增量转发；reasoning summary 分段以空行拼接；message `output_item.done` 以权威文本兜底并新增 `text_end` 收尾事件（文本块持久化 v1 textSignature）；usage 上报 `cache_write_tokens` 且输入 token 按 `max(0, input − cached − cacheWrite)` 钳制（不再因 cached>input 抛错）。DeepSeek 纯文本回放路径（每条 function_call 前紧邻 reasoning、无 item id、缺素材占位）保持不变。

### 修复

- 官方 OpenAI Responses 加密思维链多轮回放缺 `encrypted_content` / message id 的结构性问题（此前仅 DeepSeek 纯文本路径完整可用）。
- 端点只发 `output_item.done` 不发 `output_text.delta` 时正文丢失的问题（现以权威文本补齐增量并收尾）。

## [1.9.2] - 2026-08-20

### 新增功能

- **会话格式升级官方扩展**（默认停用）：启用后在 设置 → 扩展 →「会话格式升级」卡片内一键「升级全部旧会话」——把旧会话消息升级为最新格式（OpenAI Responses 思维链回放字段），修复 DeepSeek 思维模式工具续轮 400 的历史数据问题。升级仅补缺失字段、不改变消息内容；升级前自动备份可回滚；触发即锁（升级期间对应会话不可使用，消息/重发返回 409）；运行中的会话自动跳过；幂等可重复触发。升级框架支持注册多个升级步骤，未来其他格式升级（压缩/账本等）在扩展域新增步骤即可，主应用零改动。

### 修复

- **OpenAI Responses 思维链回传结构性加固**（DeepSeek 思维模式工具续轮 400 问题）：此前 `reasoning` item 与 `function_call` 回放时丢失原始 item id（`rs_*`/`fc_*`），端点校验 reasoning↔function_call 配对时判定思维链未完整回传。现在流式端捕获 reasoning item 完整原始结构（含 id）随 thinking 块持久化、`function_call` 原始 `fc_` id 随 tool_call 块持久化，回放时原样还原；旧会话/导入历史在回放端自动走派生 id 兼容路径（与升级固化产出一致），缺素材 tool_call 保留占位 reasoning 兜底。

## [1.9.1] - 2026-08-20

### 修复

- **OpenAI Responses 思维链回传顺序与缺素材兜底**：修正 `toResponsesInput` 把 reasoning item 排在 assistant 文本消息之后导致的 DeepSeek 工具续轮 400（`reasoning_text` 未回传）；无同源 thinking 素材的历史/导入 tool_call 补诚实占位 reasoning item，避免裸 `function_call` 被端点拒绝。

## [1.9.0] - 2026-08-19

### 新增功能

- **自定义键位**：设置 → 快捷键支持点击录制自定义组合键（冲突检测拒绝保存、逐行恢复默认、整体重置全部）；命令面板与快捷键速查展示实际生效的键位（自定义覆盖即时生效）。键位覆盖存浏览器本地（`owc-keybindings`），不同设备互不影响。
- **快照 diff 全面支持 hunk 级恢复**：此前仅 git-shadow 后端提供完整 unified diff，其余后端（btrfs/zfs/refs/overlayfs）只有变更摘要。现在所有后端统一经 git 产出完整 unified diff——Web diff 视图的 hunk 接受/拒绝（「恢复到此 hunk」）在全部快照后端可用；超大文件、遍历超预算或系统无 git 时如实降级为摘要。
- **Windows 文件监听语义对齐**：目录监听由单事件轮询升级为 `ReadDirectoryChangesW`——逐路径事件、去重/折叠/overflow/limit 语义与 Linux 一致，deny 路径内的变更不再误触发索引重建。

### 变更

- **子代理工具重命名 `spawn_task` → `subagent`**：LLM 工具名与界面描述统一为 `subagent`（中文「子代理」）；旧会话 `toolsAllow`/`toolsDeny` 配置与历史消息中的旧名等价兼容（不改写历史）；swarm（并行集群）保持 `spawn_swarm` 与「Swarm」字样不变。

## [1.8.3] - 2026-08-18

### 新增功能

- **压缩输出上限可设置**：新增设置「压缩输出上限（tokens）」`compactMaxTokens`（1024–256000 整数，默认 65536，热生效；环境变量 `OWC_COMPACT_MAX_TOKENS`，越界启动即报错）。上下文压缩调用快速模型的输出上限从写死 2048 改为读该设置——思考型模型的推理消耗输出预算，需要更大余量。位置：设置 → 上下文。

### 修复

- **快速模型「返回为空」集中治理**：思考型模型把输出预算全部用于推理时正文增量为空、停止原因为 max_tokens，此前直接报错。现在正文为空且 max_tokens 停止时自动翻倍预算重试一次，仍为空但推理通道有内容时回退使用推理文本；上下文压缩、权限审核、内容透镜与扩展模型通道全部受益。
- **压缩输出防复述校验**：快速模型偶尔直接复述待压缩对话原文（既不瘦身、又白白推进压缩点使其无法重压）。现在对输出做格式校验（转录角色标记 / 概览小节 / 占位行比例 / 长度兜底），不合格自动带原因纠偏重试一次；仍不合格或快速模型彻底失败时，水位强制压缩自动降级为规则截断照常完成（安全网不再中断），手动 `/compact` 维持报错提示。
- **压缩后窗口占用立即刷新**：手动压缩（及 `/clear`、驱逐、恢复）成功后，会话头部与上下文面板的窗口占用立即按新数值刷新，不再等下一轮对话。

## [1.8.2] - 2026-08-17

### 新增功能

- **本机会话**（侧栏「终端」图标一键创建）：会话目录固定为用户家目录（HOME），沙盒固定 `关闭`，命令直接以 server 身份在宿主机执行——适合管理本机文件/服务。文件工具访问 HOME 之外的路径必须经人工允许（每次或「总是允许」按目录前缀记入会话规则，HOME 内按普通权限模式处理）；本机会话不做快照、不能切换沙盒模式、不支持托管工作区。
- **子代理默认走平衡档**：主代理派发子代理（`spawn_task`/`spawn_swarm`）未指定 `role` 时默认使用「平衡」档（此前回落会话当前模型），显式角色与回落链不变。

### 界面调整

- **移动端断点收窄到 768px**：平板竖屏（768–1024px，3:2 / 16:10）恢复桌面三栏布局（活动栏 + 侧栏 + 主区、桌面顶栏与底部面板）；仅手机（≤768px）走移动单列布局。chat 模式（ChatGPT 风格对话页）补齐手机端适配：侧栏变覆盖式抽屉（遮罩/Esc 关闭、焦点循环与归还、选中会话自动收起）、触屏会话菜单与消息操作按钮常显、输入框 16px 防 iOS 聚焦自动放大、触控目标 40–44px、安全区适配。
- **对话框手机端修复**：命令面板/QuickOpen/新建会话/确认框输入框手机端 16px 防 iOS 自动放大；通用浮层底部留出 Home 指示条安全区；确认按钮行与新建会话的目录绑定/备选模型行窄屏允许换行；AskUser/Plan 审批/权限确认卡的按钮行窄屏换行收边。

### 修复

- **配置变更不再误杀终端**：会话沙盒/环境配置未实际变化时的例行重配（agent 每轮启动、文件浏览）不再回收持久 shell 与人类终端；策略实际变化才走原有清理。配置变更遇在途 `!cmd` 默认返回 409，前端弹「中断 shell 命令」二次确认后强制应用。
- **会话沙盒/环境切换即刻生效**：变更沙盒模式/初始化脚本/网络/Python/Node 环境时回收该会话持久 shell（旧 pty 在旧策略下打开，不回收则切换不生效），下条 bash 透明重建；`pty.open` 修正为遵循会话沙盒关闭语义。
- **非本机环境安装只落进环境目录**：nodeEnv `fnm`/`nvm` 与 pythonEnv `uv-config` 的 venv 从只读挂载层移到读写层并严格限定环境自身目录——沙盒内 `npm i -g` / `pip install` 只写该目录，系统树只读；顺带修复 `uv-config` venv 在 POSIX 沙盒内不可见导致的静默失效。
- **新建会话备选模型行防横滚**：超长模型名（如 `claude-opus-4-1（anthropic）`）的 select 在极窄屏省略号截断，不再撑出对话框横向滚动条。

## [1.8.1] - 2026-08-16

### 新增功能

- **用量日志清理可配置**：`usage-events.jsonl`（成本报表数据源）支持按策略定期清理——设置 → 服务信息新增「用量日志清理模式」（默认 off 不清理，保持历史行为）与「用量日志保留天数」（1–3650，默认 365，对应环境变量 `OWC_USAGE_LOG_CLEANUP_MODE` / `OWC_USAGE_LOG_RETENTION_DAYS`）。四种模式：`deleted-after-days`（仅已删除会话的事件保留超过指定天数后清理，未删除会话全部保留）/ `all-after-days`（所有事件超过指定天数后清理，不分会话）/ `deleted-immediate-live-timeout`（已删除会话的事件立即清理，未删除超过指定天数后清理）/ `deleted-immediate-only`（已删除会话的事件立即清理，未删除不清理）。会话是否删除按 `<数据目录>/sessions/<id>` 目录存在性判定；清理在启动时 + 每小时执行一次（与存储 GC 同节奏），保存设置立即生效一次。

### 官方扩展

- **环境模拟 0.1.5**：DSH 极简模式预设的 basePrompt 在原文基础上追加人称约定（The personal pronoun is us/we.），其余 persona 提示词与工具形态保持 DSH 原文复刻不变。

## [1.8.0] - 2026-08-15

### 官方扩展

- **内置预设支持自定义覆盖与还原**：env-sim 预设解析改为用户目录优先——在 `<业务数据目录>/env-sim/personas/` 放入与内置同 id（`claude-code`/`kimi-code`/`zcode`/`codex`/`dsh-minimal`）的预设 JSON 即覆盖该内置，只覆盖填写的字段、工具形态/命令拟态等其余部分自动继承内置；UI 中覆盖项显示「已自定义」标记，可一键「还原内置预设」。自制预设的分享机制不变。

- **context-manager 改名 context-saver（0.3.0）**：官方扩展「上下文管理器」更名为「上下文节省」（Context Saver），职责更聚焦。持久化状态自动迁移：extensions.json 旧键配置原样继承，会话 extensionState 写路径归一，无需手动处理。
- **驱逐/条目/选择性上下文归入扩展且可开关**：滚动驱逐（自动/手动）、上下文条目管理（恢复/固定/再逐出/查看原文）与选择性上下文（pin/排除路径）整体迁入 context-saver（服务端实现位于 `server/src/extensions/context-saver/`），随扩展启停。停用后：agent 循环不再自动驱逐、read_artifact 驱逐联动不生效、pin/排除不参与上下文组装，上下文面板中驱逐策略/选择性上下文/上下文条目三段隐藏，相关 REST 端点返回 409。

### 新增功能

- **压缩独立为核心功能**：水位强制自动压缩与 `/compact` 手动压缩、预算上限、cache 断点不再随扩展开关——核心安全网始终生效；驱逐占位/摘录的渲染也留在核心视图组装（buildView 需渲染既有 evicted 条目）。
- **自动压缩水位可设置**：新增设置「自动压缩水位」`compactionThresholdPercent`（50–95 整数，默认 85，热生效；环境变量 `OWC_COMPACTION_THRESHOLD_PERCENT`，越界启动即报错）。强制压缩水位取该值，建议压缩水位为该值 −15 个百分点；会话头部窗口占用的黄/红告警线随动。位置：设置 → 上下文。
- **上下文窗口五分类段归因**：按段 token 归因改为 system（系统提示词，repoMap 归因于此）/ input（输入）/ toolCalls（工具调用）/ output（正式输出）/ other（其它：thinking 块、压缩摘要头）五分类；上下文面板「上下文窗口」堆叠条与「按段 token 归因」同步按新分类展示（旧分类键废弃，契约直接替换）。

### 界面调整

- **设置页重排**：新增「上下文」页签（AI 与服务组：自动压缩水位、单条消息/子代理最大轮次）；默认思考力度/快照方式/快照后端归入「会话默认」页签；「通用」页签收窄为语言/货币/Chat 模式（区标题改「语言、货币与模式」）；离线模式移入「联网服务」页签。
- **上下文面板拆分**：驱逐策略、选择性上下文、上下文条目三段仅在 context-saver 扩展启用时渲染；手动压缩按钮与压缩信息并入核心「压缩」区、始终显示；预算、cache 断点、用量、成本留在核心面板。

## [1.7.9] - 2026-08-15

### 修复

- **环境模拟 0.1.4**：修复 DSH 极简模式预设中 `str_replace_editor` 无法调用的问题——描述原文中的 view/create/insert 命令说明诱导模型传入 `command` 等参数，经别名翻译透传后被执行层参数白名单拒绝；描述已裁剪为可执行的 str_replace 形态（保留 old_str 唯一性等操作指导），并新增端到端测试验证参数翻译后正常执行。

## [1.7.8] - 2026-08-15

### 新增功能

- **上下文默认驱逐策略调整**：默认保留最近轮数 2→10、回写预算 20,000→64,000——默认保留更多工具结果全文，驱逐后恢复被逐出内容的预算更宽裕（会话级策略可在上下文面板调整；已有自定义策略的会话不受影响）。

### 官方扩展

- **环境模拟 0.1.3**：新增 DSH（DeepSeek Harness）极简模式预设——persona 提示词与 bash、str_replace_editor 双工具的描述、参数形态复刻自 MIT 开源包 `@deepseek-ai/dsh@0.1.0-rc.6`（`config/agent-presets/minimal/agent.cordis.yml`，Copyright (c) 2026 DeepSeek；str_replace_editor 仅暴露 OWC 可执行的 str_replace 参数形态）；首轮仅注入双工具，第二轮起注入保留工具（read_artifact 在自动驱逐开启时由组装层强制放行）；隐藏 OWC 专属文件、git、后台与定时工具（git 操作由模型经 bash 自行处理），保留 web 搜索、待办、子代理与技能工具。

## [1.7.7] - 2026-08-14

### 新增功能

- **子代理轮次上限可调**：`spawn_task` / `spawn_swarm` 新增可选 `maxTurns` 参数（1–1000，swarm 支持调用级与逐项双重覆盖），主模型可按任务复杂度按次指定；未指定时使用设置页新增的「子代理最大轮次」（服务设置 → 语言与货币，默认 100，热生效）。内置 explore / general 子代理默认轮次由 15 / 40 统一提升为 100，与设置默认一致。
- **子代理结论上限提升**：结论硬截断上限由 2000 字符提升至 64000 字符（防单条结论撑爆主上下文的保护线，正常结论远小于此值），长任务的完整结论可进入主上下文。

## [1.7.6] - 2026-08-14

### 内部重构

- **代码结构整理**：Web 类型契约按域拆分（`contracts.ts` → `lib/contracts/` 16 个域文件，barrel 保持 import 面不变）；服务端上下文管理拆分出类型（`context-types.ts`）与纯函数（`context-ledger-ops.ts`），Agent 运行器工具别名/参数归一逻辑收编至 `agent/tool-alias.ts`，并收敛拆分后的导出面。均为行为不变的结构调整，无用户可感知变化。
- **测试精简**：server/web 测试合并同构用例、收敛辅助设施与 setup、修复脆弱断言，全量通过率不变。
- **文档整理**：AGENTS.md 合并历史版本要点并压缩至约 180 行；`help/development.md` 等文档与代码结构同步。

## [1.7.5] - 2026-08-13

### 新增功能

- **环境模拟支持出站 User-Agent 模拟**：环境模拟扩展新增「模拟出站 User-Agent」开关（默认关闭，需手动开启）。开启后，出站 HTTP 请求（联网工具、模型服务商、MCP、模型目录与定价同步等）的 User-Agent 自动使用所选预设的拟态值（内置预设如 `claude-code/2.1.232`、`codex/0.147.0`；用户自定义预设也可携带 `userAgent` 字段）；关闭开关、禁用扩展或未选预设时恢复默认 `owc/openwebcode{version}`。仅跟随扩展全局预设，会话级 persona 覆盖不影响全局出站请求；更新检查与在线更新链路始终使用官方 UA，不参与模拟。
- **移动端对话栏布局优化**：窄屏（≤480px）下对话栏功能行由三行压缩为两行——第一行放附件、模型审核、对话模式与模型选择器，第二行放「运行中 · 发送将进入 Steering 队列」提示与发送按钮，减少输入区垂直占用。

### 官方扩展

- **环境模拟 0.1.2**：新增「模拟出站 User-Agent」开关与预设 `userAgent` 字段。

## [1.7.4] - 2026-08-13

### 新增功能

- **Docker 安装方式**：仓库根目录新增 `Dockerfile`、`docker-compose.yml` 与 `.dockerignore`，`docker compose up -d` 一条命令即可部署（或 `docker run` 等价启动）。发布镜像托管于 GitHub Container Registry（`ghcr.io/snnh/openwebcode`），推送 `v*` tag 时由新增的 `docker.yml` 工作流自动构建 linux/amd64、linux/arm64 多架构镜像（稳定版另打 `latest`；也支持手动 `workflow_dispatch` 重建——输入 tag 构建该 tag，留空则构建当前分支，便于打包问题修复后无需移动已发布 tag）。镜像基于 Debian 13（`node:24-trixie`），按发行版 staging 契约组装运行树并以非特权用户运行：数据目录用命名卷持久化，非回环监听自动生成访问令牌并把带 token 的访问链接打印到容器日志；Landlock 沙盒开箱即用，bubblewrap 命名空间隔离在 compose 放开 `seccomp=unconfined` 后启用（不可用时 core 自动降级，属设计内行为）；容器内不做原地自更新，升级即拉新镜像。详细说明见 [`packaging/README.md`](./packaging/README.md) 的「Docker 镜像」一节。

## [1.7.3] - 2026-08-13

### 新增功能

- **Chat 模式展示思考过程**：模型思考内容不再被隐藏——流式期间思考增量实时显示在「正在思考」折叠区（live 态，随输出滚动），回答完成后沉降为历史消息内的「思考过程」折叠块（默认收起，点击展开）；DeepSeek/Claude 等思维模型可完整查看推理过程，刷新后依然可展开回看。历史与流式均复用工作台同款折叠组件与样式。
- **Chat 模式纯图片消息**：粘贴/选择图片后不输入文字也可直接发送（vision「贴图即问」）——发送按钮与消息接口放宽为「有内容即可」（图片块即内容），消息体只含图片块；纯图片消息不派生会话标题（保持默认），不参与文本去重。
- **Chat 模式空态建议一键直达**：首页建议行点击直接发送（自动建会话后即发），不再仅注入草稿；「生成图片」「搜索网页」等引导语即点即答，原有「换一批」轮转不变。

### 修复

- **思维链回传缺失导致 OpenAI Responses 400（reasoning_text must be passed back）**：DeepSeek 等思维模式端点强制历史中每个工具调用前回传完整推理文本。子代理（spawn_task/spawn_swarm）与 Chat 模式此前丢弃 thinking 增量，思考从不进入对话历史，第二轮工具调用必现 400、子代理秒挂。现两处均把 thinking_delta/thinking_end 累积为带 provider 标记的 thinking 块随 assistant 消息落盘，下一轮自动携带回传素材；回传开启但历史缺素材时 stderr 留痕一次（每进程限频）便于诊断调用方丢弃增量。

### 官方扩展

- **上下文档案库 0.1.1 / 环境模拟 0.1.1 / 视觉工具 0.2.1**：补齐此前扩展代码变更未同步的版本号（档案库 1.7.1 思考适配；环境模拟 kimi-code 预设更新与工具别名多别名支持；视觉工具 1.7.2 后 /clear 编号表清空修复）。

## [1.7.2] - 2026-08-13

### 新增功能

- **视觉工具扩展新增 `toolCall` 工作模式**：图片不再预先生成完整描述，而是以 `[图片 #N]` 占位符注入上下文，并注册 `describe_image` 工具——主模型按需向视觉模型提问，省主模型 token、图片内容按需获取；占位符编号会话内稳定（跨轮/扩展 Host 重启不变，持久化于扩展 storage），回复按「图片内容 + 提问」哈希缓存。配套新增扩展 API `context.readImageFile`（经 core 沙盒读取工作区 png/jpeg/webp/gif 图片，≤5MB）；`describe_image` 的结果永不驱逐（新增工具结果驱逐白名单，自动/手动驱逐均跳过），避免图片关键上下文被清掉破坏任务连续性；Composer 侧主模型不支持视觉时，只要视觉工具扩展启用且配置了视觉模型即可添加图片。默认仍为 `describe` 模式，`toolCall` 在扩展设置中切换。

### 界面与体验

- **`ask_user` 选择题支持自定义「其他」回答**：单选/多选问题末尾自动附加「其他」选项，后面紧跟输入框——选中「其他」并输入文本后，该文本作为该题答案返回给 agent（空输入不可提交）；确认/自由文本题型与原有选项回答协议不变。

## [1.7.1] - 2026-08-12

### 新增功能

- **新增「视觉工具」官方扩展**：主模型不支持视觉时，自动把会话图片逐张交给配置的视觉模型生成描述，以文本块替换图片注入上下文（支持视觉的主模型、未配置、无图片时均不干预）；描述按图片内容哈希缓存（可关），单图失败降级为占位文本不阻断对话；配置项全部在扩展设置中：视觉模型（模型选择器下拉，仅列出已启用服务商中支持图片输入的模型）、描述提示词、思考（默认开）、输出上限（默认不限制）、缓存开关。

### 修复

- **压缩档案馆适配思考模型**：快速模型正文落在思考通道（思考型模型思考链耗尽输出上限）时不再报「快速模型返回为空」——档案库 Pass 1/Pass 2 优先走快速模型链路，空返回时自动直连 provider 流收集思考文本兜底；整理输出上限（maxTokens）从写死的 2048 移到扩展设置「整理输出上限（tokens）」，默认不限制（端点默认），思考型模型可在扩展配置中手动调大；recall_memory 召回输出上限默认 1500 → 4096。
- **`/clear` 分隔线在存在分支/重新生成的会话中位置提早**：清空边界同时以「最后一条活动路径消息 id」锚定（ledger 新增 `uptoMessageId`），REST 上下文视图与消息流分隔线按消息 id 精确定位，不再因离路径消息穿插而把分隔线提早插入、残留尾部消息；分隔线固定在清空时刻，之后的新消息显示在其下方（不贴底、不随新消息移动），旧账本（无 id 字段）自动回退原逻辑。
- **只读探查命令自动放行**：bash 工具（含 `!` shell 快捷命令）执行纯只读探查链（`cd`、`echo`、`head`、`ls`、`find`、`grep`、`git status` 等白名单命令经 `&&` / `|` / `;` 组合，无重定向、无命令替换）时不再弹权限卡，直接执行；词法级判定保守——含写重定向、`$()`/反引号、`find -exec`、`sed -i`、`git push` 等任何写形态仍照常人工批准，放行不改变沙盒与路径策略。

## [1.7.0] - 2026-08-12

### 界面与体验

- **缓存率与成本显示优化**：顶栏缓存读数标注累计/本轮口径并按命中率分档着色（<30% 红、30–60% 黄），成本对未定价 tokens 标 `*`；上下文面板新增「已驱逐 N tokens（M 条工具结果）」读数；成本面板新增「缓存命中」与「缓存节省」摘要卡（按定价目录价差估算，不完整标 `*`），按日/按会话明细表加「命中%」列并支持组级分页（默认 10 组/页），数字列右对齐、表头吸顶、窄面板横向滚动。
- **上下文压缩在消息流中留下常驻检查点行**：`/compact` 与 85% 水位强制压缩开始时出现「正在压缩上下文」活动行，完成后原位沉降为折叠检查点行——模式徽标（档案库/概览/工具调用）+ 手动/强制标注 + 被压缩条数与约 token 估算；带摘要的记录可展开查看摘要（Markdown 渲染）与指令清单，无摘要保持可见不可展开；压缩失败转为常驻错误行（可关闭）。账本新增压缩历史（封顶 20 条）与被替换段 token 估算，刷新后多次压缩逐条还原（旧账本读取不受影响）；`clear` 边界覆盖的过期记录不再渲染。Context 面板的压缩区补「被替换段估算」一行。
- **`/clear` 分隔线升级**：清空点渲染为「横线 + 图标 + 文案 + 横线」的分隔形态（原虚线顶边近乎不可见），悬停可见清空时间，与压缩检查点行同视觉族。
- **切换到 yolo 需过风险确认**：权限弹层选「完全自主」先弹确认对话框（明确「只跳过确认、不解除或扩大沙盒」），勾选「我已了解风险」后才生效；其余三档维持即选即生效。
- **theme-color 跟随主题**：浏览器/PWA 工具栏配色随明暗主题切换；滚动条改为悬停显现（拇指静止透明，容器悬停或键盘聚焦时显现，不再常驻占色）。
- **后台任务弹层增强**：运行中任务排前（先启动在前）并逐秒跳动耗时，已结束任务按结束时间倒序排后并弱化显示；Esc/点击外部关闭并还焦徽标按钮。
- **本轮产出文件行**：一轮中 write_file/edit_file 触及的文件在该轮末尾汇总为一行（按路径去重、标注写入/编辑），点击直接在编辑器分栏打开；工具调用卡展开区补同款文件路径链接。
- **Chat 模式体验优化**：侧栏会话列表加搜索框（按标题过滤）；消息区补「回到底部」浮钮；纯文本 user 消息支持「编辑重发」（就地编辑后长出新分支，旧分支保留，新增 `POST /api/chat/sessions/:id/messages/:messageId/edit`）；首页空态建议扩充为 6 条并支持「换一批」轮转。

### 性能

- 顶栏/底栏/状态栏的上下文数据改为切片订阅，账本无关字段变化不再触发重渲；后台任务查询改为事件驱动（新增 task.started 事件即时刷新徽标），轮询收敛为活跃 5s / 空闲 30s；成本报表表格分页后 DOM 规模封顶，不再随会话数膨胀。
- 内存驻留收紧：成本报表聚合缓存改为 LRU 封顶（8 份，此前 from/to 自由区间组合可无限增长）；前端查询缓存 GC 由 5 分钟收紧到 2 分钟，会话详情/上下文视图等大 payload 切走后更快释放。

### 修复

- **快照扫描改用 core 有界原语并统一路径策略**：git-shadow 检查点创建时的工作区扫描改走 core 的 `index.scan`（C 侧有界递归，排除在原生层完成），不再由 Node 直接遍历工作区——扫描与文件工具共用同一路径策略，会话 deny 路径（默认含 `.env`、`.owc/hooks.json`、`.owc/mcp.json`）不再被复制进影子仓库，恢复检查点时这些路径同样受到保护（`git clean` 不会删除快照未捕获的 deny 文件）；会话「上下文排除」配置（contextExcludes）现在同时作用于快照，与 repo map / 索引同一份用户配置。

## [1.6.7] - 2026-08-11

### 界面与体验

- 上下文压缩全程有反馈：手动压缩（`/compact`、Context 面板按钮）与 85% 水位强制压缩开始时即提示「正在压缩上下文…」（档案库 / 概览 / 工具调用模式与是否强制均标注）；`/compact` 没有可压缩区段时提示具体原因（此前完全静默）；压缩请求进行中忽略输入框的重复提交，避免二次压缩或与 agent 运行并发写账本。

### 修复

- **compact-vault（上下文档案库）扩展不生效**：生产装配遗漏——档案库压缩服务未注入 HTTP 层，手动 `/compact`（斜杠命令与面板按钮）始终回落默认概览压缩；85% 水位强制自动压缩此前也永远走概览压缩（覆盖档案库索引、后续消息不再归档），现与手动压缩统一走档案库路径；仅启用档案库（无压缩器）时 `/compact` 斜杠命令误报 503 的问题一并修复。
- **沙盒内找不到 node / npm（node 经 nvm / fnm 安装时）**：沙盒只挂载系统树与会话工作区，宿主 PATH 继承了但工具链目录不可见，表现为 `npm: command not found`。现在只读挂载与 Node 环境选择绑定——`global` 解析宿主 PATH 上实际生效的 node/npm 工具链根目录（跟随软链）；`nvm` 挂载 `$NVM_DIR`（nvm.sh 与全部版本）；`fnm` 挂载 fnm 安装目录；`project` 不变（`node_modules/.bin` 本就在工作区内）。挂载只读且对文件工具不可见，Node 环境切换后下次工具调用自动按新选择重配；同时修复 filtered 网络档覆盖只读挂载列表、导致 git 凭据与工具链挂载丢失的问题。

## [1.6.6] - 2026-08-11

### 界面与体验

- **env-sim 环境模拟预设更新**：`kimi-code` 按官方开源仓库（kimi-cli）重写——身份行与官方一致，语言跟随、提示词与工具使用、编码准则、上下文管理等小节全面对齐，`/init` 提示词取自官方 init 命令模板；`zcode` 按逆向分析修正——身份行、安全边界与 Harness 规则、记忆 / 动态行为 / 上下文管理 / 会话引导小节重写，工具面补齐 TodoWrite / Agent / Task / Skill / WebSearch / WebFetch / AskUserQuestion / TaskOutput / TaskStop / CronCreate 等；`codex` 补充 Plan tool 与 Presenting your work 小节，`apply_patch` 改用 Codex 参数形态，移除 list_files / search 别名并隐藏 glob / grep（对齐真实 Codex 无独立文件搜索工具、搜索走 shell），新增 request_user_input。

### 修复

- env-sim `zcode` 预设的 `Task` 工具实际不可见：同一内置工具（spawn_task）注册 `Agent` 与 `Task` 两个别名时，第二个别名在工具清单构建中被静默丢弃，模型调用 `Task` 报未知工具；别名引擎改为支持同源多别名（首个别名原位重命名、其余克隆追加），两个名称均可正常下发与执行。
- env-sim 预设三处工具描述与实现不符：`kimi-code` 的 TodoList 声称可省略参数读取当前清单（内置实现缺参会报错，描述已修正并补必填）；Agent 描述引用不存在的子代理类型 `coder`（显式选择会报 Unknown sub-agent，改为 explore / general）；Read 声称支持负数行偏移从文件末尾读取（底层不支持，描述已移除该承诺）。

## [1.6.5] - 2026-08-11

### 性能与内存

- **agent 主循环热路径瘦身**：每轮上下文账本的内存分配降低约 92%（轮内共享账本句柄，全量克隆 6→1、落盘 2→1）；上下文驱逐事件不再向所有客户端广播含文件摘录的完整条目列表，长会话流式期间的事件带宽与内存占用显著下降。
- **chat 模式消息缓存**：发送消息、翻页、分支等操作不再每次全量读取解析会话文件（含内嵌图片的会话文件可达数十 MB），命中缓存后近乎零开销。
- **大仓库索引查询提速约 2 倍**：10 万文件规模下符号/文件模糊查询 p95 从 35-44ms 降至 18-22ms（@ 引用补全、快捷打开、code_search 更跟手）；会话列表打开大量会话时不再重复全量扫描消息文件。
- **前端渲染**：输入框每次击键不再触发整页重渲染；长会话流式输出期间历史消息与图片不再逐帧重建，滚动与输入更顺滑。
- **首屏与安装包体积**：聊天模式 / 工作台 / 分享页按需加载，首屏脚本从 542KB 降至 475KB；数学公式字体只保留 woff2 格式，分发包减小约 700KB。

### 修复

- chat 模式输入框在中文输入法组词过程中按 Enter 确认候选会误把消息发出去。

## [1.6.4] - 2026-08-10

### 新增功能

- **模型服务商预设**：添加模型服务商表单顶部新增预设下拉，内置 12 个知名供应商（OpenAI、Anthropic、OpenRouter、DeepSeek、Moonshot (Kimi)、Kimi Coding Plan、智谱 GLM、GLM Coding Plan、阿里云百炼、腾讯云、百度千帆、Ollama），选中后自动填充服务商名称、接口类型与 Base URL（Kimi / GLM Coding Plan 为订阅制编程套餐专用端点，须使用套餐独立 API Key），用户只需填入 API Key 即可保存使用。预设仅出现在添加模式，编辑既有服务商不受影响。

### 界面与体验

- 手动压缩上下文时（压缩工具调用 / 概览压缩），按钮即时显示「压缩中…」并禁用两个压缩按钮防止重复触发，压缩完成或失败后恢复；此前压缩期间仅按钮置灰、无任何进行中反馈。

### 修复

- OpenAI 兼容 / Anthropic 接口在会话历史含孤儿工具结果（`!` 快捷命令输出、中断未落盘的结果、压缩边界残留）时整轮 400（`tool_call_id is not found` / `unexpected tool_use_id`）：工具调用与结果现在强制配对——中断缺失的结果补占位、无对应调用的游离结果丢弃、重复调用 id 去重。
- `/clear` 清空上下文后，存在过分支 / 重新生成的会话后续所有消息（含图片）都进不了模型视图（模型自称「没有收到用户消息」）：清空边界改用活动路径长度计算，此前越界的边界会把之后的新消息一并清出。已受影响的会话升级后再执行一次 `/clear` 即可恢复。
- `git_commit` 工具在沙盒会话中报 `could not read log file`：提交信息文件从数据目录移到工作区 `.git/` 内（沙盒只挂载工作区，数据目录沙盒内不可读），不进 git status、无残留。
- Linux 沙盒（bubblewrap / Landlock）内 `git push` / `gh` 取不到宿主凭据、挂起交互提示表现为卡死：宿主 `~/.gitconfig`、`~/.git-credentials`、`~/.config/git`、`~/.config/gh`、`~/.ssh` 中实际存在的项以只读挂载进沙盒；仅沙盒内进程可读，文件工具不可见。

## [1.6.3] - 2026-08-10

### 界面与体验

- 新建会话对话框新增**目录浏览选择**：工作目录输入框旁加「浏览…」按钮，点击弹出目录浏览器浮层，支持面包屑导航（可跳回任意层级）、目录列表（文件灰显仅作定位参考、符号链接标记但不跟随），选定后回填路径。
- 目录浏览范围受**可信根**限制：默认用户家目录，可通过 `server-settings.json` 的 `browseRoots` 字段或环境变量 `OWC_BROWSE_ROOTS` 配置（热生效，每行/分隔符一个绝对路径，最多 16 个）；服务端严格校验路径不越界，手动输入仅校验存在性。

## [1.6.2] - 2026-08-10

### 界面与体验

- 模型定价页面新增**条目编辑**：表格每行新增「编辑」按钮，点击后该条目数据回填到表单（价格自动从 micro-units 转回每百万 tokens 单价），修改后保存即更新。添加与编辑共用统一表单，标题与按钮文案随模式切换；编辑/添加进行中禁用其余行的操作按钮以防误触。
- 模型定价页面新增**模型选择器**：provider 与 model 输入框绑定 `<datalist>` 自动补全，选项来自模型目录（`/api/models`）；model 列表按已选 provider 过滤。仍可自由输入目录外的模型，补全仅为建议。
- 重构定价条目校验逻辑为共享 `parseFormPrices()`，添加与编辑路径复用同一套校验与 micro-units 转换。

## [1.6.1] - 2026-08-09

### 界面与体验

- Chat 模式界面对齐 ChatGPT：空态首页居中问候 + 居中输入框 + 建议行（生成图片 / 撰写或编辑 / 搜索网页，点击注入引导文本并聚焦），首页直发自动建会话；用户消息右对齐气泡、助手消息通栏平铺；复制 / 重新生成改图标键（悬停显现，复制带勾选反馈）；工具调用与结果按 id 配对为可折叠卡片（默认收起，失败标红）；运行中新增「思考中」三点动画与工具活动提示。
- Chat 侧栏：会话按 今天 / 昨天 / 过去 7 天 / 更早 分组；三点菜单悬停显现；「工作台」入口移至侧栏底部（侧栏折叠时主区头部保留图标键）。
- 工作台「聊天」入口从右下角浮动按钮移入活动栏底部（帮助 / 通知 / 设置之上），移动端导航菜单同步。

### 修复

- 手动「立即检查」更新在更新检查开关关闭时不生效（`updateCheckEnabled` 默认关，手动检查被周期开关误伤）。
- Chat 模式：收起侧栏后残留 260px 空列；发送消息后自己的问题要等回复结束才显示；运行中无输出期间（工具循环 / 模型思考）界面无任何反馈。

## [1.6.0] - 2026-08-09

### 新增功能

- **Chat 模式**：ChatGPT 风格的纯对话模式，与编码工作台并存（默认关闭，设置 → 通用中开启）。可折叠会话栏 + 居中消息流 + 底部输入框；独立会话存储，支持会话树（分支 / fork / 回溯 / 重新生成）；助手预设把系统提示词、模型覆盖、生成参数（temperature/topP/maxTokens/推理档）、预置消息与工具清单打包成可一键切换的角色；只读分享——生成短链公开页，可设访问密码，随时撤销。
- **Chat 工具扩展**（默认全关，逐个开启）：time / calculate、web_search / web_fetch、image_gen / vision、python / read_file / write_file / show 共 10 个工具按 4 类分组。Python 在独立沙盒执行：uv 管理的环境预装 numpy/pandas/matplotlib/sympy/scipy/Pillow（不可额外装包），Linux 用 bubblewrap 全隔离（禁网），Windows 经 Job Object 进程树约束（无网络/文件系统隔离，界面如实标注）；matplotlib 图直接内联回对话。
- **媒体能力**：image_gen 走 OpenAI 兼容图像接口（可选画面比例），vision 可分析对话中的图片、会话文件或网页图片（可选推理档）；两者使用的能力模型在 chat 设置中按模型能力声明挑选，主模型本身能看图/出图时对应工具开关自动隐藏。输入框支持粘贴/选择图片上传（小图内嵌、大图落盘引用）。
- **搜索/抓取服务商扩充**：新增 Bing、SearXNG、Exa、LinkUp、Bocha、Firecrawl，chat 与编码工作台共用同一套配置，改动热生效。

### 界面与体验

- Chat 模式局域网内免令牌直接对话（`chat.json` 的 `lanUnauthenticated: false` 可关闭）；改配置、进工作台始终需要令牌。

### 破坏性变更

- 模型目录移除 `maxOutput` 字段：上下文可用预算不再预留输出缓冲（水位百分比本身已留余量）。旧目录文件中的该字段读取时静默忽略、保存时自动剔除；需要限制输出长度时，用服务商的**自定义请求体**（如 `{"max_tokens": 8192}`）下发。

## [1.5.0] - 2026-08-08

### 新增功能

- compact-vault 官方扩展（默认关）：启用后 `/compact` 切换为档案库式压缩——完整上下文归档到会话 `compact/` 目录（内容全保留），快速模型整理生成目录式索引注入主模型；主模型可按 key 经 `recall_memory` 工具召回对应片段。归档分块大小、保留尾部消息数、召回上限均可在扩展配置中调整。
- 扩展配置从 JSON 编辑全面升级为类型化表单：枚举下拉、整数（min/max/step）、布尔开关、嵌套分组与「键=值」字典编辑，每个字段带说明文字；英文界面字段文案同步翻译。第三方扩展在 manifest 声明 `configSchema` 即可获得同样表单（子集说明见开发指南「写扩展」一节）。

### 界面与体验

- WebUI 全量重写：自研 store（useSyncExternalStore）+ 集中式 WS 事件路由替代逐组件订阅；命令体系（命令面板 / 快捷键 / 托盘菜单）合一为注册表；设置对话框零 props 化、各分区自取数据；样式按域拆分十一份样式表。
- 聊天长列表改为 `content-visibility` 免虚拟化渲染 + rAF 流式合批，滚动系统重写——修复上滚查看历史时闪白屏或被拽回底部的问题，超长会话滚动与跟底更稳。
- 修复移动端会话底部空白条、消息卡片视觉重叠；修复窄屏下底部面板与聊天区文字叠印。
- 设置页窄屏适配：外观强调色等横向排布自动换行，模型目录 / 服务商 / 定价等宽表格在面板内横向滑动，不再右侧截断。
- 无可配置项的扩展（如评测 Harness）不再显示无意义的 JSON 编辑区。

### 修复

- ask_user 交互在 run abort 竞态下永久挂起：中断与超时现在能正确回收挂起的提问，agent 不再卡在等待回答状态。

### 文档

- FAQ 增加分组目录（65 条问答全量锚点链接），与 usage.md 目录样式一致。

## [1.4.0] - 2026-08-06

### 新增功能

- Linux 沙盒默认后端切换为 bubblewrap（mount/net namespace 隔离），无 bwrap 环境自动回落 Landlock 并如实上报 `partial` 与原因；`sandbox.mode` 可显式强制 `landlock` / `bubblewrap`（POSIX 限定）。
- Windows 新增 `filtered` 网络档：业务进程无网络 capability，经沙盒内 sidecar 代理出网；域名 deny 清单（`sandboxProxyDenyList`）保存即热生效。
- 会话级 Python 环境（global / uv-workspace / uv-config）与 Node 环境（global / project / fnm / nvm）：解释器与版本管理器可用性懒检测，bash 工具自动注入激活片段，会话头部可随时切换，设置 → 服务信息可配全局默认。
- 会话级备选模型链（fallback，最多 3 个）：主模型遇可恢复错误（限流 / 过载 / 超时 / 流中断）重试耗尽后自动切换备选继续本轮；401/400 等不可恢复错误不切换；子代理不继承。CLI 对应 `--fallback-models`。
- 工具限制与只读模式：新建会话可配工具白名单 / 黑名单；CLI `owc run --tools` / `--exclude-tools` / `--read-only`。
- 离线模式（设置 → 通用，`OWC_OFFLINE`，热生效）：关闭 server 自身周期性出站（更新检测、远程目录/定价同步、汇率刷新）；模型 API、联网工具、MCP 不受影响。
- bash 工具注入会话元数据环境变量：`OWC_SESSION_ID` / `OWC_WORKSPACE` / `OWC_SANDBOX_MODE` / `OWC_AGENT_MODE`。

### 界面与体验

- 会话头部统一重排：会话环境（沙盒 / 终端 / 快照 / Python / Node）改为图标化选择器，信息行单行紧凑排布，窄屏与移动端布局同步适配。
- 模型目录表格：窄屏可横向滑动；删除「来源」列；能力/思考/力度合并为单列，思考按「仅开关 / 强度调节（档位）/ 自适应」描述；操作列前置、删除改垃圾桶图标；双击进入编辑自动滚动到表单。

### 修复

- 模型链路与运行时专项审计（两批 20+ 项）：compactor 分叉会话索引错位、provider 错误体截断与 SSE 8MiB 上限、限流器预占并发、CJK token 加权、后台任务 TTL 驱逐、hook 内置名冲突、core 协商失败可重试、pty 回放时序等。
- core：grep / 搜索文本截断回退到 UTF-8 字符边界，不再截出半个多字节序列；JSON 解析拒绝重复键对象（-32700 parse error），不再静默保留首个值。
- TOTP 登录锁定到期后失败计数不清零（攻击者无法每轮锁定换满 5 次尝试）；MCP HTTP/SSE 响应体 8MiB 上限与非 JSON 明确报错；MCP 连接被空闲回收时给可重试的友好错误；task_output 阻塞轮询挂 abort 即时唤醒。

### CI

- 全部工作流 `npm ci --ignore-scripts`；新增每周依赖审计（audit.yml，`--audit-level=high`）。
- server 测试文件按模块合并精简 149 → 117。

### 文档

- README 中英双语重写（hero + badges、一行式特性要点、最短快速开始）。
- help 使用帮助 / FAQ / 开发指南全部重写并逐条对照代码核实（usage 补 Python/Node 环境、离线模式、备选模型、工具限制等新功能；FAQ 新增 5 条；开发指南修正 workflow 数量、探测链入口等过时内容）。
- packaging README 双语对齐：英文版从摘要补齐为完整内容，install.sh 全选项表逐行对照脚本。

## [1.3.8] - 2026-08-04

### 修复

- 思维链回传摆放修正：reasoning item 改为**每个 function_call 前各放一条**——DeepSeek 思维模式要求每个工具调用都有紧邻的完整思维链，function_call_output 会打断关联链，1.3.7 只在 assistant 消息前放一条，多工具调用轮仍必 400「The `reasoning_text` in the thinking mode must be passed back to the API」（摆放规则经真实端点探针逐项验证）。
- 思维链回传被能力声明关闭且历史含同源 thinking 块时，server 日志留一行提示（此前该配置下 DeepSeek 必 400 但无任何可诊断线索）。

### 文档

- 出站代理补充：systemd 服务不继承登录 shell 的代理环境变量（env 模式等于直连，更新检测失败最常见原因）；仅支持 http/https 代理（socks5 拒绝）；低于 1.2.0 无代理支持时的自举更新方法。

## [1.3.7] - 2026-08-04

### 修复

- OpenAI Responses 接口遵循模型目录「思维链回传」设置：开启时历史同源 thinking 块以 reasoning item（`reasoning_text` 明文）回传——DeepSeek 思维模式（如 deepseek-v4-flash）强制要求回传，此前第二轮起必现 400「The `reasoning_text` in the thinking mode must be passed back to the API」；关闭或 OpenAI 官方端点（声明不回传）行为不变。

## [1.3.6] - 2026-08-04

### 修复

- agent bash 持久 shell 不再被分页器挂死：pty 是 TTY，`git log`/`gh` 等会启动 less 等待交互导致命令挂到超时（典型表现：工具调用几十秒无返回）。三种 shell（bash/pwsh/cmd）启动时统一置 `PAGER=cat`、`GIT_PAGER=cat`；人类真终端不受影响。
- 持久 shell 输出清洗对齐 pi：剥离控制字符与 Unicode Format 字符（防二进制垃圾进入上下文），`\r` 统一归一（进度条覆写帧直接拼接，不再残留回车控制符）。

## [1.3.5] - 2026-08-04

### 界面与体验

- 通知中心与快捷键速查并入设置：活动栏铃铛与 `Shift+?`/`/help` 现在打开设置的「通知」/「快捷键」页签，不再使用独立弹层；通知页签进入即全部已读（角标清零），列表交互不变。
- 默认端口统一为 **3210**（launcher 脚本、安装器默认值、`owc run` 默认服务地址、Vite 开发代理此前为 3000，与 server 兜底 3210 不一致）；`OWC_PORT` 覆盖方式不变。

### 新增功能

- 联网搜索模式可选：设置 → 联网服务新增「联网搜索模式」，`local`（默认）保持本地 `web_search` 工具经联网服务商执行；`model-api` 由模型服务商在服务端执行搜索（仅 OpenAI Responses 接口生效，如 DeepSeek 的官方搜索工具；此时本地 `web_search` 不再注入），搜索过程以实时活动形式展示。亦可用 `OWC_WEB_SEARCH_MODE` 配置。

## [1.3.0] - 2026-08-04

界面设计语言统一专项：引入可复用交互基元（弹层、确认框、徽标、输入框、折叠行、空态/错误态），全面 token 化（字号、圆角、阴影、遮罩、diff 色、z-index），并修复一批界面瑕疵与可靠性问题。

### 新增功能

- 初步添加linux版对arm和龙芯的适配

### 界面与体验

- 新增设计基元：`Overlay` 弹层组件（Esc/背板关闭、焦点循环与归还）统一命令面板、Quick Open、快捷键速查、通知中心、代码视图五个弹层；`ConfirmDialog` + `useConfirmDialog` 取代全部原生 `window.confirm`；`.pill` 徽标、`.input` 输入框、`.collapse-row` 折叠行、`.composer-popup` 建议弹层、`.muted-empty` 空态、`.panel-error` 行内错误（带 `role="alert"`）六套样式基类收敛全站重复实现。
- 视觉语言 token 化：字号半点值归入整数阶梯（新增 `--text-2xs`）、`font-weight` 统一 600、圆角收敛为 `--radius-s/--radius/--radius-l/--radius-xl` 四档、弹层阴影 `--shadow-lg` 与遮罩 `--backdrop` 按主题定义、diff 颜色（`--diff-add/del-bg/text`）亮暗分主题、z-index 归为 11 档分层变量、内容宽度 `--content-max`。
- 可访问性：键盘可见焦点补齐五处缺口（模式下拉、弹层输入、会话内搜索、工作区区域、开关控件）；次级文字 `--text-3` 两主题对比度提升至 WCAG AA 档；Unicode 字符图标（✓✗●○■ 等）全部迁入描边 SVG 图标组件，EmptyState 步骤序号改 CSS 计数器。
- 修复：快捷键 Ctrl+P 与浏览器默认冲突（`defaultPrevented` 检查）、触屏设备 hover 不可达的操作按钮兜底、通知/Toast 错误态样式、徽标在窄屏的截断、自定义强调色非法值残留（回落 graphite）、on-accent 文字色改 WCAG 对比度计算。

### 服务端修复

- 快照后端支持显式 pin zfs（此前仅 auto 探测链支持）；`defaultEffort` 存储前校验枚举，非法值（如环境变量直写）不再带进运行时。
- 中断补写失败落 stderr 留痕（不再静默，provider 400 可诊断）；OpenAI Responses 接口同一 call_id 重复的 function_call 只内联一次（避免被 API 拒绝）。

### CI 与打包

- loongarch64 交叉构建产物强制校验目标架构 ELF（防 toolchain 静默回落主机编译器）；bundled Node 哈希校验左锚加固；手动下载示例改 `<arch>` 占位。

## [1.2.0] - 2026-08-03

Linux 体验与功能专项：快照新增 overlayfs 后端（原语下沉 core C 层）、出站代理设置、安装器 systemd 更新/重装判定、沙盒能力误报修正与界面平台适配。

### 快照

- 新增 overlayfs 快照后端（Linux）：core 新增 `overlay.mount` / `overlay.checkpoint` / `overlay.restore` / `overlay.unmount` 原语（root 走内核 mount，rootless 走 fuse-overlayfs，检查点 reflink 复制优先），`core.ping` 上报 `features.overlay`。探测链变为 btrfs → zfs → overlayfs → git-shadow；ext4 用户不再只有线性成本的 git shadow。会话在 merged 视图中工作、源目录只读，改动在文件面板确认后手动同步回源（复用托管工作区同一套机制）；有运行中任务时回滚返回可读错误。

### 网络

- 新增出站代理设置：关闭 / 跟随环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`）/ 自定义三模式，自定义支持 HTTP、HTTPS 代理与例外列表（后缀/精确/通配匹配，回环默认绕过）。作用于模型 API、联网搜索/抓取、更新检测与在线更新；界面保存热生效，代理凭据脱敏不出服务端。亦可用 `OWC_PROXY_*` 环境变量配置。

### 安装与更新（Linux）

- 安装器解析既有 systemd unit 的启动路径：同路径判定为更新（保留服务启用状态与启动器变量，一次确认），不同路径提示「切换服务 / 仅装文件 / 中止」，防止双安装抢端口；未检测到可用的 systemd 时不再询问写服务。
- 重跑 install.sh 保留启动器中已设置的端口、数据目录、监听地址与 pin 的系统 Node（命令行显式参数仍最优先）。
- 在线更新修复重启竞态：`Restart=on-failure` 下 clean exit 不拉起、`try-restart` 对已停止服务无效，此前更新后服务可能停在停止状态；同时支持系统级 unit 自动重启。`--use-system-node` 安装更新不再重复复制约 100MB 的 Node 运行时。
- 安装结束检测 `<prefix>/bin` 是否在 PATH 并给出 export 指引；新写 systemd unit 增加加固指令（`NoNewPrivileges` 等）；卸载提示 `loginctl disable-linger`。

### 沙盒与界面平台适配

- 修复 Linux 沙盒能力误报为「兼容模式（Job Object，无文件系统隔离）」——实际为 Landlock，界面与 capability 上报现已一致；界面按平台出文案：Linux 显示 Landlock 语义、隐藏 AppContainer / Windows Sandbox / Bind Link 选项与提示，shell 选择器隐藏 CMD / PowerShell。
- Landlock 强制模式新增 `/tmp`、`/dev` 读写与 `/proc`、`/sys` 只读豁免：沙盒内 mktemp、编译器中间文件、测试框架不再批量 EACCES。
- exec 的内存 / 进程数限制在 Linux 经 setrlimit 落地（此前被静默忽略）；`fs.stat` 修改时间在 Linux 提供毫秒精度。

### 安全与其他

- 数据目录 0700，服务商配置（明文 API Key）、设置文件、会话转录等敏感文件 0600（POSIX 新写入生效）；core stderr 归档 `<数据目录>/logs/core.log`（5MB 轮转，保留一代）。
- 优雅退出加固：第二次 Ctrl+C 立即强制退出、shutdown 5 秒超时兜底、POSIX 接入 SIGHUP；默认 corePath 按平台区分（修复 Linux 手动启动默认指向 `.exe`）。

## [1.1.1] - 2026-08-02

设置界面重组与提示词配置扩展：联网服务与模型选择独立成页，提示词支持全局/项目两级与更多配置面；移动端密度进一步优化。

### 界面与体验

- 移动端密度优化：零计数芯片（含「定时」）整行隐藏、会话信息条单行紧凑（过长省略号收缩）、Composer 控制行收档（长模型名省略号）、消息区侧距与 Markdown 表格降档；修复空输入框常显滚动条轨道的问题。
- 设置页签拆分：新增「模型选择」（会话默认 + 四档角色 + 快速模型）与「联网服务」（联网服务商与 search/fetch 当前配置）两个独立页签，「模型目录」保留模型服务商与目录同步。

### 提示词

- 提示词设置升级为「全局 / 当前项目」两级作用域，并新增两个配置面：**身份行**与**子代理附加指令**（连同基线覆盖、追加指令共四面）。项目级逐面覆盖全局，优先级 env-sim persona > 项目 > 全局 > 内置，保存即热生效；子代理附加指令对 explore/general/自定义子代理统一生效。

### 变更与修复

- 移除「快速模型最大输出上限」设置项：输出上限改由各任务按需指定（压缩 2048、翻译 4096、审核 256 等），不再受全局钳制；残留的用户覆盖值自动清理。
- 修复扩展私有存储在 Linux 不拒绝 `C:/` 形态路径的跨平台校验漏洞。
- 修复 core `pty.input` 在 ptyId 未找到分支的 3 字节内存泄漏（CI ASan 任务检出）。

## [1.1.0] - 2026-08-02

多模型角色与工程化专项：新增四档模型角色与会话默认模型，子代理可按任务下发到不同模型执行；SCM 与文件预览大幅增强；第三方扩展 API 面向官方扩展能力看齐；修复快照回退后无法继续等一批问题。

### 模型与服务商

- 多模型四档角色：极致（高智能）/ 平衡 / 快速 / 廉价，在「设置 → 模型选择」分别指派到任意已启用服务商的模型。`spawn_task`/`spawn_swarm` 子代理可按任务用 `role` 参数选择角色下发；自定义子代理 frontmatter 新增 `role:` 与 `provider:` 声明；用量与成本按实际生效的服务商与模型归属。
- 新增「会话默认模型」设置项：新会话默认模型不再固定取第一个服务商的第一个模型。
- 设置「模型接入」重组为「模型选择」（会话默认 + 四档角色，快速模型设置并入）与「模型目录与同步」两组。

### SCM 与文件预览

- SCM 面板支持行内 stage / unstage / discard（删除未跟踪文件需二次确认），新增提交历史区与 worktree 一键合回（冲突结构化展示）。
- agent 写文件或编辑器保存后 SCM 面板自动刷新，不再过期。
- 文件预览：超过 2000 行可「加载更多」分页续读；图片直接预览（png/jpg/gif/webp/svg/ico/bmp）；Markdown 渲染/源码双态；一键在编辑器中打开；未跟踪文件点开显示内容而非空 diff。

### 扩展

- 第三方扩展 API 面向官方扩展能力看齐：私有存储（extensions-data，单文件 1 MiB、总量 50 MiB）、REST 路由注册（`/api/ext/<id>/*`，`http:route` 权限）、模型调用通道（`model:fast` 权限）、提示词与工具塑形权限（`prompt:shape` / `tools:shaping`，不再官方独占）、会话级扩展状态（extensionState）。附 `examples/extensions/demo` 示例扩展与重写后的扩展开发文档。

### 性能与修复

- agent 的 glob/grep 工具切换到 core 四线程并行搜索 job：大仓库搜索提速且不再阻塞 core 主循环；老 core 按能力协商自动回退，工具行为不变。
- 修复快照回退后无法继续：回退进行中发消息返回 409（不再静默进队列）、回退完成后回收持久 shell、openai 系 SSE 流新增 idle 超时（默认 300 秒，仅 data 事件续命，半开连接可重试恢复；`OWC_PROVIDER_STREAM_IDLE_MS` 可调，0 关闭）。
- 修复索引重建对真实 core 必败（job.output 参数越界且输出未做 base64 解码），诊断与 SCM 的同类输出解码问题一并修复，并补充真实 core 端到端测试守住该链路。
- core 新增 `fs.readBase64`（20 MiB 上限，root-bound），为图片预览供数。
- 新增 10 万文件级索引基准，接入发布性能门禁（10 万文件/21 万符号下查询 p95 约 41ms）。

### 界面与其他

- 移动端：抽屉遮罩、紧凑顶栏、状态栏并入底部面板标签条、Popover 视口自适应、iOS 安全区适配。
- 新增 `agentMaxTurns` 设置项（1–1000，热生效，可用 `OWC_AGENT_MAX_TURNS` 覆盖）。
- 工程化：server/web 接入 ESLint 并纳入 CI 强制、依赖审计与测试覆盖率上传（非阻断）、Dependabot 周更、core 增加 clang-tidy 与 Linux ASan CI 任务、`.gitattributes` 固化换行符规则。

## [1.0.1] - 2026-08-01

安装与局域网访问体验专项：局域网访问从「手工配置三个环境变量」收敛为「改一个监听地址」，Linux 安装器补齐 root/systemd/防火墙/卸载全链路。

### 安装与局域网访问

- 非回环监听开箱可用：未显式配置时访问令牌由服务端首次启动自动生成并持久化（`<数据目录>/access-token`，0600），启动后控制台打印带令牌的一键访问链接；`OWC_ACCESS_TOKEN`（≥32 字符）仍可显式覆盖。
- 浏览器来源校验缺省同源自动放行（与访问地址同源的 origin 直接放行），不再强制手工配置 `OWC_ALLOWED_ORIGINS`；显式设置时维持严格列表。
- 设置 → 远程访问新增「访问链接」卡片：令牌 masked 展示、链接逐条复制、首条链接二维码（手机扫码即登录）；自动生成的令牌可一键重新生成，旧链接与已登录设备立即失效。
- Linux 安装器：root 系统级安装（默认 `/usr/local` + `/var/lib/openwebcode`，`--system` 显式声明）；`--with-systemd` 按 root/用户分层写 unit；`--enable-service` 立即启用并启动服务；`--lan` 一键开启局域网访问；`--open-firewall` 自动放行防火墙端口（firewalld/ufw）；局域网安装结束时直接打印访问链接。
- Linux 卸载脚本：安装时落盘 `<prefix>/bin/owc-uninstall`（发行包同附 `uninstall.sh`），停止并移除 systemd 服务、删除运行时与启动器；数据目录默认保留，`--purge-data` 一并删除，`--remove-firewall` 移除防火墙规则。
- Windows MSI 完成页新增默认勾选的「Launch OpenWebCode」：安装结束即启动服务并打开浏览器。

### 修复

- 设置对话框搜索框：通用对话框输入规则覆盖了搜索框内边距，导致搜索图标与占位文字重叠；恢复图标左侧 28px 让位。

## [1.0.0] - 2026-08-01

首个公测版本。本节为完整项目发版日志，按主题汇总 0.1.0 首个公开版本以来的全部能力；逐版本明细保留在下方各节。

### 核心能力（Agent 与会话）

- 浏览器打开即用的 AI 编码工作台：三层架构（React WebUI ─ Node 服务层 ─ C 执行器 core），Windows/Linux 原生支持，自带沙盒隔离、快照回滚与上下文管理。
- 完整 Agent 工具链：文件读写/编辑、bash、glob/grep、任务清单、长期记忆、文件引用、Shell 快捷命令、网络抓取与可插拔搜索。
- 会话树导航：任意用户消息可分叉、编辑后重发、对 assistant 回复重新生成；会话从线性历史升级为树。
- 消息记录父消息/运行/轮次归属并可在时间线查看；持久化运行队列支持查看、重排、取消与安全插队。
- `ask_user` 结构化提问：agent 运行中发起带选项的提问（单选/多选/自定义输入），回答持久化并注入后续轮次。
- 三种 agent 模式：code（默认）/plan（结构化批准流：批准/编辑后批准/拒绝三分支）/goal（主模型自评未达成自动续跑，最多 10 次）。
- 四级权限档：逐次确认 / 接受编辑 / 模型审核（review，低风险自动放行留审计、高风险转人工）/ 完全自主；权限与沙盒正交。
- 子代理体系：`spawn_task` 单任务与 `spawn_swarm` 并行集群（2-16 项、并发上限 4、逐项指定 agent）、explore 只读与 general 通用两类内置类型、实时卡片与标签页转录、共享讨论板、WebUI 手动启动。
- cron 定时任务（会话内 5 字段，持久化并注入 follow-up 队列）；Hooks 全事件与桌面通知；agent bash 持久 shell（cd/env 跨调用保持）。
- Skills、MCP（stdio + Streamable HTTP）、Hooks、自定义子代理、自定义斜杠命令与独立 Extension Host；官方扩展：PDF to Image、env-sim 环境模拟、owc-eval 评测。
- `owc run` 非交互 CLI（--json 出 NDJSON，面向 CI），中英双语帮助与版本输出。

### 上下文工程

- 上下文账本与窗口管理、两种压缩策略、选择性 pin/排除、分段 token 成本归因、Provider prompt-cache 断点。
- 工具结果滚动驱逐：lag 按轮计（默认 2）、当轮保护、豁免下限（小结果与短文件始终保留）、read_file 头 50 + 尾 50 行摘录降级、「默认节省」占位符与「超级节省」双模式，阈值会话级热调。
- 上下文窗口可视化：占用表、分段归因条、缓存命中胶囊与水位提示（建议压缩/强制压缩）。

### 模型与服务商

- 多配置服务商注册表：Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种接口；多配置联网服务商（Jina / Brave / Tavily / Custom，Search 与 Fetch 分能力声明）。
- 模型目录：远程同步、持久化与手动编辑；能力声明覆盖思考/力度/文本图片视频输入/图片输出/工具/reasoningContent，逐模型覆盖；未声明模型默认上下文 256k，deepseek 前缀 1M。
- 思维链保留回传（reasoning_content）、服务商自定义请求体（extraBody）、输出长度默认不封顶；快速模型复用服务商配置并可独立设置思考与上限；Provider 并发控制（FIFO 排队）。

### 界面与体验

- 五区工作台（活动栏/侧栏/主区/底部面板/状态栏）、命令面板、Quick Open、统一快捷键注册表与通知中心。
- Monaco 编辑器与统一 diff：逐 hunk 接受/拒绝、保存快捷键、SHA-256 条件写（并发修改返回 409）。
- 诊断闭环 `test_runner`（Vitest/Jest、pytest、Go test、.NET test）与 Problems 面板；Git 集成（status/diff/commit、worktree）与 SCM 面板；代码库索引（core index.scan、九语言符号提取、code_search、repo_map）。
- 思考/正文/工具调用按真实顺序交织渲染，相邻工具调用合并折叠组，流式正文平滑追加；对话轮次深浅成组、层级递进，亮暗主题自适应。
- 会话管理：重命名/置顶/分页加载/导入导出（HTML/JSONL/Markdown）；首次引导三步上手、服务商测试连接、设置搜索与深链。
- 高频操作：输入历史召回、Esc 中断、代码块悬停复制、断连横幅、草稿按会话持久化、对话内搜索、Ctrl+P 快速切换模型。
- 真终端面板（core PTY：打开/输入/缩放/关闭与输出/退出通知）；Bind Link 目录绑定（Windows 11 24H2+，新建会话可视化编辑器，沙盒面板展示生效绑定）。
- 英文界面与中英双语文档（首次访问按浏览器语言选择）；移动端单列响应式与 PWA 安装。

### 安全与沙盒

- 沙盒后端：Windows AppContainer / Windows Sandbox（一会话一 VM）/ Job Object（1.0 起为 Windows 默认）/ Linux Landlock；能力状态如实上报（enforced/partial/advisory）。
- 路径策略 deny > write > read 固定优先级，文件原语 root-bound + no-follow/reparse 防护；deny 变形路径绕过、`.owc` 可信来源、会话导入清洗等安全复核结论均已固化。
- 非回环监听强制 ≥32 字符访问令牌 + 合法 origin 白名单；TOTP 全局登录（票据滑动 12h、失败锁定）；WS 握手三重校验；loopback Host 校验封 DNS rebinding 入口。
- 出站网络统一收口 Node：超时/重试/大小上限/SSRF 防护（手动重定向逐跳复验 + DNS 解析逐 IP 复验）/UA 注入/脱敏；MCP 子进程环境白名单；WebUI CSP 与 nosniff 响应头。
- 权限链加固：bash 前缀规则词边界匹配、控制字符类补 CR（封堵 cmd 拆命令绕过）；Hooks 明确等同 yolo 信任级。

### 快照与工作区

- 自动与手动检查点、时间线回滚；Btrfs/ZFS/ReFS 原生快照探测链 + git 影子仓库兜底。
- VHDX/qcow2 托管工作区（稀疏镜像盘隔离）与同步回源：三方差异预览 + 手动确认，默认只写无冲突改动，关闭/删除会话不自动覆盖源目录。

### 性能

- 会话解析 LRU 缓存（单轮总耗时 -74.9%）、流式增量 Markdown（平方级降为近线性）、EventBus 单次序列化、buildView 增量路径、索引追加只扫新增字节（p50 13.59→1.40ms）。
- core 并行 grep/glob（4 worker、确定性排序、预算/取消/no-follow 语义保留）与可取消后台作业控制。
- 实测：5000 消息 59.88fps、输入回显约 25ms、长历史缓存分页 p50 0.58ms；完整基准体系（固定 seed、真实 server + Playwright、回归 >15% 标红）。

### 发布工程

- Windows MSI（可选桌面快捷方式与 PATH）与 Linux tar.gz；`install-online.sh` 一条命令安装/升级，SHA-256 强制校验；WebUI 在线更新（MSI 覆盖 / tar 替换）。
- 四个独立 CI 工作流 + 发布流水线：测试网关、版本三方一致性校验（server/web package.json 与 CMake 基版本，含手动触发）、CHANGELOG 段落提取为发布说明、bundled Node SHASUMS 校验、MSI 数据库门禁、基准门禁（相对回归警告 / 绝对验收阻断两层）。

### 升级说明

- 从任意旧版本直接覆盖安装即可，数据目录与设置自动保留。
- Windows MSI 未做 Authenticode 签名，首次安装/升级可能被 SmartScreen 提示；发布资产（MSI/tar.gz）带 SHA256SUMS.txt，安装与在线更新流程均强制校验。

## [1.0.0-beta.5] - 未发布（已并入 1.0.0）

### 新增

- Shell 后端探测与 Git Bash 支持：Windows 默认命令后端按 `pwsh > Git Bash > cmd.exe` 探测取首个可用项（Git Bash 解析为 Git for Windows 的 bash.exe 绝对路径，排除 WSL 的 `System32\bash.exe`），Linux 按 `bash > pwsh > $SHELL`（`/bin/sh` 兜底）；会话 `shellBackend` 意图扩展为 `default/pwsh/bash/cmd`（界面仍暴露「默认 / PowerShell 7」两档）。core `exec.run`/`job.start` 新增 `shellBackend:"bash"` 与 `shellPath`（host 探测到的显式解释器路径），`core.ping` 上报 `features.shellBash`；bash 工具描述按平台与实际解释器生成（Git Bash 下提示 POSIX 语义）。
- OpenAI Responses 接口类型：模型服务商新增第三种接口（`POST {baseURL}/responses`，流式）；思维以 reasoning summary 流返回，历史思维链不回传（Responses 的思维回放依赖服务端 reasoning 机制）。
- Bind Link 目录绑定（Windows 11 24H2+）：创建会话的 REST 入参 `bindLinks`（≤16 项，`virtPath`/`backingPath`/`readOnly?`）把会话工作区内的虚拟路径透明绑定到外部真实目录，面向共享依赖缓存；创建绑定需 server 以管理员权限运行，`core.ping` 上报 `features.bindLink`，wsb 模式不支持；绑定全系统可见，会话清理时撤销，异常退出最迟重启失效。

### 界面与体验

- 思考、正文与工具调用按真实产生顺序交织渲染；相邻的连续工具调用（≥2 个）自动合并为「N 个工具调用」折叠组，组内一调用一行。
- 流式正文按增量平滑追加，长输出不再整段重排。

### 文档

- 根 README（中英）、`docs/`、`help/` 精简重写并同步本轮变化；删除空文件 `docs/review.md`。

## [1.0.0-beta.4] - 2026-07-31

### 新增

- TOTP 全局登录认证：非回环监听场景的访问控制，凭据 `totp.json`（0600），票据滑动 12h。
- core PTY RPC 与真终端面板：PTY 打开/输入/缩放/关闭与输出/退出通知，能力经 `core.ping` 上报。
- plan 模式结构化批准流：`exit_plan_mode` 提交计划，批准/编辑后批准/拒绝三分支，不经权限自动放行。
- goal 目标模式：主模型每轮自评目标达成度，未达成自动续跑（最多 10 次）。
- 模型审核权限模式（review）：低风险由审核模型自动放行，高风险转人工。
- swarm 成员共享讨论板：并行子代理经 JSONL 板面互相分享发现。
- agent bash 持久 shell：cd/env 跨调用保持（沙盒内 PTY）。
- Hooks 事件补全与桌面通知：页面失焦时权限待批/交互待答/run 终态弹系统通知。
- cron 定时任务：会话内 5 字段 cron，持久化并注入 follow-up 队列。

### 界面与体验

- 模型选择器重做：按供应商分组展开收起，底部固定区显示模型能力与思考控件；思考改为胶囊开关，强度改格子档滑动（只显示已声明档位；未声明则全部可选、切换模型不再清除继承值）。
- 模式弹层：code（默认）/plan/goal 与 Swarm 独立开关可叠加。
- 权限档文案：逐次确认/接受编辑/模型审核/完全自主。

### 模型与服务商

- 思维链保留回传：历史 thinking 块以 `reasoning_content` 回带给 OpenAI 兼容端点（同源 provider）；新增模型能力 `reasoningContent` 声明，gpt/o 系与 claude 默认关闭、其余默认开启，模型目录可逐模型覆盖。
- 服务商自定义请求体（extraBody）：每次请求浅合并自定义 JSON 字段，保留字段禁止覆盖。
- 输出长度默认不封顶：OpenAI 兼容接口不再默认发送 `max_tokens`；Anthropic 保留 API 强制默认值，可经自定义请求体覆盖。
- 未声明模型默认上下文 256k；deepseek 前缀升至 1M（DeepSeek V4）；effort 档新增 ultra。

### 变更

- Windows 默认沙盒模式改为 Job Object（兼容模式）；AppContainer 仍需在会话中显式选择，既有未指定沙盒模式的会话按新默认执行。

### 修复

- 工具结果滚动驱逐重构：lag 改为按轮计（一轮 = 一批连续工具结果）且默认 lag 1 → 2，当轮（模型尚未看到的批次）受保护不再被驱逐；新增驱逐豁免下限（<256 token 的小结果、≤10 行的文件读取始终保留）与 read_file 头 50 + 尾 50 行摘录降级；驱逐占位符改为语义摘要（工具名/大小）并指引模型用 `read_artifact` 自助恢复（原"UI restore action"指引模型无法执行）。以上阈值均可在上下文面板会话级热调。
- 新增「超级节省」驱逐模式（上下文面板/REST 可选，默认仍为「默认节省」占位符模式）：非保留轮的整轮工具过程连同思维链出视图，只留一行不可变摘要（含 artifact 恢复指引），tool_call 大参数（write_file 全文等）不再滞留上下文；回写时双侧配对自动复活。
- bash 工具调用长时间不结束：server 从 Git Bash/MSYS 环境启动时子进程 PATH 里 `usr/bin` 先于 System32，`find`/`sort` 被解析成 MSYS 版本（如 `find /c` 变递归扫盘）导致命令跑飞；现 Windows 下 core 子进程一律前置 System32 恢复内置命令语义，持久 shell 超时错误附带已捕获输出尾部供模型自我纠正。
- 全局 review 修复：权限卡悬挂、幽灵运行态、core 崩溃恢复。
- 子代理思维链回传档位按实际请求模型（modelOverride）取档。
- bash 权限规则词边界前缀匹配。
- 流式渲染改 append-only 分片与增量 Markdown 切分（长会话性能）。

## [1.0.0-beta.3] - 2026-07-29

### 界面与体验

- 会话配置控件重排：模式/模型靠左，思考/权限/高级设置靠右；模式选项缩短为「构建/计划」，模型字段弹性收缩（窄窗口文字标签自动隐藏、高级设置留图标），始终一行；≤480px 堆叠显示。

### 文档

- README 中英与使用文档语气平实化：口号式条目改直接陈述，删除重复内容。

## [1.0.0-beta.2] - 2026-07-29

### 界面与体验

- 对话轮次深浅成组：user 消息开启一轮，奇数轮 assistant/tool 消息底色加深一档与偶数轮交替；每轮首条 user 消息前间距拉开；流式输出跟随当前轮次；子代理标签页与主对话同一轮次规则。
- 层级深浅递进：奇数轮内工具/结果卡底色同步加深（错误卡保持红色）；子代理转录体加深一档，转录内消息按角色深浅交替；全部基于 CSS 变量 color-mix，亮暗主题自适应。
- 会话配置行（模式/模型/思考/权限/高级设置）整体右对齐。
- 「回到底部」按钮不再遮挡正文：滚动区底部留白加大，按钮实底加背景模糊。
- PDF 提示可关闭：关闭状态按扩展状态签名记忆（localStorage），扩展状态变化后提示自动重现。
- 消息操作按钮（复制/翻译/编辑重发/重新生成/分叉等）键盘聚焦可达、触屏常显，补显隐过渡。
- 底部面板状态条去除与头部重复的 tokens/成本显示，保留运行状态/模式/模型/上下文窗口水位。

## [1.0.0-beta.1] - 2026-07-29

首个 1.0 预览版：会话树导航与结构化提问补齐核心交互，文档全面对齐实现。

### 新增

- 会话树导航：任意一条用户消息可分叉（branch）、编辑后重发、对 assistant 回复重新生成；会话从线性历史升级为树，UI 提供分叉点切换与路径指示。
- `ask_user` 结构化提问工具：agent 运行中可向用户发起带选项的结构化提问（单选/多选/自定义输入），回答注入后续轮次。
- 消息导出增加 Markdown 格式（`session-<id>.md`），与既有 HTML/JSONL 并列，导出菜单统一入口。

### 界面与体验

- 对话内搜索：会话内按关键词定位消息并跳转。
- `Ctrl+P` 快速切换模型（循环候选列表）。

### 文档

- 用户文档全面校对：`help/usage.md` 加锚点目录并纠正 10 处与实现不符的描述；`help/development.md` 同步新模块（tool-schemas、session-tree、env-sim、设置拆分）；`help/faq.md` 修正过时答案并新增 5 条 FAQ；README 中英对齐；packaging README 补发布工程说明。

### 发布工程

- release.yml 支持预发布版本：tag 可为 `vX.Y.Z-beta.N`（`package.json` 存完整版本号，`core/CMakeLists.txt` 存数值基版本，一致性检查按基版本比对）；MSI 的 ProductVersion 保持数值、产物文件名携带完整预发布号；带预发布后缀的 Release 自动标记为 Pre-release。

### 升级说明

- 与 0.9.0 相同：Windows MSI 未做 Authenticode 签名，首次安装/升级可能被 SmartScreen 提示；发布资产（MSI/tar.gz）带 SHA256SUMS.txt，安装与在线更新流程均强制校验。

## [0.9.0] - 2026-07-29

### 新增

- 官方扩展「环境模拟」（`env-sim`）：启用并选择预设后，系统提示词切换为该产品风格（身份行 + 工作方式），内置工具以该产品的命名/描述/参数形态呈现（如 `Read`/`Bash`/`Edit`），底层仍走原工具实现与权限链。内置 `claude-code`/`kimi-code`/`zcode`/`codex` 四档预设；自制预设 JSON 放入 `<业务数据目录>/env-sim/personas/` 即可使用并与他人分享。
- 扩展 API 第二批：`prompt.beforeBuild` 钩子（身份行与基线提示词可覆盖，安全约束段仍由核心追加）；manifest `toolShaping`（仅官方扩展：隐藏/别名内置工具，别名保留原权限类别与 plan 门禁）；manifest `configSchema`（设置页渲染 typed 配置表单，server 松散校验）。
- 普通子代理 `general`：内置子代理类型注册表——`explore`（默认，只读探索，行为不变）与 `general`（通用：可读写文件、执行 bash，工具调用经与主代理相同的权限链与同配置沙盒，plan 门禁同源）；`spawn_task`/`spawn_swarm` 的 `agent` 参数与逐项派发均支持。
- WebUI 手动启动子代理：底部「子代理」面板顶部输入任务并选择类型（explore/general/自定义）即可启动，新增 `POST /api/sessions/:id/subagents`（并发上限 4）与 `GET /api/agents`；中断会话同时取消手动子代理。

### 界面与体验

- 运行活动条：对话区底部吸顶显示当前状态（思考中/执行工具/等待确认…）、已耗时长（秒级跳动）与正在执行的工具，空闲自动隐藏。
- 会话打开加载骨架屏，替代欢迎页闪烁；底部面板懒加载增加占位。
- 底部排版合并：状态栏内容（运行状态/模式/模型/token/窗口占用/成本）右移进面板页签条（桌面端），移动端保留原状态栏；去除与头部重复的工作目录显示。
- 子代理标签页与主对话同一渲染（MemoMessageCard 完整转录），低饱和状态色区分子代理标签与「对话」标签；子代理面板可直接手动启动；历史运行不再显示「0 轮」；转录 20 条折叠可展开。
- 对话轮次与层级深浅强调：assistant/tool 消息淡底色，工具卡片缩进并加左侧引导线。

### 性能

- agent 循环每轮两次全量解析消息历史改为会话级缓存（LRU 32，stat 指纹校验 + append-through）：`sessions.get()` p50 8.00→0.41ms（-94.9%），单轮总耗时 -74.9%，5000 消息会话每轮消除约万次 JSON.parse。
- 流式 Markdown 分块增量渲染：稳定块只解析一次，流式每帧仅重渲染尾部块（渲染管线不变），长回答流式主线程占用从平方级降为近线性。
- EventBus 单次序列化（扇出与驱逐复用）；ledger.json 内存缓存（每轮省 3 次原子写）；buildView 增量路径累计化（ledgerKey 惰性化、token/片段缓存、克隆复用）；`evict` 的 mkdir 提出循环；glob 排除正则按模式缓存；视图缓存加 LRU 上限。agent-loop 基准 buildView.p50 0.88→0.30ms。
- 新增 `bench-agent-loop` 基准场景，覆盖真实 agent 循环读路径（原 context-build 基准只喂内存数组，存在测量盲区）。

### 改进

- 设置对话框按页签拆分为独立组件（2038→360 行外壳）；删除死代码（initUserAgent、遗留 job 类型、parsePricingDocument）；格式化助手下沉 `lib/format.ts`；web 依赖清理（移除零引用的 zustand，`@vitejs/plugin-react` 移入 devDependencies）。

### 发布工程

- release.yml 新增 tag 与仓库版本一致性检查（`server/package.json` 与 `core/CMakeLists.txt` 不等于 tag 版本即失败）；bundled Node 下载增加官方 SHASUMS.txt 校验；Release 说明改为从 CHANGELOG 对应版本段提取（缺失或为空则阻断发布），替代自动生成。

### 升级说明

- Windows MSI 未做 Authenticode 签名，首次安装/升级可能被 SmartScreen 提示；发布资产（MSI/tar.gz）带 SHA256SUMS.txt，安装与在线更新流程均强制校验。

## [0.8.0] - 2026-07-28

### 新增

- 上下文窗口可视化：会话头部显示窗口占用 `45k/128k · 38%` 与细条（≥70% 黄、≥85% 红，按「上下文窗口 − 最大输出」的工作预算计），缓存命中胶囊 `缓存 82%`（悬停细分读取/写入/未缓存输入）；上下文面板新增「上下文窗口」区——大号占用表、按段（消息/工具结果/repoMap/压缩摘要/系统/其他）堆叠的 token 归因条与图例、本轮/累计缓存命中、水位提示（建议压缩 / 强制压缩）；状态栏显示 `窗口 N%`。数据来自实时 `context.watermark`/`context.usage` 事件，REST 兜底。
- 子代理实时卡片与 swarm 增强：`spawn_task`/`spawn_swarm` 在消息轨道渲染为实时卡片（swarm 逐项状态 pending/running/done/failed、实时轮次与工具数、生效 agent、逐项转录链接）；转录展示完整内部消息流（折叠到最近 20 轮）。服务端新增 `subagent.progress` WS 事件；`spawn_swarm` 的 items 支持 `{task, agent}` 逐项指定 agent（字符串形式仍兼容）；中断不再启动排队中的 swarm 项。
- 主窗口子代理标签页：子代理启动时在对话列顶部自动建标签（swarm 聚合成一个，不抢焦点，运行/完成/失败状态指示），标签内实时监视逐项进度并展开转录；底部「子代理」面板可对历史运行「在标签中打开」。标签按会话隔离，移动端走底部面板。
- 底部面板「子代理」标签页：会话级子代理监视——全部 `spawn_task`/`spawn_swarm` 按调用分组，swarm 聚合计数（完成/失败/运行中）、实时进度行、内联展开转录；由实时事件与消息历史共同派生，刷新后保留。
- 首次引导与测试连接：未配置服务商时空会话页显示三步快速上手（按钮深链到设置 → 模型目录）；设置对话框支持深链到指定分区；新建会话对话框的无服务商/无模型提示可点击跳转。服务商表单新增「测试连接」按钮与 `POST /api/provider-profiles/test`（openai：GET /models；anthropic：GET /v1/models?limit=1；5 秒超时），错误按认证/URL/不可达/限流分类为中文提示。
- 会话管理增强：会话重命名（双击标题或编辑按钮内联修改，清空可回落派生标题）与置顶（置顶排前），新增 `PATCH /api/sessions/:id`；删除确认改为样式化对话框（运行中会话禁用删除并提示先中断），替代原生 `window.confirm`。

### 界面与体验

- 设置重组：原「服务设置」页签解散——模型服务商/模型接入/快速模型并入「模型目录」，汇率并入「模型定价」，更新检查/执行器/存储并入「服务信息」，语言与货币并入「通用」，监听地址/端口并入「远程访问」；设置搜索与全部深链同步指向新归属。
- 高频操作五项：输入框历史召回（首行或空输入时 ↑/↓ 翻阅，自动暂存当前草稿，IME 组合中不触发）；Esc 中断运行中的 agent（不抢弹窗/对话框/权限卡/编辑器的 Esc）；代码块悬停复制按钮（触屏常显）；WebSocket 断连时显示「连接中断，正在重连…」横幅（1s 防抖）；输入框草稿按会话持久化到 localStorage（刷新恢复，删除会话时清理）。
- 错误可操作化：`agent.error` 事件携带 `kind`（authentication/permission/not_found/invalid_request/rate_limit/overloaded/network 等）与 `retryable`；运行错误卡给出可操作提示与设置深链按钮（认证/接口问题 → 模型目录），可重试的失败提供「重试」按钮（重发上一条用户消息，附件不随重试重发）；toast 改为一行摘要，不再直接展示原始 JSON。
- 更新提醒：启用更新检查且发现新版本时，通知中心出现按版本去重的提醒条目，点击跳转设置 → 服务信息。
- 设置页左侧导航新增搜索框（匹配分区/分组/字段标签，中英文）；页签切换纳入未保存更改确认（含定价 JSON 与提示词编辑）；`/help` 内置输入框命令打开快捷键速查；空会话页示例任务 chips 点击复制到剪贴板并提示。
- CLI：`owc --help` / `owc run --help` 输出中英双语帮助；参数错误退出码改为 1（退出码 2 专属权限拒绝）。

### 修复

- swarm 部分失败在刷新后全部显示为「完成」：工具结果新增 `subagentTasks` 逐项状态（taskId/序号/状态/错误），失败或中断的 spawn 调用也回填转录 id，子代理面板/标签历史不再丢失；失败子代理可展开转录。
- 子代理标签打开期间后台新消息把对话滚动位置清零；关闭的 swarm 标签被后续并发项的 `subagent.started` 重新打开。
- WebSocket 重连退避计数成功后不复位（二次断线直接 10s 起步）；其他会话的权限请求渲染进当前会话（补回归测试锁定既有防护）。
- `owc --version` / `--help` 恒显示 `0.0.0`（CLI 从未初始化版本缓存，v0.7.0 即存在）。
- 跨客户端重命名/置顶不生效（`session.updated` 被当前会话门拦死）；首条消息派生标题不发布事件。
- 设置切换页签静默丢弃未保存编辑；`updateCheckIntervalHours` 无法存 0（服务端本就支持 0=仅手动）且无上限校验；更新检查三个字段缺英文标签。

## [0.7.0] - 2026-07-27

### 新增

- `/init` 内置斜杠命令：分析当前工作区并生成/更新根目录 `AGENTS.md`（项目概述、构建与测试命令、代码组织、约定边界）；走正常 agent 流程，写文件经权限链与自动快照。
- `spawn_swarm` 并行子代理（agent 集群）：按 `prompt_template` + `{{item}}` 占位符 + `items[]` 一次派发 2–16 个只读子代理，并发上限 4、超出自动排队；单项失败不拖垮整批，结论按 `[序号/总数]` 聚合返回。单项任务仍用 `spawn_task`。
- 子代理可见性：新增 `subagent.started` / `subagent.finished` WS 事件与 `GET /api/sessions/:id/subagents/:taskId` 转录接口；`spawn_task`/`spawn_swarm` 工具结果携带转录 id，聊天中可展开「子代理转录」查看 prompt、轮次、工具与结论。
- 扩展 API 第一批：v1 扩展可 `registerTool` 注册 agent 工具（以 `ext__<扩展id>__<工具名>` 注入，与 MCP 工具共用权限链与 plan 模式拦截，单次调用 5 秒超时）、只读访问会话列表/详情（`sessions:read`）、读取上下文视图与 artifact（`context:read`）、订阅 `agent.state`/`tool.*`/`context.*`/`checkpoint.*`/`subagent.*` 事件流；能力调用按 manifest 权限逐项校验，缺权限即报错并如实标记扩展状态。

### 界面与体验

- 会话状态徽章补齐 completed/failed/aborted 中英文标签与语义色（绿/红/黄）。
- 窄屏（≤1024px）顶栏改为标题独占一行、操作区整行左对齐；「回到底部」按钮降级为纯图标并补 aria-label。
- 修复「加载更早的消息」按钮引用未定义 CSS 变量导致的透明背景；设置导航分组加分隔线；底部面板标签栏支持横向滚动、折叠按钮钉在右侧。

### 改进

- 索引符号提取下沉到 core：新增 `job.start kind:"index.extract"`（C 侧手写行匹配器，覆盖既有 9 种语言），server 索引管理器改为单次 job 批量提取，删除 JS 侧逐文件 `readFile` + 正则提取路径（`symbols.ts` 移除）；core 侧自动跳过超大/非 UTF-8/不支持扩展名的文件。

## [0.6.0] - 2026-07-27

### 新增

- 提示词修改：设置页新增「提示词」分组，可覆盖内置系统提示词基线并追加自定义指令；全局存于数据目录 `system-prompt.md` / `system-prompt-append.md`，项目级 `.owc/system-prompt.md` 覆盖全局。提示词不是安全边界，plan 模式/权限/沙箱仍由服务独立强制。
- 更新检查：设置页「更新检查」分组（默认关闭），启用后周期性查询 GitHub Releases 最新版本，结果在「服务信息」静默展示并支持手动「立即检查」与下载链接。
- WebUI 在线更新：设置页发现新版本后可一键更新——Windows 下载 MSI 后启动安装程序并退出当前服务；Linux 替换安装目录内容后自动/手动重启。启动器、systemd unit 与数据目录均保留。
- Linux 在线安装/更新脚本 `packaging/install-online.sh`：`curl | bash` 一条命令完成安装或升级，下载后先经 SHA-256 校验（失败即中止），已安装时进入更新模式替换 `lib/openwebcode/` 并保留启动器与数据目录；该脚本同时作为 release 资产发布。
- 版本号显示：设置页「服务信息」展示 Server/Core 版本与协议版本；CLI 新增 `owc --version`；新增 `GET /api/version`。
- 配置默认值拆分：安装目录 `config/defaults.json` 存放随发布更新的默认配置，数据目录 `server-settings.json` 只存用户覆盖，启动时按 env > 用户覆盖 > 安装默认自动组合；被覆盖项在安装默认变化时会提示「采纳新默认」。

### 改进

- 全部出站 HTTP 请求统一注入 `User-Agent: owc/openwebcode{version}`（LLM provider、MCP、联网工具、定价/汇率/模型目录同步、更新检查）；MCP `clientInfo` 版本号改为读取真实服务版本。
- delta 合批的占位事件不再复制累计文本，长流下每次突发减少 O(delta 数) 次对象分配。

## [0.5.2] - 2026-07-27

### 界面与体验

- 性能面板增加可持久化的实时监控开关；暂停时停止浏览器帧率采样，并暂停性能记录、服务指标和 Provider 状态轮询。
- 工作台在 1024px 以下切换为紧凑顶栏与临时侧栏抽屉，抽屉状态不再污染桌面侧栏偏好；修复窄窗口只剩活动栏、侧栏铺满页面和主区错位。
- Composer 调整为“对话在上、配置在下”：模型框收窄，思考开关与强度合并为单一选择器，次要模型能力收进高级设置，降低横向拥挤。
- 设置页重排分组和滚动边界，长扩展列表仅在内容区滚动，标题与底部操作保持稳定。

### 修复

- 安全：无认证回环模式的普通 HTTP 请求现在同样校验 loopback Host，封住 DNS rebinding 入口；启动 token 不再出现在请求日志，特殊字符 token 可安全写入并读取 HttpOnly Cookie。
- 安全：Windows 后台索引/搜索使用线程隔离的 deny 策略快照，避免并发会话串用路径规则或读取已释放内存；Linux Landlock 正确纳入显式 `allowPaths`。
- Core `session.configure` 改为事务式更新：无效配置不再破坏既有会话，也不会耗尽固定会话槽位；Windows AppContainer 能力探测改为真实创建 profile，失败时如实降级并报告 HRESULT。
- 带 `sessionId` 的 WebSocket 实时流与回放保持同一隔离语义，不再混入其他会话的 `agent.state`/`run.*`；异步发送失败会计数并移除失效连接。
- 切换到不支持当前 thinking/effort 的模型时，在同一次配置请求中清除不兼容值，避免先关思考再换模型的反直觉流程。
- 会话侧栏完整填充已保存的可调宽网格列，消除侧栏加宽后的空白槽和主工作区错位。
- 浏览器内存基准在采样前后主动回收垃圾并使用稳定低水位，避免共享 CI runner 的 GC 时机把正常内存波动误判为回归。

## [0.5.1] - 2026-07-26

### 改进

- 设置页重构为“个人偏好、AI 与服务、能力与连接、系统”四组导航；桌面端采用分组侧栏与固定内容标题，移动端切换为横向分类栏，并补充自然过渡、方向键导航和减少动态效果适配。

### 修复

- 性能基准的慢 WebSocket 客户端场景改用确定性的待发送消息队列触发背压，并为断连等待增加超时，避免 Linux runner 因 TCP 接收窗口差异永久挂起。

### 文档

- 明确 macOS 当前不受支持，避免将缺少原生沙盒后端误解为可正式运行。

## [0.5.0] - 2026-07-26

### 新增

- Monaco 编辑器与统一 diff：工具卡、Problems、SCM、Quick Open 和检查点均可打开懒加载编辑器或分栏 diff；支持逐 hunk 接受/拒绝、保存快捷键、只读/移动端降级，写回继续经过权限与 plan 门禁。
- 会话分页：首屏尾读并可向前加载历史；JSONL byte-offset/message-id 索引以 32 会话 LRU 有界缓存。
- Provider 并发控制：按 provider 设置并发上限，FIFO 排队；`GET /api/providers/stats` 暴露 active/queued/maxConcurrent。
- Core 并行 grep/glob：4 worker 搜索，结果确定性排序，并保留预算、取消、include/exclude 与 no-follow 语义。
- 性能诊断：底部面板展示渲染帧率、事件吞吐和 Turn 各阶段耗时；采样不包含消息内容、路径或模型名。
- 官方评测扩展 `owc-eval`：默认关闭；内置 3 个基础 mock-provider 示例与 1 个 0.4 回归契约任务，通过隔离工作区回放真实 AgentRunner。报告包含断言、工具轨迹、turn、token 与耗时，支持基线/候选对比和自包含 JSON 导出。

### 性能

- 活跃会话追加消息时，索引先校验旧 EOF 尾部，再只扫描新增字节；5000 消息基准的追加刷新 p50/p95 从 13.59/21.44ms 降至 1.40/1.64ms。
- 浏览器 5000 消息实测保持 59.88fps，输入回显约 25.2ms；长历史缓存分页 p50 为 0.58ms。

### 修复

- 编辑器写回增加 SHA-256 条件写；文件被并发修改时返回 409，不再静默覆盖。
- SCM 正确解析 `git status --porcelain=v1 -z` 的重命名/复制记录与特殊文件名；worktree 合并支持多提交分支，不再只 cherry-pick 单一提交。
- 取消尚在 Provider 并发队列中的请求会立即移除并拒绝，不再等到获得槽位后才响应。

### 发布工程

- Release 性能基准改为硬门禁：缺失上一 release 基线或任一可比指标回归超过 15% 都会阻断发布；首次建立基线必须显式启用 bootstrap。
- 发行产物归档基准 JSON，供下一版本直接比较。
- 手动触发 release workflow 时可显式启用 `skip_performance_tests` 跳过性能基准；默认仍执行，tag 触发不可跳过，跳过时不会生成或发布基准 JSON。

## [0.4.0] - 2026-07-25

### 新增

- 工作台重构为活动栏、侧栏、主区、底部面板和状态栏五区；新增命令面板、Quick Open、统一快捷键注册表与通知中心。
- 诊断闭环新增 `test_runner`，自动识别 Vitest/Jest、pytest、Go test 和 .NET test；统一 Problems 面板与 Shiki 只读代码视图。
- Git 集成新增 `git_status`、`git_diff`、`git_commit` 与 worktree 管理；SCM 面板展示分支、ahead/behind 和分组变更，提交始终需要确认。
- 代码库索引新增 Core `index.scan`、八种语言符号提取、`code_search` 和 `repo_map`；索引通过 Core watch 增量更新，损坏时完整重建。
- 上下文工程新增增量构建、Provider prompt-cache 断点、选择性 pin/排除和分段 token 成本归因。
- 非回环监听强制使用至少 32 字符的 `OWC_ACCESS_TOKEN`；浏览器通过 HttpOnly Cookie、CLI 通过 Bearer token 认证。
- 移动端提供单列响应式工作台与 ≥44px 交互目标；PWA manifest 支持安装到主屏，不启用不适用的离线缓存。

### 性能与稳定性

- `fs.watch.poll` 将同目录的突发事件折叠为目录级 changed 事件，降低构建目录事件风暴。
- 上下文构建复用连续 turn 的不可变前缀；事件 delta 合批并对慢客户端执行有界背压。
- 设置页新增快捷键和远程访问分区；无索引、无 Git 或功能不可用时，各面板提供明确降级状态。

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
