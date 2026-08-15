# 常见问题（FAQ）

按主题分组。操作入口和逐步说明见 [`usage.md`](./usage.md)。

## **目录**：

1. **通用（16）：**
[关闭浏览器标签页后，agent 还在运行吗？](#q-关闭浏览器标签页后agent-还在运行吗) | [agent 一直显示「正在输出」但没有内容，是卡死了吗？](#q-agent-一直显示正在输出但没有内容是卡死了吗) | [支持哪些平台？](#q-支持哪些平台) | [端口 3210 被占用怎么办？](#q-端口-3210-被占用怎么办) | [数据存在哪里？](#q-数据存在哪里) | [如何升级？](#q-如何升级) | [怎么知道有没有新版本？](#q-怎么知道有没有新版本) | [升级后我的设置会被覆盖吗？](#q-升级后我的设置会被覆盖吗) | [能自定义系统提示词吗？](#q-能自定义系统提示词吗) | [离线模式是干什么的？](#q-离线模式是干什么的) | [下载的发布包怎么校验完整性？](#q-下载的发布包怎么校验完整性) | [cron 定时任务在重启 server 后还在吗？](#q-cron-定时任务在重启-server-后还在吗) | [如何分叉或重新生成一段对话？](#q-如何分叉或重新生成一段对话) | [Chat 模式是什么？怎么开启？](#q-chat-模式是什么怎么开启) | [Chat 模式的数据和工作台互通吗？](#q-chat-模式的数据和工作台互通吗) | [Chat 分享链接安全吗？](#q-chat-分享链接安全吗)
2. **模型与服务商（11）：**
[支持哪些 LLM 服务商？](#q-支持哪些-llm-服务商) | [模型列表为空或刷新失败？](#q-模型列表为空或刷新失败) | [会话中途能换模型吗？](#q-会话中途能换模型吗) | [主模型报错了能自动换别的模型吗？](#q-主模型报错了能自动换别的模型吗) | [为什么有些模型不能调用工具？](#q-为什么有些模型不能调用工具) | [为什么没有 `web_fetch` 或 `web_search`？](#q-为什么没有-web_fetch-或-web_search) | [怎么用模型服务商自带的联网搜索（比如 DeepSeek 的 `web_search`）？](#q-怎么用模型服务商自带的联网搜索比如-deepseek-的-web_search) | [thinking / reasoning 怎么开？](#q-thinking--reasoning-怎么开) | [对话支持 Markdown 和数学公式吗？](#q-对话支持-markdown-和数学公式吗) | [agent 运行报错（认证失败 / 限流 / 过载）怎么办？](#q-agent-运行报错认证失败--限流--过载怎么办) | [缓存命中能降低成本吗？](#q-缓存命中能降低成本吗)
3. **权限与沙盒（8）：**
[ask / acceptEdits / review / yolo 有什么区别？](#q-ask--acceptedits--review--yolo-有什么区别) | [「允许一次」和「总是允许」有什么区别？](#q-允许一次和总是允许有什么区别) | [agent 的 bash 是每次新开一个 shell 吗？](#q-agent-的-bash-是每次新开一个-shell-吗) | [yolo 了还会被沙盒拦吗？](#q-yolo-了还会被沙盒拦吗) | [沙盒的网络三档 allow / deny / filtered 是什么？](#q-沙盒的网络三档-allow--deny--filtered-是什么) | [agent 要写沙盒外的路径怎么办？](#q-agent-要写沙盒外的路径怎么办) | [跑不可信代码怎么配置？](#q-跑不可信代码怎么配置) | [agent 提交 git 需要我确认吗？](#q-agent-提交-git-需要我确认吗)
4. **上下文与快照（9）：**
[上下文满了怎么办？](#q-上下文满了怎么办) | [驱逐掉的内容还能找回来吗？](#q-驱逐掉的内容还能找回来吗) | [`/clear` 会丢历史吗？](#q-clear-会丢历史吗) | [快速模型是什么？必须配置吗？](#q-快速模型是什么必须配置吗) | [怎么调整上下文驱逐与压缩？](#q-怎么调整上下文驱逐与压缩) | [检查点什么时候自动打？](#q-检查点什么时候自动打) | [回滚会丢会话历史吗？](#q-回滚会丢会话历史吗) | [快照回退后可以马上继续对话吗？](#q-快照回退后可以马上继续对话吗) | [托管工作区是什么？什么时候用？](#q-托管工作区是什么什么时候用)
5. **子代理与扩展（6）：**
[八个官方扩展分别做什么？](#q-八个官方扩展分别做什么) | [子代理能写文件吗？](#q-子代理能写文件吗) | [怎么手动启动一个子代理？explore 和 general 选哪个？](#q-怎么手动启动一个子代理explore-和-general-选哪个) | [环境模拟（env-sim）预设怎么用？能自制吗？](#q-环境模拟env-sim预设怎么用能自制吗) | [Hooks 安全吗？](#q-hooks-安全吗) | [MCP 工具能写文件吗？](#q-mcp-工具能写文件吗)
6. **CLI 与脚本集成（4）：**
[`owc run` 怎么在 CI 里用？](#q-owc-run-怎么在-ci-里用) | [`owc run` 会创建新会话吗？](#q-owc-run-会创建新会话吗) | [怎么限制 agent 能用的工具？](#q-怎么限制-agent-能用的工具) | [Windows 下 `owc run` 报找不到命令？](#q-windows-下-owc-run-报找不到命令)
7. **故障排查（14）：**
[Linux 的 `install.sh` 会在 CI 或脚本里等输入吗？](#q-linux-的-installsh-会在-ci-或脚本里等输入吗) | [启动后浏览器打不开 / 连接被拒？](#q-启动后浏览器打不开--连接被拒) | [什么时候需要登录（访问令牌 / TOTP）？](#q-什么时候需要登录访问令牌--totp) | [为什么看不到终端页签 / 终端不可用？](#q-为什么看不到终端页签--终端不可用) | [TOTP 丢了（换手机 / 卸载认证器）怎么办？](#q-totp-丢了换手机--卸载认证器怎么办) | [手机上能用吗？](#q-手机上能用吗) | [命令面板和快捷键有哪些？](#q-命令面板和快捷键有哪些) | [怎么在对话里搜索内容、快速换模型？](#q-怎么在对话里搜索内容快速换模型) | [test_runner 支持哪些测试框架？](#q-test_runner-支持哪些测试框架) | [索引没建或损坏时 agent 还能搜代码吗？](#q-索引没建或损坏时-agent-还能搜代码吗) | [WebSocket 断线重连后会丢事件吗？](#q-websocket-断线重连后会丢事件吗) | [core（C 执行器）崩溃了怎么办？](#q-corec-执行器崩溃了怎么办) | [沙盒导致某些命令失败？](#q-沙盒导致某些命令失败) | [后台任务在 Linux 上 kill 后子进程还在？](#q-后台任务在-linux-上-kill-后子进程还在)
8. **[反馈与贡献](#反馈与贡献)**

## 通用

### Q: 关闭浏览器标签页后，agent 还在运行吗？

还在。任务跑在 server 端，结果照常落盘；重新打开 UI 选回会话，断线期间的事件会自动补拉。要主动停就点顶部「中断」，或 `POST /api/sessions/:id/abort`。只有退出 server 进程才会收尾全部会话和后台任务。

### Q: agent 一直显示「正在输出」但没有内容，是卡死了吗？

多半是模型流在代理或网关上挂成了半开连接：心跳还在滴，内容永远不来。服务端对 SSE 流有 5 分钟无 data 事件即判半开的兜底（心跳注释不续命），超时后自动重试，最终失败会以错误收尾，会话可以继续。思考型模型长时间静默被误伤的话，用环境变量 `OWC_PROVIDER_STREAM_IDLE_MS`（毫秒，0 为关闭）调大上限；或者点「中断」直接结束本轮。

### Q: 支持哪些平台？

Windows (x86-64) 和 Linux (x86-64 / arm64 / loongarch64) 原生支持。沙盒：Windows 默认 Job Object，可选 AppContainer / WSB；Linux 默认 bubblewrap，没有 bwrap 的环境自动回落 Landlock（会如实上报 partial）。macOS 暂不支持。

### Q: 端口 3210 被占用怎么办？

设环境变量 `OWC_PORT=4000` 再启动 `owc`。launcher 和 server 的默认端口统一是 3210。

### Q: 数据存在哪里？

`OWC_DATA_DIR` 优先；没设就用启动器注入的平台默认值（Windows `%USERPROFILE%\openwebcode`，Linux `~/.local/share/openwebcode`）；只有绕过启动器直接 `node server/dist/index.js` 时，才兜底到 `server` 旁边的 `.openwebcode`。设置文件是 `<数据目录>/server-settings.json`，会话在 `<数据目录>/sessions/<id>/`。详见 [usage.md 的配置文件位置](./usage.md#配置文件位置)。

### Q: 如何升级？

Windows 重新下载 MSI 双击安装（major upgrade 原地升级，用户数据保留）；Linux 重新解压 tar.gz 覆盖安装目录，或重跑一行在线安装脚本。也可以在设置 → 服务信息里一键在线更新：下载发布包后先过 SHA256 校验再替换。卸载默认保留用户数据。

### Q: 怎么知道有没有新版本？

设置 → 服务信息 → 更新检查（默认关闭，不开任何外部请求）。开启后周期性查询 GitHub Releases，有新版本时在服务信息和通知中心提示。命令行 `owc --version` 看当前版本。

### Q: 升级后我的设置会被覆盖吗？

不会。安装目录的 `config/defaults.json` 随版本更新，你的 `server-settings.json` 只保存改过的项；启动时按「环境变量 > 你的覆盖 > 安装默认」合并。某项安装默认变了而你没改过它，设置页会提示「采纳新默认」。

### Q: 能自定义系统提示词吗？

可以。设置 → 提示词覆盖内置基线，项目级 `<cwd>/.owc/system-prompt.md` 覆盖全局设置。注意提示词不是安全边界：plan 模式、权限和沙盒由 server 独立强制，不会被提示词放开。

### Q: 离线模式是干什么的？

设置 → 联网服务 → 离线模式（或环境变量 `OWC_OFFLINE=1`）关掉 server 自己的周期性出站：更新检查、远程模型目录/定价后台同步、汇率在线刷新。不影响模型 API、联网搜索/抓取、MCP 和扩展联网——那些本来就是按调用发生的。热生效，不用重启。

### Q: 下载的发布包怎么校验完整性？

每个 Release 附 `SHA256SUMS.txt`。Linux 用 `sha256sum --check SHA256SUMS.txt`；Windows 用 `Get-FileHash <msi> -Algorithm SHA256` 后比对。在线安装脚本和 WebUI 在线更新都会自动校验，失败即中止。

### Q: cron 定时任务在重启 server 后还在吗？

在。任务存在 `<数据目录>/cron.json`，重启后自动恢复重排；停机期间错过的多次触发只补一次。recurring 任务创建 7 天后自动删除，one-shot 触发一次即删；删会话会级联删它的任务。每会话上限 50 个。详见 [usage.md 的定时任务一节](./usage.md#定时任务cron)。

### Q: 如何分叉或重新生成一段对话？

会话历史是树形存储，旧分支不丢。悬停任意一条用户消息有三个操作：编辑重发（从该处另起分支）、重新生成（回退到该条重跑）、分叉（复制进新会话）。时间线面板顶部有会话树，悬停节点也能「从此处继续」或分叉。详见 [usage.md 的面板与状态显示](./usage.md#面板与状态显示)。

### Q: Chat 模式是什么？怎么开启？

ChatGPT 风格的纯对话模式（1.6.0 新增），适合问答、写作、数据分析等不改代码的场景：多会话 + 会话树、助手预设、可选工具（联网搜索、Python 沙盒、图像生成/理解）、只读分享链接。默认关闭——设置 → **通用** 打开「Chat 模式」，侧栏即出现 chat / 工作台切换开关。详见 [usage.md 的 Chat 模式一节](./usage.md#chat-模式)。

### Q: Chat 模式的数据和工作台互通吗？

不互通。chat 会话独立存在 `<数据目录>/chat-sessions/`（工作台是 `sessions/`），配置独立在 `chat.json` / `chat-assistants.json`。共享的只有服务商/模型配置、联网服务商和「单条消息最大轮次」等全局设置。

### Q: Chat 分享链接安全吗？

分享页是只读快照：不含 API Key、不暴露配置，撤销后立即失效。可选访问密码——密码只存散列、校验接口有限流（同 IP 连续失败 5 次锁 60 秒）；票据用服务端随机密钥做 HMAC 签名，无法伪造。注意链接本身可公开访问，分享敏感对话前请设密码，并在可信网络使用。

## 模型与服务商

### Q: 支持哪些 LLM 服务商？

三种接口类型：Anthropic Messages、OpenAI Chat Completions（DeepSeek / Qwen / Ollama / GLM 等兼容端点）、OpenAI Responses。设置页可保存多个具名服务商配置，逐个选接口类型、Base URL 和 API Key；每个已启用服务商的模型合并显示为 `模型ID【服务商】`。

### Q: 模型列表为空或刷新失败？

- 确认服务商已启用，接口类型、Base URL、API Key 正确
- 用服务商表单里的「测试连接」定位：错误按认证失败、URL 错误、无法连接、限流分类提示（5 秒超时）
- Ollama 等不实现 `/v1/models` 的，直接手填模型 id（如 `qwen2.5-coder:14b`）
- 拉取失败不阻塞使用，按保守默认运行并在 UI 提示

### Q: 会话中途能换模型吗？

能。输入框下方的模型选择器随时切，下轮生效。账本按新模型的上下文窗口重算；新模型不支持当前思考模式/强度会自动清掉，不支持图片则历史图片换成占位描述。

### Q: 主模型报错了能自动换别的模型吗？

可以，配会话级备选模型链（fallbackModels，最多 3 个）。主模型遇可恢复错误（限流、过载、流中断等）重试耗尽后，自动切到链上下一个候选重建本轮。只在主循环生效，子代理不继承；`owc run` 对应 `--fallback-models provider/model,...`。详见 [usage.md 的备选模型一节](./usage.md#备选模型fallback)。

### Q: 为什么有些模型不能调用工具？

模型目录的 `tools` 能力开关决定的。关闭时 server 不下发内置工具 schema、工具提示、MCP 工具和技能目录，模型只能聊天和输出方案；即使 provider 异常返回 tool call，server 也拒绝执行并写入错误结果。需要文件操作、bash、子代理或 MCP 时，换标了 tools 的模型。

### Q: 为什么没有 `web_fetch` 或 `web_search`？

联网工具不默认注入，避免模型反复调用必然失败的工具。先在「设置 → 联网服务」页签保存联网服务商配置：共 10 种服务商（Jina / Brave / Tavily / Bing / SearXNG / Exa / LinkUp / Bocha / Firecrawl / Custom），每项声明 Search / Fetch 能力，再分别选当前配置。Jina、Tavily、Firecrawl 两项能力都支持（Tavily 的 Fetch 走 Extract API），Brave 等其余内置服务商只有 Search，Custom 可自行声明能力且 Fetch URL 必须含 `{url}`。没选对应能力就不提供该工具，不影响普通对话。

`https://mcp.tavily.com/mcp/?tavilyApiKey=...` 是 Tavily 的远程 MCP 地址；要用 Tavily 的完整工具集，把它写进 `<数据目录>/mcp.json`，别填进搜索 Base URL。

### Q: 怎么用模型服务商自带的联网搜索（比如 DeepSeek 的 `web_search`）？

1. 服务商用 OpenAI Responses 接口连接。
2. 设置 → 联网服务 → 联网搜索模式选 `model-api` 并保存。

`model-api` 把搜索交给模型服务端执行（请求级下发标记，只有 OpenAI Responses 接口消费），此时本地 `web_search` 工具不再注入；`web_fetch` 两种模式都能用。默认的 `local` 模式走上面配置的联网服务商，任何接口类型都能用。

### Q: thinking / reasoning 怎么开？

支持 reasoning 的模型在输入框下方有「思考」选择器，可选关闭、自适应或模型声明的强度。Anthropic 翻译为 `thinking.budget_tokens`，OpenAI 系翻译为 `reasoning_effort`。思考块默认折叠，思考 token 计入成本。

### Q: 对话支持 Markdown 和数学公式吗？

支持。正文和思考块都是 GFM Markdown（表格、任务列表、代码块等）；行内公式 `$...$`，块级公式 `$$...$$` 独占一段，KaTeX 渲染。

### Q: agent 运行报错（认证失败 / 限流 / 过载）怎么办？

错误事件按 authentication / rate_limit / overloaded 等分类，错误卡按类型给可操作提示并附设置深链。可重试错误有「重试」按钮一键重发上条消息；配了备选模型链的，重试耗尽后自动切换。

### Q: 缓存命中能降低成本吗？

能。Anthropic 有显式 `cache_control` 断点（系统提示词后、驱逐边界后、倒数第二轮用户消息后），cacheRead 价格通常是输入价的 0.1 倍；OpenAI 系自动缓存，无需配置。成本报表里看「缓存读」分项。

## 权限与沙盒

### Q: ask / acceptEdits / review / yolo 有什么区别？

- `ask`（默认）：每个写操作弹权限卡，逐个 allow/deny
- `acceptEdits`：文件编辑自动放行，bash 等仍需确认
- `review`：需确认的调用先由审核模型（快速模型，未配置则一律转人工）判 LOW/HIGH——LOW 自动放行并留审计事件，HIGH 或审核失败转人工；`git_commit` 永远强制人工
- `yolo`：全部自动放行——**但沙盒照常生效**，两者是正交的

「总是允许」会存持久规则（如 `bash(npm test)`），按词边界前缀匹配：`npm test -- --watch` 放行、`npm testx` 不放行。

### Q: 「允许一次」和「总是允许」有什么区别？

「允许一次」只放行当前这次调用，不写规则；「总是允许」需二次确认，把工具+参数规则存进会话。两者都先完成批准响应再执行工具，浏览器不会被长命令拖住。

Windows 的命令后端按 `pwsh > Git Bash > cmd.exe` 探测取第一个可用项（Git Bash 是 Git for Windows 的 bash.exe，不含 WSL）。批准后立即报「不是内部或外部命令」，多半是模型生成的语法和解释器不匹配，可在会话头部固定命令后端。

### Q: agent 的 bash 是每次新开一个 shell 吗？

不是。每会话默认维护一个持久 shell（沙盒内 pty），`cd` 切的目录、`export` 设的环境变量跨调用保持。pty 不可用时回退一次性执行，功能不变只是不保持状态。两个例外：`run_in_background` 始终走一次性 job；Windows 上 pwsh / Git Bash 后端在 AppContainer 下也回退一次性（cmd 不受影响）。

### Q: yolo 了还会被沙盒拦吗？

会。yolo 只跳过权限确认，沙盒（Job Object / AppContainer / WSB / bubblewrap / Landlock）照常约束文件读写和网络。完全解除只能在会话创建时把沙盒模式设为 `off`，不推荐。

### Q: 沙盒的网络三档 allow / deny / filtered 是什么？

- `allow`（默认）：不限制网络。
- `deny`：禁网。AppContainer 收回网络 capability，WSB 关 VM 网络，Linux 用 Landlock（ABI ≥ 4）或 bwrap `--unshare-net`；Job Object 没有网络隔离能力，会如实上报 partial。
- `filtered`（仅 Windows）：业务进程本身无网络，经沙盒内 sidecar 代理出网。默认全放行，可用 `sandboxProxyDenyList` 配域名黑名单，热生效。

### Q: agent 要写沙盒外的路径怎么办？

沙盒拒绝（EACCES）→ 错误结果回填给模型 → 模型一般会换路径或告诉你。要放宽就在会话设置里切沙盒模式或调整工作目录。

### Q: 跑不可信代码怎么配置？

Windows 选 WSB 沙盒：一会话一 VM，关闭即销毁，仅工作目录留存。Linux 默认的 bubblewrap 已隔离 mount/net namespace，更狠的组合是托管工作区（qcow2 快照）+ 容器。

### Q: agent 提交 git 需要我确认吗？

始终需要。`git_commit` 不开放自动执行，yolo 下也要确认，且拒绝 `--no-verify` 等绕过参数。建议走 SCM 面板的「生成提交信息 → 确认」流程，全程权限链并留审计。

## 上下文与快照

### Q: 上下文满了怎么办？

会话头部实时显示窗口占用（默认 ≥70% 变黄、≥85% 变红，随自动压缩水位调整）。接近上限时三层防御自动介入：

1. **结果预算截断**：bash 8k、read_file 16k、grep/glob 4k token，超出截断并留 artifact 指针
2. **滚动驱逐**：更早轮的工具结果压成一行占位符（默认节省）或整轮出视图只留摘要（超级节省），全量落盘 artifacts/；由 context-saver 扩展提供，扩展停用则不自动驱逐
3. **自动压缩水位强制压缩**（默认 85%，可在设置「上下文」页签调整）：快速模型做结构化概览

手动介入：`/compact`（概览摘要）、`/compact tools`（规则压缩）、`/clear`（清视图留历史）。

### Q: 驱逐掉的内容还能找回来吗？

能。底部「上下文」面板里已逐出条目旁有「恢复」按钮（需 context-saver 扩展启用），把 artifact 全文放回模型视图。界面渲染始终用全量历史，不受驱逐影响。

### Q: `/clear` 会丢历史吗？

不会。只清当前模型视图，messages.jsonl 全量保留，账本记 `cleared` 边界，回滚检查点会同步回退清空界。

### Q: 快速模型是什么？必须配置吗？

用于压缩、标题生成、翻译等旁路任务的低延迟模型，从已启用服务商里选，复用该服务商的接口和密钥。不是必须：不配时压缩走纯规则截断，概览压缩不可用并提示。选个便宜快的模型体验更好。

### Q: 怎么调整上下文驱逐与压缩？

底部「上下文」面板可热切换 `lag`（滚动）/ `interval`（定期批量）/ `off`（仅手动），改保留轮数和回写预算，逐条驱逐/恢复/pin，看 artifact 原文——这些驱逐相关段落由 context-saver 扩展提供，扩展停用时不显示。压缩是核心功能：自动压缩水位（默认 85%）在设置「上下文」页签调整，手动压缩按钮始终在面板「压缩」区。会话运行中这些写操作暂时禁用，避免与 agent 构建上下文竞态。

### Q: 检查点什么时候自动打？

会话头部「快照」开关两种模式：「每轮自动」在每次发消息前打一个（label 取消息摘要）；「仅手动」不自动打，但时间线面板随时可手动新建。模式按会话保存。

### Q: 回滚会丢会话历史吗？

默认会：文件和会话历史一起截到对应消息。点「仅文件」可只恢复文件、保留对话。账本随检查点一并回退。

### Q: 快照回退后可以马上继续对话吗？

可以。回退期间新消息会被拒（409，稍等重试），完成后消息历史截回检查点、账本同步回滚、持久 shell 一并回收，之后正常发消息即可。

### Q: 托管工作区是什么？什么时候用？

项目放在 VHDX（Windows）/ qcow2（Linux）镜像盘的挂载点上，快照走差分链——毫秒级、可再分支。适合频繁回滚、分支试验、跑不可信代码。代价：挂载要管理员权限；为保护差分链，每个托管工作区最多保留 32 个检查点，到上限会明确拒绝新建。

## 子代理与扩展

### Q: 八个官方扩展分别做什么？

- `context-saver`（默认开，原 context-manager 改名）：滚动驱逐、上下文条目管理与选择性上下文；停用后不自动驱逐，压缩与预算等核心功能不受影响
- `attention-optimizer`（默认关）：复制关键引用建注意力锚区，不动原消息
- `content-lens`（默认关）：旁路翻译与划词解析，需要快速模型
- `pdf-to-image`（默认开）：PDF 先存到工作区 `.owc/uploads/`，再把最多 4 页转成图片附件
- `owc-eval`（默认关）：内置回归评测面板，固定 mock 任务在隔离工作区回放，不用你的模型 Key
- `env-sim`（默认关）：提示词与工具命名切换为其他产品风格，底层实现与权限链不变
- `compact-vault`（默认关）：`/compact` 切换为档案库式压缩——完整上下文归档到会话 `compact/` 目录，上下文只留索引，主模型按 key 经 `recall_memory` 召回细节
- `vision-tools`（默认关）：主模型不支持视觉时，图片交给视觉模型生成描述注入上下文（describe），或以占位符 + `describe_image` 工具按需提问（toolCall）

在设置 → 扩展启停和配置。Extension Host 是独立子进程，单个钩子最多跑 5 秒。第三方 v1 扩展不是安全沙盒，只装信得过的。

### Q: 子代理能写文件吗？

分类型。内置 `explore`（默认）和自定义 markdown 子代理只读，只放行 `read_file/glob/grep/read_artifact`；内置 `general` 可写——文件、bash、test_runner 都能用，但每次调用仍走与主代理相同的权限链和沙盒。自定义子代理 frontmatter 声明的写工具会被忽略并在清单附注。详见 [usage.md 的子代理一节](./usage.md#自定义扩展点)。

### Q: 怎么手动启动一个子代理？explore 和 general 选哪个？

底部「子代理」面板顶部手动启动：填任务描述、选类型。查代码、找引用、总结结构选 `explore`（只读）；要改文件、跑 bash 选 `general`（ask 模式下照样弹权限卡）。中断主 agent 会同时取消手动启动的子代理。

### Q: 环境模拟（env-sim）预设怎么用？能自制吗？

设置 → 扩展启用 `env-sim`，在其配置里选预设（内置 `claude-code`/`kimi-code`/`zcode`/`codex`/`dsh-minimal` 五档）。`dsh-minimal` 复刻 DeepSeek Harness 极简模式：首轮只注入 `bash`/`str_replace_editor` 双工具、系统提示词也是极简形态，第二轮起保留 web 搜索与子代理等少数工具。自制：把预设 JSON（必填 `id`/`name`/`identity`/`basePrompt`，可选 `productSections`/`hideBuiltIns`/`aliases`/`firstTurnOnlyTools`）放进 `<数据目录>/env-sim/personas/`，一个文件一个预设，即出现在下拉里。详见 [usage.md 的官方扩展一节](./usage.md#extension-host-与官方扩展)。

### Q: Hooks 安全吗？

Hooks 配置等同 yolo。`.owc/hooks.json` 里的 command 由 server 直接 spawn，不过沙盒也不过权限链。只在自己信任的项目里配 hooks，共享或不可信仓库别启用。

### Q: MCP 工具能写文件吗？

能。MCP 工具按 `mcp__<server>__<tool>` 命名注入，走与内置工具相同的权限链（默认 ask）。plan 模式下一律拦截所有 `mcp__` 工具（无法判定读写性）。

## CLI 与脚本集成

### Q: `owc run` 怎么在 CI 里用？

```sh
owc run "跑测试并修复失败的用例" --cwd . --yolo --json | tee events.ndjson
```

`--yolo` 自动批准权限请求（CI 不能交互），`--json` 输出 NDJSON 事件流。退出码：`0` 完成，`1` agent 错误或连接失败，`2` 遇到权限请求但没带 `--yolo`。

### Q: `owc run` 会创建新会话吗？

默认每次新建。`--session <id>` 复用已有会话续聊，id 从 Web UI 或 `<数据目录>/sessions/` 目录名取。

### Q: 怎么限制 agent 能用的工具？

`owc run` 加 `--tools`（白名单）、`--exclude-tools`（黑名单）或 `--read-only`（等价于只读工具集，与 `--tools` 互斥）。Web UI 的会话配置里同样有 toolsAllow / toolsDeny。详见 [usage.md 的工具限制与只读模式](./usage.md#工具限制与只读模式)。

### Q: Windows 下 `owc run` 报找不到命令？

源码目录不会自动把 `owc` 加进 PATH。用 `node server/dist/cli.js run ...` 直接跑，或装发布版。

## 故障排查

### Q: Linux 的 `install.sh` 会在 CI 或脚本里等输入吗？

不会。只有 stdin/stdout 都是 TTY 且没传 `--yes` 时才提问；重定向、管道和 CI 直接用默认值。自动化安装显式传 `--yes`：

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3210 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

`--prefix`、`--data-dir` 必须是绝对路径。运行时 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 可覆盖安装时默认值。详见 [usage.md 的 Linux 安装器一节](./usage.md#linux-安装器交互与自动化)。

### Q: 启动后浏览器打不开 / 连接被拒？

- 确认 `owc` 进程在跑、端口没被占、防火墙没拦
- 默认只监听 `127.0.0.1`。要远程/局域网访问，把监听地址改成 `0.0.0.0`（设置 → 远程访问，重启生效，或 `OWC_HOST=0.0.0.0`）

非回环监听会强制访问令牌认证：令牌自动生成并持久化在 `<数据目录>/access-token`，一键访问链接在设置 → 远程访问可见。浏览器开 `http://<主机>:<端口>/?token=<token>` 换 HttpOnly Cookie；`owc run` 用 `OWC_ACCESS_TOKEN` 环境变量走 Bearer 头。显式 `OWC_ACCESS_TOKEN` / `OWC_ALLOWED_ORIGINS` 可覆盖自动行为。

### Q: 什么时候需要登录（访问令牌 / TOTP）？

默认回环监听、只给自己用时什么都不用。改成非回环监听后强制访问令牌（见上一条）。TOTP 全局登录是可选的再加固：设置 → 远程访问里的向导启用，扫码绑认证器，启用时给 10 个一次性恢复码，登录票据滑动 12 小时有效。TOTP 同时是远程终端页签的启用前提之一。

### Q: 为什么看不到终端页签 / 终端不可用？

远程终端有两个门槛，需同时满足：已开启 TOTP 全局登录；且监听地址是回环或局域网字面量（`127.0.0.1`、`192.168.x.x` 等，`0.0.0.0` / `::` 通配不算）。注意终端在宿主机以应用身份运行、**不经沙盒**，和输入框 `!` 命令走的权限链是严格分开的两条路。详见 [usage.md 的远程终端一节](./usage.md#远程终端)。

### Q: TOTP 丢了（换手机 / 卸载认证器）怎么办？

用启用向导给的 10 个一次性恢复码之一登录（每个只能用一次）。恢复码也没了：在服务器本机删 `<数据目录>/totp.json` 并重启 server，回到未启用状态再重新走向导。`owc run` 等机器通道走 `OWC_ACCESS_TOKEN`，不受 TOTP 影响。

### Q: 手机上能用吗？

能。窄窗口（≤1024px）是单列布局，下发任务、看状态、处理权限卡、切换会话都可用，侧栏变临时抽屉。浏览器「安装到主屏」后有 PWA 壳，不做离线缓存。手机访问意味着非回环监听，令牌配置见上面的问答。详见 [usage.md 的移动端一节](./usage.md#移动端与-pwa)。

### Q: 命令面板和快捷键有哪些？

`Ctrl/Cmd+Shift+P` 命令面板（全部命令可搜），`Ctrl/Cmd+P` Quick Open 直达文件（`#` 前缀搜符号），`Shift+?` 打开快捷键页签。默认键位对齐 VSCode 习惯，完整清单在设置 → 快捷键；暂不支持自定义键位。详见 [usage.md 的工作台布局与快捷键](./usage.md#工作台布局与快捷键)。

### Q: 怎么在对话里搜索内容、快速换模型？

`Ctrl/Cmd+F` 打开会话内搜索：`↑`/`↓` 在命中间跳转高亮，可勾选「仅搜索已加载消息」。输入框聚焦时按 `Ctrl+P` 在最近用过的模型间循环切换。

### Q: test_runner 支持哪些测试框架？

结构化解析覆盖 vitest/jest、pytest、go test、dotnet test 四类；项目类型按 package.json / pyproject / go.mod / *.sln 自动检测生成默认命令。解析失败回退原文尾部（不丢输出），失败摘要有界注入上下文，完整结果落会话 artifact 并在问题面板可视化。

### Q: 索引没建或损坏时 agent 还能搜代码吗？

能。`code_search` 没索引时明确回退 grep 路径，文件系统永远是真相。索引坏了可整体重建（`POST /api/workspaces/index/rebuild`），不进会话历史。

### Q: WebSocket 断线重连后会丢事件吗？

不会。断连期间顶部显示「连接中断，正在重连…」横幅；重连带 `after=<lastSeq>` 补拉。只有当断点早于服务端历史缓冲区最旧事件（默认 1000 条）时返回 `resync.required`，客户端走 REST 全量重取。

### Q: core（C 执行器）崩溃了怎么办？

core-client 自动重启（指数退避封顶 30 秒，持续重试不永久放弃），重启后标记运行中工具失败。频繁崩溃看 `<数据目录>/logs/` 里的 core stderr。

### Q: 沙盒导致某些命令失败？

AppContainer 下 git 凭据管理器、部分 GUI 程序、需要特殊权限的工具可能异常。点会话头部的沙盒徽标看策略，或在会话设置切回 `Job Object` 兼容兜底模式。

### Q: 后台任务在 Linux 上 kill 后子进程还在？

已知限制。Windows Job Object `KILL_ON_JOB_CLOSE` 能杀尽孙进程树；Linux posix kill 后孙进程可能孤儿化。建议后台任务用 `setsid` 或 `nohup` 包一层。

## 反馈与贡献

- 问题反馈：GitHub Issues
- 开发文档：`docs/`（本地维护，不随 git 同步）
- 用户文档：`help/`（本目录，随 git 同步）
