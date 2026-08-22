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

```
浏览器 (React)  ──HTTP/WebSocket──►  Node 服务层 (Agent 循环、工具调度)  ──JSON-RPC──►  C 执行器 (命令/文件/沙盒/快照)
```
## 配置要求：

1. 服务端：
  - 系统：Windows10+ (win7暂未测试) 和 Linux
     - Linux 版本：glibc ≥ 2.28 ；内核 ≥ 5.13（Landlock 起步，≥ 6.7 支持禁网），安装 bubblewrap 可获得完整 namespace 隔离。开发与实测环境为 Debian 13 / Ubuntu 24.04
     - 鸿蒙版本正在开发
  - 架构：x86-64 / arm64 / loongarch64（龙芯包不内置 Node.js，需系统 Node.js ≥ 24）
  - CPU：双核2.0ghz
  - 内存：≥ 512 MiB 空闲
  - 硬盘：≥ 500 MiB 可用

2. 客户端：
  可运行 Chrome / Edge ≥ 111 或 Firefox ≥ 113 浏览器的设备（含手机和平板）

## 主要功能

- 基础的 AI coding 功能。
- 不止于code，还能chat，全新chat模式，仍旧轻量。
- 对低性能设备友好的资源占用：详见[性能与资源占用](#性能与资源占用)
- 相对完善的沙盒支持：Windows Job Object/AppContainer/WSB，Linux bubblewrap/Landlock。
- git 和文件系统级快照：ZFS / Btrfs / overlayfs / VHDX / qcow2 多种后端。
- 更好的上下文管理：官方 context-saver扩展和更多开放接口供调用。
- 多模型适配：支持chat/response/anthropic 三大主流api。
- 环境模拟（env-sim）：系统提示词与工具形态可切换为知名 AI 编码产品的风格（Claude Code / Kimi / ZCode / Codex / DSH 五档预设），让更多模型充分发挥能力。
- 已对 DeepSeek V4 Pro 0813 专项适配——使用该模型时建议开启 DSH 极简模拟（`dsh-minimal）。
- 子代理和 agent swarm：普通子代理和可以互相沟通的子代理集群。
- 较多的扩展支持：Skills、斜杠命令、Hooks、自定义子代理、MCP 和 Extension Host 第三方扩展。
- 自由的会话管理：消息随意改、分叉随时开。
- 本机会话：侧栏「终端」图标一键创建，以 server 身份直接在宿主机管理本机文件/服务（HOME 外访问需人工批准，不做快照）。
- 内置符号索引（`repo_map` / `code_search`）、测试诊断（Problems 面板）、SCM 面板（diff、stage、worktree 合回、生成提交信息）。
- `owc run` cli 支持。

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

发布镜像托管在 GitHub Container Registry（`ghcr.io/snnh/openwebcode`），内置完整运行时（core、Node 24、bubblewrap、git、python3），数据目录用命名卷持久化：

```sh
# 1. 在仓库根目录启动（拉取 GHCR 发布镜像）
docker compose up -d

# 2. 查看访问链接 —— 非回环监听下首次启动自动生成访问令牌，链接含 token
docker compose logs | grep 访问链接
```

浏览器打开日志里的链接（`http://<主机IP>:3210/?token=<令牌>`）。不用 compose 时等价于：

```sh
docker run -d --name openwebcode --restart unless-stopped \
  -p 3210:3210 -v openwebcode-data:/data \
  ghcr.io/snnh/openwebcode:latest
docker logs openwebcode | grep 访问链接
```

- **数据**：保留在命名卷 `openwebcode-data`；升级 = `docker compose pull && docker compose up -d`，数据不动。
- **工作区**：可选挂载宿主机目录（compose 里取消 `./workspace:/workspace:rw` 与 `OWC_WORKSPACE` 的注释，入口脚本自动修正目录属主）。
- **沙盒**：默认 Landlock（宿主机内核 ≥ 5.13）；需要完整 bubblewrap 命名空间隔离时在 compose 放开 `security_opt: seccomp=unconfined`（宿主机还需允许非特权 user namespace）。不可用时 core 自动降级，属设计内行为。
- **从源码构建**：`docker build -t openwebcode .`，或在 compose 里取消 `build:` 注释。镜像内布局、构建与发布说明见 [`packaging/README.md`](./packaging/README.md) 的「Docker 镜像」一节。

### 首次使用

1. 在 **设置 → 模型目录** 添加并启用一个模型服务商（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种接口都支持），然后刷新模型目录。
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
| `@路径` | 引用工作区文件，内容随消息一起注入 |
| `!命令` | shell 快捷前缀，走 bash 权限链执行 |

注：agent 运行时发的消息会进入 steering 队列。

## Headless CLI

```sh
owc run "给 main.ts 加个单元测试" --cwd . --json --yolo
```

- `--json` 输出 NDJSON 事件流，方便脚本解析；`--yolo` 自动批准权限请求（CI 场景）。
- `--session <id>` 接着已有会话继续；`--tools` / `--exclude-tools` / `--read-only` 可以限制工具范围。
- 退出码：`0` 完成，`1` agent 出错，`2` 权限被拒绝。

## 性能与资源占用

开发机实测（Windows x86-64 1.7.6版本，5000 条消息基准数据集；基准脚本与验收门禁在 [`scripts/bench/`](./scripts/bench/)）：

| 组件 | 内存占用 | CPU（折合为单核的95%时间占用） | 关键指标 |
|---|---|---|---|
| server（Node 服务层） | 空闲约 74 MiB；载入 5000 消息大会话后稳态约 115 MiB | 低于0.5% | 大会话冷载 24ms、历史分页 p50 0.6ms；上下文增量构建 p50 0.35ms（较全量构建 31× 加速）；agent 主循环每轮堆增量 0.9 MiB；事件分发 5800+ events/s；10 万文件索引查询 p50：符号约 15ms、文件约 21ms |
| core（C 执行器） | 空闲约 9 MiB；10 万文件重负载扫描峰值约 15 MiB，结束即回落 | 低于0.5% | 全仓索引扫描（10 万文件）约 33s 内完成且内存可控 |
| 浏览器端 | 5000 消息会话满载堆约 93 MiB | - | 长列表滚动 p50 59.9 fps；输入回显 p50 26.5ms；持续滚动内存增长 0.1%（无泄漏）；聊天/工作台/分享页按需分包，首屏脚本 479 KB |

生产环境参考（v1.7.6，Debian 13 x86-64，常驻实测）：server 110 MiB + 扩展宿主 52 MiB + core 1.9 MiB（server 较 v1.5.0 的 135 MiB 下降约 19%），CPU 95%时间占用低于0.5%。

## 文档

- [`help/usage.md`](./help/usage.md) — 使用帮助：启动、面板、快捷键、模型与成本、自定义扩展点模板
- [`help/faq.md`](./help/faq.md) — 常见问题：模型接入、权限与沙盒、快照回滚、CLI 集成、故障排查
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

设置保存在 `<数据目录>/server-settings.json`。
数据目录顺序：
显式设置 `OWC_DATA_DIR`>平台默认值（Windows 是 `%USERPROFILE%\openwebcode`，Linux 是 `~/.local/share/openwebcode`）
密钥、会话数据和全局扩展点都在数据目录里，POSIX 下权限一律 0600/0700。项目级的覆盖配置放在项目根目录的 `.owc/` 下。

## 卸载

- **Windows**：「设置 → 应用」里卸载。
- **Linux**：推荐运行安装时落盘的 `~/.local/bin/owc-uninstall`（会一并处理 systemd unit 残留）；或手动 `rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc ~/.local/bin/owc-uninstall`。
注：数据目录默认保留

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
