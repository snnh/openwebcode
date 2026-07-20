# 使用帮助

日常使用 openwebcode 时最常遇到的问题与操作。FAQ 见 [`faq.md`](./faq.md)。

## 启动

1. 运行 `owc`（Windows：`owc.cmd`；Linux：`owc` 软链）；
2. 浏览器打开 <http://127.0.0.1:3000>；
3. 首次使用先去**设置页**配置模型提供商（baseUrl、apiKey），点「刷新模型目录」拉取可用模型。

如果端口被占用或想换端口：设置环境变量 `OWC_PORT=4000` 后启动 `owc`（launcher 脚本默认 3000，server 自身兜底 3210）。

## 创建会话

侧栏 **+** 新建会话：

- **工作目录**：agent 的 cwd，文件读写/命令执行都在此目录下（受沙盒约束）
- **provider / 模型**：从设置页配置的列表里选
- **沙盒模式**：
  - `AppContainer`（Windows 默认）/ `Landlock`（Linux 默认）—— 日常开发
  - `WSB`（Windows Sandbox）—— 跑不可信代码时用，一会话一 VM，关闭即蒸发
  - `Job Object`（Windows）/ 关闭 —— AppContainer 兼容兜底 / 完全不沙盒（不推荐）
- **工作区模式**：
  - `直接` —— 工作目录就是文件系统里的真实目录
  - `托管工作区` —— 项目复制进 VHDX/qcow2 稀疏镜像盘挂载点，快照走差分链（毫秒级、可分支）
- **Plan/Build 模式**：
  - `build`（默认）—— 正常执行
  - `plan` —— 只读调研，产出分步计划，不执行任何写操作；切回 build 才动手

## 输入框

输入框支持以下前缀与快捷：

| 输入 | 含义 |
|---|---|
| `普通文本` | 发给 agent 的任务描述 |
| `/技能名` | 触发 Skill（项目 `.owc/skills/` 或全局） |
| `/自定义命令` | 触发自定义斜杠命令（项目 `.owc/commands/` 或全局） |
| `/compact` | 概览压缩上下文（provider2 做结构化摘要） |
| `/compact tools` | 规则压缩（toolcalls 占位精炼） |
| `/clear` | 清空当前视图，**保留历史**（JSONL 全量在盘，可回滚） |
| `@路径` | 引用工作区文件，内容随消息注入（大文件截断 + artifact 指针） |
| `!命令` | shell 快捷前缀，走与 bash 工具相同的权限链执行，结果可一键「发给 agent」 |

- `@` 触发文件补全下拉（防抖 200ms，键盘上下/回车/Esc）
- 运行中再发消息会进入 **steering 队列**，下一轮注入，不中断当前作业
- 默认 Enter 发送、Shift+Enter 换行；可在设置里改成 Ctrl+Enter 发送

## 对话内容渲染

- 正文支持 GFM Markdown：标题、列表、任务列表、表格、引用、删除线、链接、行内代码与代码块
- 行内公式使用 `$E=mc^2$`
- 块级公式使用独占一段的 `$$ ... $$`，由 KaTeX 渲染；过宽公式可横向滚动
- 思考过程与流式思考使用同一套 Markdown/LaTeX 渲染，默认折叠，颜色比最终正文更浅；点击「思考过程」或「正在思考」展开。完成后的思考随 assistant 消息落盘，刷新或重开会话仍保留
- 历史版本按 token 保存的正文分片会在显示时自动合并，不再逐词换行

## 运行中操作

- **中断**：顶部「中断」按钮（或 `POST /api/sessions/:id/abort`）—— 取消当前 LLM 请求 + kill 运行中的工具进程
- **Steering**：运行中追加消息进入队列，下一轮注入
- **权限请求**：弹出权限卡片，三选项：
  - `允许一次` —— 仅批准当前工具调用；批准响应先返回浏览器，随后才启动工具
  - `总是允许` —— 二次确认后生成持久规则（如精确的 `bash(npm test)`），随会话保存
  - `拒绝` —— 可附理由回填给 LLM
- Windows AppContainer 会话的 shell 是 `cmd.exe`；使用 `dir`、`type`、`where`、`&&` 等 cmd 语法。需要 PowerShell/POSIX 命令时应显式调用可用的 `powershell`、`pwsh` 或 `bash`
- **后台 bash 任务**：bash 工具带 `run_in_background=true` 时立即返回 taskId，头部徽标查看运行中任务、点开看输出、随时终止；完成自动通知下一轮

## 会话生命周期（重要）

- **关闭浏览器标签页不会停止 agent** —— 服务器继续执行，结果照常落盘
- 重新打开 UI 选回该会话，断线期间的事件自动补拉回来
- 主动停作业用「中断」按钮；关掉 server 进程才收尾全部会话与后台任务
- 断线期间发起的权限请求会一直挂起等你回来 respond，**无超时**

## 右侧面板

- **文件树**：懒加载，文件只读预览
- **上下文用量**：token/成本/预算明细；支持 lag/interval/off 策略热调、工具调用/概览压缩、条目逐出/回写/pin，以及 artifact 原文查看
- **时间线**：检查点列表 → diff 查看 → 「完整回滚」或「仅文件」回滚（二次确认），新建检查点
- **沙盒状态**：会话头部徽标（enforced / advisory），标识当前沙盒是否生效
- **模式切换**：会话空闲时可在头部直接切换沙盒模式，以及快照的「每轮自动 / 仅手动」模式；运行中会暂时禁用切换

## 模型与成本

- **会话中热切换模型**：下轮生效，账本按新窗口重算，模态不兼容的历史内容替换为占位描述
- **思考程度**：支持 thinking 的模型在输入框上方有开关与程度选择器（low/medium/high）
- **成本报表**：按会话/按日/按 provider，缓存读写分项，双币种（USD/CNY）汇率折算，预算触发暂停
- **模型定价**：设置 → 模型定价 → 添加条目。价格单位是“每百万 tokens 的元/美元”；输入、输出单价必填，缓存读/写可空（按 `0` 保存），生效日期默认当天并可修改
- 同一 provider/model 的生效区间不能重叠；历史价格或复杂区间可用「编辑 JSON」维护 `effectiveFrom` / `effectiveUntil`

## Headless CLI（脚本集成）

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json
```

- `--json` 输出 NDJSON 事件流（每行一个事件对象）
- `--yolo` 权限请求自动 allow（CI 场景）
- `--session <id>` 复用已有会话
- 退出码：`0` 完成 / `1` agent 错误 / `2` 权限拒绝（非 `--yolo`）

## 会话导出与分享

- **导出分享页**：侧栏会话项悬停 → 「导出分享页」→ 生成 `export.html` 自包含只读页（内联样式、零外部资源、全文转义），可直接发给别人
- **导出/导入 JSONL**：会话菜单导出全量历史，另一台机器导入即恢复

## 配置文件位置

| 路径 | 用途 |
|---|---|
| `~/.openwebcode/config.json` | 全局配置（provider/模型/定价/汇率/上下文策略） |
| `~/.openwebcode/sessions/<id>/` | 会话数据（meta.json + messages.jsonl + ledger.json + artifacts/） |
| `~/.openwebcode/agents/*.md` | 全局自定义子代理 |
| `~/.openwebcode/commands/*.md` | 全局自定义斜杠命令 |
| `~/.openwebcode/skills/<name>/SKILL.md` | 全局 Skills |
| `~/.openwebcode/hooks.json` | 全局 Hooks（**安全级别等同 yolo**） |
| `~/.openwebcode/mcp.json` | 全局 MCP 客户端配置 |
| `~/.openwebcode/extensions/` | Extension Host 配置与第三方 `owc-ext-*` 扩展 |
| `<cwd>/.owc/agents/`、`.owc/commands/`、`.owc/skills/`、`.owc/hooks.json`、`.owc/mcp.json`、`.owc/memory.md` | 项目级（同名覆盖全局） |

## 自定义扩展点

### Extension Host 与官方扩展

设置 → **扩展** 可管理独立 Extension Host 中的扩展。内置三项：

- `context-manager`：默认启用，负责滚动驱逐策略和上下文管理面板；停用后不会自动逐出工具结果，85% 核心水位安全网仍保留
- `attention-optimizer`：默认关闭，把关键约束/目标复制到上下文首尾锚区；`bottomOnly` 缓存影响较小，`full` 会增加输入 token
- `content-lens`：默认关闭；启用且已配置 provider2 后，消息旁出现「译」与「解析选中」，结果只存 `translations/`，不进入 LLM 上下文

第三方扩展目录需包含 `manifest.json`（`apiVersion: "1"`）和 `index.js`，可在设置页输入本地绝对路径安装。v1 扩展是可信代码，安装即信任其声明权限；钩子运行超时 5 秒会跳过并告警。

### 子代理（`.owc/agents/reviewer.md`）

```markdown
---
name: reviewer
description: 代码审查专家，只读不改
tools: [read_file, glob, grep]
model: claude-sonnet-4-5
---
你是资深代码审查员。逐行核对 diff，指出：
- 逻辑错误
- 边界条件遗漏
- 命名与风格
不要修改代码，只输出审查意见。
```

调用：`spawn_task agent=reviewer prompt="审查 src/auth.ts 的最近改动"`

### 斜杠命令（`.owc/commands/review.md`）

```markdown
---
description: 审查当前改动
---
请用 git diff 查看未提交改动，逐文件给出审查意见。重点：$ARGUMENTS
```

调用：输入框 `/review 安全性` → `$ARGUMENTS` 替换为 `安全性`。

### Hooks（`.owc/hooks.json`）

```json
{
  "PreToolUse": [
    { "matcher": "write_file*", "command": "prettier --check $FILE" }
  ],
  "PostToolUse": [
    { "matcher": "bash*", "command": "notify-send '命令完成'" }
  ]
}
```

- `matcher`：精确工具名、`前缀*`、`*` 全匹配
- PreToolUse：exit 0 放行 / exit 2 否决（stderr 回填 LLM）/ 其他非零告警不阻断
- 5s 超时杀进程
- **安全级别等同 yolo**：hooks.json 里的 command 由 server 直接 spawn 执行，不经沙盒与权限链。凡是能写 hooks 配置的人即拥有等同 yolo 的执行能力。

## 常见问题

见 [`faq.md`](./faq.md)。
