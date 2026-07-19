# 使用帮助

日常使用 openwebcode 时最常遇到的问题与操作。FAQ 见 [`faq.md`](./faq.md)。

## 启动

1. 运行 `owc`（Windows：`owc.cmd`；Linux：`owc` 软链）；
2. 浏览器打开 <http://127.0.0.1:3000>；
3. 首次使用先去**设置页**配置模型提供商（baseUrl、apiKey），点「刷新模型目录」拉取可用模型。

如果端口被占用或想换端口：`owc --port 4000`（其他 CLI 参数见 `owc --help`）。

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

## 运行中操作

- **中断**：顶部「中断」按钮（或 `POST /api/sessions/:id/abort`）—— 取消当前 LLM 请求 + kill 运行中的工具进程
- **Steering**：运行中追加消息进入队列，下一轮注入
- **权限请求**：弹出权限卡片，三选项：
  - `允许` —— 本次
  - `总是允许` —— 生成持久规则（如 `bash(npm test:*)`），随会话保存
  - `拒绝` —— 可附理由回填给 LLM
- **后台 bash 任务**：bash 工具带 `run_in_background=true` 时立即返回 taskId，头部徽标查看运行中任务、点开看输出、随时终止；完成自动通知下一轮

## 会话生命周期（重要）

- **关闭浏览器标签页不会停止 agent** —— 服务器继续执行，结果照常落盘
- 重新打开 UI 选回该会话，断线期间的事件自动补拉回来
- 主动停作业用「中断」按钮；关掉 server 进程才收尾全部会话与后台任务
- 断线期间发起的权限请求会一直挂起等你回来 respond，**无超时**

## 右侧面板

- **文件树**：懒加载，文件只读预览
- **上下文用量**：`▓▓▓░░ 42% (63k/150k) · ¥3.2/¥20`，点开看分类明细（含驱逐/压缩统计）
- **时间线**：检查点列表 → diff 摘要 → 回滚（二次确认，文件 + 会话历史同步截断）
- **沙盒状态**：会话头部徽标（🛡️ enforced / ⚠️ partial），点击看策略

## 模型与成本

- **会话中热切换模型**：下轮生效，账本按新窗口重算，模态不兼容的历史内容替换为占位描述
- **思考程度**：支持 thinking 的模型在输入框上方有开关与程度选择器（low/medium/high）
- **成本报表**：按会话/按日/按 provider，缓存读写分项，双币种（USD/CNY）汇率折算，预算触发暂停

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
| `<cwd>/.owc/agents/`、`.owc/commands/`、`.owc/skills/`、`.owc/hooks.json`、`.owc/mcp.json`、`.owc/memory.md` | 项目级（同名覆盖全局） |

## 自定义扩展点

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
