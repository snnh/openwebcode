<div align="center">
  <img src="./assets/icon.png" alt="OpenWebCode" width="96">
  <h1>OpenWebCode</h1>
  <p><strong>浏览器打开即用的 AI 编码工作台</strong></p>
  <p>
    <a href="https://github.com/snnh/openwebcode/releases"><img src="https://img.shields.io/github/v/release/snnh/openwebcode" alt="Release"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational" alt="Platform">
  </p>
  <p>简体中文 | <a href="./README.en.md">English</a></p>
</div>

OpenWebCode 是一个跑在浏览器里的 AI 编码工作台，界面中英双语，原生支持 Windows (x86-64) 和 Linux (x86-64 / arm64 / loongarch64)。装好后用浏览器打开，就能让 agent 帮你读写代码、修改文件、操作终端。

```text
浏览器 (React 19 + Vite 6)  ──HTTP/WebSocket──►  Node 服务层 (Agent 循环、工具调度、权限)  ──JSON-RPC/stdio──►  C 执行器 (命令/文件/沙盒/快照)
```
## 配置要求：

1. 服务端：
   - 系统：Windows 10+（Win7 未测试）和 Linux
     - Linux：glibc ≥ 2.28；内核 ≥ 5.13（Landlock 起步，≥ 6.7 支持禁网）。沙盒默认档为 bubblewrap（完整 namespace 隔离）：未安装 bubblewrap 的环境默认档会明确报错，需 `apt install bubblewrap`（或等价包），或将会话沙盒模式显式切换为 Landlock 兼容档（更弱）。开发与实测环境为 Debian 13 / Ubuntu 24.04。
     - 鸿蒙版本正在开发。
   - 架构：x86-64 / arm64 / loongarch64（龙芯包不内置 Node.js，需系统 Node.js ≥ 24）
   - CPU：双核 2.0 GHz
   - 内存：≥ 512 MiB 空闲（推荐1GiB空余）
   - 硬盘：≥ 500 MiB 可用

2. 客户端：
  可运行 Chrome / Edge ≥ 111 或 Firefox ≥ 113 浏览器的设备（含手机和平板）

## 主要功能

- **AI 编码**：读写代码、改文件、跑命令与测试、符号索引与诊断，全在 agent 里完成。
- **Chat 模式**：ChatGPT 风格的轻量对话（开发中、默认关闭），与工作台共用同一套会话/模型/权限状态。
- **对低性能设备友好的资源占用**：详见[性能与资源占用](#性能与资源占用)。
- **相对完善的沙盒**：Windows Job Object / AppContainer / WSB，Linux bubblewrap / Landlock。
- **git 与文件系统级快照**：ZFS / Btrfs / overlayfs / VHDX / qcow2 多种后端，自动探测、失败静默回落。
- **上下文管理**：可调的自动压缩阈值与压缩输出预算；手动 `/compact` 校验输出防复述、快速模型失败优雅降级；滚动驱逐、上下文条目管理与选择性上下文（pin/exclude）由官方 context-saver 扩展提供，可整体关闭。
- **多模型适配**：支持 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三大接口；**运行中可直接更换模型与思考档**（不打断在途请求，下一轮生效）。
- **环境模拟（env-sim）**：系统提示词与工具形态可切换为知名 AI 编码产品的风格（Claude Code / Kimi / ZCode / Codex / DSH 五档预设），底层工具实现与权限链不变。已对 DeepSeek V4 Pro 0813 专项适配——使用该模型时建议开启 DSH 极简模拟（`dsh-minimal`）。
- **子代理与 agent swarm**：隔离上下文的并行派发，可见进度与转录；普通子代理与可互相沟通的子代理集群。
- **较多的扩展支持**：Skills、斜杠命令、Hooks、自定义子代理、MCP 和 Extension Host 第三方扩展。
- **自由的会话管理**：消息随意改写、分叉随时创建；手工分组、归档、多选批量管理（删除/归档/置顶）；会话导出分享页（自包含只读 HTML）/ Markdown / JSONL。
- **本机会话**：侧栏「终端」图标一键创建，以 server 身份直接在宿主机管理本机文件/服务（HOME 外访问需人工批准）。
- **内置工具面板**：符号索引（`repo_map` / `code_search`）、测试诊断（Problems 面板）、SCM 面板（diff、stage、worktree 合回、生成提交信息）。
- **任务清单**：标签栏右端折叠 chip，随时查看 agent 当前任务与进度；落盘跨重启存活（`/clear` 同步清空）。
- **联网搜索与抓取**：Web Search / Web Fetch 走可配置的联网服务商（Jina / Brave / Tavily / Bing / SearXNG / Exa / LinkUp / Bocha / Firecrawl / Custom 共 10 种），或由模型服务商在服务端执行搜索（仅 OpenAI Responses）。
- **定时任务（cron）**：会话内创建定时任务，到点自动注入 prompt 续跑；5 字段 cron 语法，持久化跨重启。
- **移动端与远程访问**：响应式适配手机/平板；非回环监听强制访问令牌（自动生成或 `OWC_ACCESS_TOKEN`），可选 TOTP 全局登录。
- **`owc run` CLI**：Headless NDJSON 事件流，支持 CI 集成。
- **dsh 兼容模式（实验，默认关闭）**：独立端口托管 dsh 官方 SPA，并加载 dsh 生态插件（Host 工具/钩子与 client UI 插件）。

具体详见 [使用帮助](./help/usage.md) 和 [常见问题](./help/faq.md)。

## 快速开始

### Windows

1. 从 [Releases](https://github.com/snnh/openwebcode/releases) 下载 `openwebcode-<version>-windows-x64.msi` 双击安装（需要管理员权限）。
2. 重新打开终端运行 `owc`，或者直接用安装目录里的 `bin\owc.cmd`。
3. 浏览器打开 <http://127.0.0.1:3210>。

### Linux

1. 支持 x86_64、aarch64（arm64）和龙芯 loongarch64，在线安装脚本会按架构自动选包：

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
```

2. 手动下载对应架构的 tar.gz，解压后运行 `./install.sh`（交互式终端里会问你安装前缀、端口和数据目录；脚本或 CI 里加 `--yes` 跳过提问）。

注：龙芯包不内置 Node.js，需要系统里有 Node.js ≥ 24。完整的安装选项和 systemd 服务说明见 [`packaging/README.md`](./packaging/README.md)。

### Docker（Linux / macOS，x86_64 / arm64）

发布镜像托管在 GitHub Container Registry（`ghcr.io/snnh/openwebcode`），内置完整运行时（core、Node 24、bubblewrap、git、python3），数据目录可持久化：

```sh
# 1. 在仓库根目录启动（拉取 GHCR 发布镜像）
docker compose up -d

# 2. 查看访问链接 —— 非回环监听下首次启动自动生成访问令牌，链接含 token
docker compose logs | grep 访问链接
```

浏览器打开日志里的链接（`http://<主机IP>:3210/?token=<令牌>`）。
不用 compose 时，可使用下列命令：

```sh
docker run -d --name openwebcode --restart unless-stopped \
  -p 3210:3210 -v openwebcode-data:/data \
  ghcr.io/snnh/openwebcode:latest
docker logs openwebcode | grep 访问链接
```

- **数据**：默认存储在 `openwebcode-data` 命名卷。
- **升级**：`docker compose pull && docker compose up -d`，数据卷不动。
- **工作区**：可选挂载宿主机目录。
- **沙盒**：默认 bubblewrap 命名空间（需在 compose 放开 `security_opt: seccomp=unconfined`，同时宿主机允许非特权 user namespace）；不可用时默认档明确报错、不再自动降级，需安装 bubblewrap 或将会话沙盒模式显式切到 Landlock（宿主机内核 ≥ 5.13；更弱）。
- **从源码构建**：`docker build -t openwebcode .`，或在 compose 里取消 `build:` 注释。镜像内布局、构建与发布说明见 [`packaging/README.md`](./packaging/README.md) 的「Docker 镜像」一节。

### 首次使用

1. 在 **设置 → 模型目录** 添加并启用一个模型服务商（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses），然后刷新模型目录。
2. 点侧栏的 **+** 新建会话，选工作目录、服务商/模型和沙盒模式。
3. 在输入框里描述任务，回车发送。

## 输入框速查

| 输入 | 含义 |
|---|---|
| 普通文本 | 发给 agent 的任务描述 |
| `/技能名` | 触发 Skill |
| `/自定义命令` | 触发 `.owc/commands/` 里的斜杠命令模板 |
| `/compact` | 压缩上下文（加 `tools` 参数走规则压缩） |
| `/clear` | 清空当前视图，**历史保留**，可以回滚 |
| `/init` | 分析工作区并生成/更新根 `AGENTS.md`（写入走权限链） |
| `/help` | 打开 设置 → 快捷键 |
| `@路径` | 引用工作区文件，内容随消息一起注入 |
| `!命令` | shell 快捷前缀，走 bash 权限链执行 |

注：agent 运行时发的消息会进入 steering 队列；只贴图或只挂附件（不写文字）也可直接发送。

## Headless CLI

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json --yolo
```

- `--json` 输出 NDJSON 事件流，方便脚本解析；`--yolo` 自动批准权限请求（CI 场景）。
- `--session <id>` 接着已有会话继续；`--tools` / `--exclude-tools` / `--read-only` 限制工具范围；`--fallback-models` 配置备选模型链。
- 退出码：`0` 完成，`1` agent 出错，`2` 权限被拒绝。

## 性能与资源占用

开发机实测（Windows x86-64，v1.7.6，5000 条消息基准数据集；基准脚本与验收标准在 [`scripts/bench/`](./scripts/bench/)）：

| 组件 | 内存占用 | CPU（折合单核 95% 时间占用） | 关键指标 |
|---|---|---|---|
| server（Node 服务层） | 空闲约 74 MiB；载入 5000 消息大会话后稳态约 115 MiB | 低于 0.5% | 大会话冷载 24ms、历史分页 p50 0.6ms；上下文增量构建 p50 0.35ms（较全量构建 31× 加速）；agent 主循环每轮堆增量 0.9 MiB；事件分发 5800+ events/s；10 万文件索引查询 p50：符号约 15ms、文件约 21ms |
| core（C 执行器） | 空闲约 9 MiB；10 万文件重负载扫描峰值约 15 MiB，结束即回落 | 低于 0.5% | 全仓索引扫描（10 万文件）约 33s 内完成且内存可控 |
| 浏览器端 | 5000 消息会话满载堆约 93 MiB | - | 长列表滚动 p50 59.9 fps；输入回显 p50 26.5ms；持续滚动内存增长 0.1%（无泄漏）；聊天/工作台/分享页按需分包，首屏脚本 479 KB |

生产环境参考（v1.7.6，Debian 13 x86-64，常驻实测）：server 110 MiB + 扩展宿主 52 MiB + core 1.9 MiB（server 较 v1.5.0 的 135 MiB 下降约 19%），CPU 95% 时间占用低于 0.5%。

> v1.12.1 起进一步优化大会话内存：agent 每轮此前把整份 `messages.jsonl` 解析两次（60 MB 会话单次约百 MB 级堆），现只加载「`/clear` 或压缩锚点之后」的活动段——实测同会话整表 +101 MB / 255 ms → 段 +27 MB / 133 ms；并在启动完成 / 每轮结束 / 空闲清扫三个时点触发 full GC，V8 空闲页及时归还。

## 文档

- [`help/usage.md`](./help/usage.md) — 使用帮助：启动、面板、快捷键、模型与成本、自定义扩展点模板
- [`help/faq.md`](./help/faq.md) — 常见问题：模型接入、权限与沙盒、快照回滚、CLI 集成、故障排查
- [`help/dsh-compat.md`](./help/dsh-compat.md) — dsh 兼容模式：开启方式、安装 dsh 插件、支持/不支持清单、可信边界与故障排查
- [`help/development.md`](./help/development.md) — 二次开发：仓库布局、三件套构建、测试约定、切入点、CI 与发布
- [`packaging/README.md`](./packaging/README.md) — 打包流程、分发布局、安装脚本与发布流水线
- [`CHANGELOG.md`](./CHANGELOG.md) — 版本更新日志

## 从源码构建

需要 Node.js ≥ 20、CMake ≥ 3.19、C11 编译器和 Python 3（core 协议测试用）。三层各自独立构建，仓库根目录没有 `package.json`：

```sh
cmake -S core -B build && cmake --build build && ctest --test-dir build   # core（C 执行器）
cd server && npm ci && npm run build && npm test                          # server（Node 服务层）
cd web && npm ci && npm run build && npm test                             # web（产物由 server 静态托管）
```

## 数据与配置

设置保存在 `<数据目录>/server-settings.json`。数据目录解析顺序：显式设 `OWC_DATA_DIR` 优先；否则由 launcher 注入平台默认值（Windows 是 `%USERPROFILE%\openwebcode`，Linux 是 `~/.local/share/openwebcode`）；只有绕过 launcher 直接 `node server/dist/index.js` 启动时才回落到 `server` 旁的 `.openwebcode`。密钥、会话数据与全局扩展点都在数据目录里（POSIX 下 0600/0700）。项目级覆盖配置放在项目根目录的 `.owc/` 下。

## 卸载

- **Windows**：「设置 → 应用」里卸载。
- **Linux**：推荐运行安装器写入的 `~/.local/bin/owc-uninstall`（会一并清理 systemd unit 残留）；或手动 `rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc ~/.local/bin/owc-uninstall`。

注：数据目录默认保留。

## 赞助

OpenWebCode 是个人维护的开源项目。如果它对你有帮助，欢迎通过 [donate.md](./donate.md) 赞助支持持续开发。

<img src="./assets/donate-wechat.png" alt="微信赞赏码" width="240">

## 特别感谢

1. 感谢 deepseek、kimi-k3、qwen，本项目由上述模型辅助开发
2. 感谢一些群友提供的灵感
3. 感谢 [pi-agent](https://github.com/earendil-works/pi)，本项目默认系统提示词以其为基线（MIT，作者 Mario Zechner）
4. 感谢 [Shyliuli](https://github.com/Shyliuli) 协助进行龙芯（loongarch64）版本测试

## License

[Apache-2.0](./LICENSE)
