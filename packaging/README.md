# 分发与打包

[中文](./README.md) | [English](./README.en.md)

打 tag `v*`（或 Actions 手动触发 `release` 工作流并输入 tag）后，
`.github/workflows/release.yml` 产出两个分发物并上传到该 tag 的 GitHub Release：

| 产物 | 平台 | 内容 |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows | CPack/WiX 安装包 |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux | tar.gz + 顶层 `install.sh` |
| `install-online.sh` | Linux | `curl \| bash` 在线安装/更新脚本 |
| `SHA256SUMS.txt` | 全平台 | 两个发行包的 SHA-256 校验和 |

`<version>` 为 tag 去掉前导 `v`（如 `v0.5.2` → `0.5.2`）。

## 包内布局

两个分发物解开后是同一棵运行时树（staging 契约见 `core/CMakeLists.txt` 末尾注释）：

```
bin/owc-exec(.exe)      core 可执行文件（沙箱/文件操作后端）
bin/owc.cmd             Windows 启动脚本（仅 MSI；由 packaging/owc.cmd 生成）
server/dist/            服务端编译产物，入口 dist/index.js
server/package.json     "type": "module" 声明（dist 为 ESM，必需）
server/node_modules/    生产依赖（npm prune --omit=dev 之后）
server/assets/          运行时资产（refs-clone.ps1 等）
web/dist/               前端静态资源（server 按 server/dist/../../web/dist 解析托管）
node/                   固定版本 Node 24 运行时（Windows: node.exe；Linux: bin/node 及完整发行目录）
install.sh              Linux 安装脚本（仅 tar.gz，位于包顶层）
```

## 打包流程总览

正式分发包必须经过同一条流水线，不能只把 `server/dist` 或 `web/dist` 单独压缩：

1. 安装锁文件指定的 Server/Web 依赖；
2. 构建 Debug core，运行 core 的 ctest，并以真实 `owc-exec` 运行 Server 测试；
3. 构建并测试 Web；
4. 将 Server 依赖裁剪为 production-only；
5. 构建 Release core；
6. 从空目录组装 `build/stage/`，加入固定版本的 Node 24 运行时和平台启动脚本；
7. 先对 staging 做结构检查和启动冒烟，再生成 MSI 或 tar.gz；
8. 计算校验值，并由 GitHub Release 发布产物。

其中第 2、3 步是发布门禁。`npm prune --omit=dev` 会移除 Server 的开发依赖，因此应在测试完成后执行；继续开发前重新运行 `npm --prefix server ci`。

## Windows（MSI）

### 环境要求

- Windows x64；
- Node.js 20 或更新版本（只用于构建，包内 Node 版本由 `$NodeVersion` 固定）；
- CMake 3.19 或更新版本（MSI 的 WiX 自定义命名空间由此版本的 CPack 提供）；
- Visual Studio 2022 Build Tools，安装“使用 C++ 的桌面开发”；
- WiX Toolset v3（`candle.exe`、`light.exe` 可通过 PATH 或 `WIX` 环境变量找到）；
- PowerShell 5.1 或更新版本。

以下命令都从仓库根目录执行。

### 1. 构建并通过发布测试门禁

```powershell
$ErrorActionPreference = "Stop"
$Version = "0.5.2"
$NodeVersion = "24.18.0"

npm --prefix server ci
npm --prefix server run build

cmake -S core -B build-debug -A x64
cmake --build build-debug --config Debug --parallel
$env:OWC_CORE_PATH = (Resolve-Path "build-debug\Debug\owc-exec.exe").Path
npm --prefix server test
Remove-Item Env:OWC_CORE_PATH

npm --prefix web ci
npm --prefix web run build
npm --prefix web test
```

### 2. 构建 Release core 并组装干净 staging

```powershell
# 测试通过后才能裁剪依赖；该命令会移除 server 的 devDependencies。
npm --prefix server prune --omit=dev
Remove-Item server\node_modules\@fastify\send\test -Recurse -Force -ErrorAction SilentlyContinue

cmake -S core -B build -A x64 -DCPACK_PACKAGE_VERSION=$Version
cmake --build build --config Release --target owc-exec --parallel

# 正式打包必须从空 staging 开始，避免残留旧的 Vite 哈希资源或依赖。
Remove-Item build\stage -Recurse -Force -ErrorAction SilentlyContinue
@(
  "build\stage\bin",
  "build\stage\server",
  "build\stage\web",
  "build\stage\node"
) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

Copy-Item build\Release\owc-exec.exe build\stage\bin\
Copy-Item server\dist build\stage\server\dist -Recurse -Force
Copy-Item server\package.json build\stage\server\
Copy-Item server\node_modules build\stage\server\node_modules -Recurse -Force
Copy-Item server\assets build\stage\server\assets -Recurse -Force
Copy-Item web\dist build\stage\web\dist -Recurse -Force

# 下载并嵌入与 CI 相同的 Node 运行时。
$NodeZip = "build\node-v$NodeVersion-win-x64.zip"
$NodeExtract = "build\node-runtime"
Remove-Item $NodeExtract -Recurse -Force -ErrorAction SilentlyContinue
Invoke-WebRequest `
  "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" `
  -OutFile $NodeZip
Expand-Archive $NodeZip -DestinationPath $NodeExtract -Force
Copy-Item "$NodeExtract\node-v$NodeVersion-win-x64\node.exe" build\stage\node\node.exe

# cmd.exe 使用的启动脚本统一写成无 BOM 的 ASCII + CRLF。
$Launcher = (Get-Content packaging\owc.cmd -Raw) -replace "`r?`n", "`r`n"
[IO.File]::WriteAllText(
  (Join-Path $PWD "build\stage\bin\owc.cmd"),
  $Launcher,
  [Text.Encoding]::ASCII
)
```

### 3. 检查 staging 并生成 MSI

```powershell
$Required = @(
  "build\stage\bin\owc-exec.exe",
  "build\stage\bin\owc.cmd",
  "build\stage\server\dist\index.js",
  "build\stage\server\package.json",
  "build\stage\server\node_modules",
  "build\stage\server\assets",
  "build\stage\web\dist\index.html",
  "build\stage\node\node.exe"
)
$Missing = $Required | Where-Object { -not (Test-Path $_) }
if ($Missing) { throw "staging 缺少：$($Missing -join ', ')" }

# 可选冒烟：启动后访问 http://127.0.0.1:3000/api/health，确认成功再按 Ctrl+C。
$env:OWC_DATA_DIR = Join-Path $env:TEMP "openwebcode-package-smoke"
& build\stage\bin\owc.cmd
Remove-Item Env:OWC_DATA_DIR

cpack --config build\CPackConfig.cmake -G WIX -C Release
.\packaging\verify-wix-options.ps1 -MsiPath "openwebcode-$Version-windows-x64.msi"
Get-FileHash "openwebcode-$Version-windows-x64.msi" -Algorithm SHA256
```

`cpack` 的输出位于仓库根目录。`verify-wix-options.ps1` 会读取 MSI 数据库，确认 Shell integration 页、条件桌面快捷方式/PATH 组件和 UAC 属性传递都存在。若 WiX 报字符编码错误，确认 `server/node_modules/@fastify/send/test` 已被移除；若包内界面仍是旧版本，删除整个 `build/stage` 后重新组装，不要在旧目录上覆盖。

### 安装与卸载

- 双击安装，默认装到 `C:\Program Files\openwebcode\`（需要管理员权限；升级码固定，可覆盖升级）。
- 安装会始终创建“开始”菜单的 **OpenWebCode** 快捷方式（启动 `bin\owc.cmd`）。在“Shell integration”页可勾选创建桌面快捷方式，以及将 `<安装目录>\bin` 添加到**运行安装程序的用户**的 `PATH`；两个选项默认勾选，重新打开终端后可直接运行 `owc`。不勾选 PATH 时仍可从安装目录运行 `bin\owc.cmd`。
- 卸载默认保留 `%LOCALAPPDATA%\openwebcode`。如确认要删除**默认**用户数据，可在拥有 MSI 文件时显式执行：

  ```powershell
  msiexec /x "openwebcode-<version>-windows-x64.msi" PURGE_DATA=1
  ```

  此选项不会删除通过 `OWC_DATA_DIR` 指定的其他数据目录，也不会删除任意工作区中的 `.owc/`（包括 PDF 上传文件）。升级安装不会触发清理。目前安装器没有“删除数据”图形复选框，避免误导用户以为未实现的 UI 能控制该破坏性操作。

  维护时不要给 `WixRemoveFoldersEx` 追加第二个 WiX 排序条目：WiX v3 的 `RemoveFolderEx` 已自行在 `CostInitialize` 前排程。`wix-patch.xml` 仅在它之前按条件把私有目录属性从保留的惰性路径替换为默认数据目录，以保持默认卸载不清理数据。

## Linux（tar.gz）

Linux 使用与 Windows 相同的测试门禁和 production-only 依赖。核心差异是 Release core 为单配置构建，并把完整 Node Linux 发行目录放入 staging：

```sh
set -euo pipefail
VERSION=0.5.2
NODE_VERSION=24.18.0

npm --prefix server ci
npm --prefix server run build
cmake -S core -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build-debug --parallel
OWC_CORE_PATH="$PWD/build-debug/owc-exec" npm --prefix server test

npm --prefix web ci
npm --prefix web run build
npm --prefix web test
npm --prefix server prune --omit=dev
rm -rf server/node_modules/@fastify/send/test

cmake -S core -B build -DCMAKE_BUILD_TYPE=Release -DCPACK_PACKAGE_VERSION="$VERSION"
cmake --build build --target owc-exec --parallel

rm -rf build/stage
mkdir -p build/stage/{bin,server,web,node}
cp build/owc-exec build/stage/bin/
cp -r server/dist server/package.json server/node_modules server/assets build/stage/server/
cp -r web/dist build/stage/web/
curl -fsSLo build/node.tar.gz \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"
tar -xzf build/node.tar.gz -C build/stage/node --strip-components=1

test -x build/stage/bin/owc-exec
test -x build/stage/node/bin/node
test -f build/stage/server/dist/index.js
test -f build/stage/web/dist/index.html

tar -czf "openwebcode-${VERSION}-linux-x64.tar.gz" \
  -C build/stage . \
  -C "$PWD/packaging" install.sh
sha256sum "openwebcode-${VERSION}-linux-x64.tar.gz"
```

解包到临时目录后运行 `./install.sh --yes --prefix <临时前缀>`，再访问 `/api/health`，可完成安装包级冒烟。仓库内另有不进入发行 tar.gz 的脚本级回归：`sh packaging/test-install.sh`。

### 安装与卸载

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
# TTY 中会交互询问未由命令行指定的安装项。
./install.sh
~/.local/bin/owc
```

`install.sh` 把运行时树复制到 `<prefix>/lib/openwebcode/`（重跑整体覆盖，幂等），
并生成启动脚本 `<prefix>/bin/owc`。安装前缀必须是绝对路径；脚本会在创建后以物理路径规范化，拒绝根目录，避免相对路径或符号链接把运行时树绑到不确定位置。

| 选项 | 行为 |
| --- | --- |
| `--prefix <绝对路径>` | 安装前缀，默认 `$HOME/.local`。 |
| `--port <1-65535>` | 写入启动器的 `OWC_PORT` 默认值；`04312` 会规范化为 `4312`。 |
| `--data-dir <绝对路径>` | 写入启动器的 `OWC_DATA_DIR` 默认值；不能是 `/`。 |
| `--host <地址>` | 写入 `OWC_HOST` 默认值，默认 `127.0.0.1`。非回环地址会告警并自动生成 `OWC_ACCESS_TOKEN` 写入启动器；server 对非回环监听强制要求 ≥32 字符的 `OWC_ACCESS_TOKEN` 与逗号分隔 http(s) 源的 `OWC_ALLOWED_ORIGINS`，否则拒绝启动。只应在受信网络或认证反向代理之后使用。 |
| `--use-system-node` | 不复制包内 `node/`，安装时要求 `PATH` 中存在绝对路径的 Node.js **24+**。包内 Node 缺失时也会安全地改走这一模式。 |
| `--with-systemd` | 写用户级 `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/openwebcode.service`，不自动执行 `systemctl`。按提示运行 `systemctl --user daemon-reload && systemctl --user enable --now openwebcode` 后常驻。 |
| `--yes` / `-y` | 即使 stdin/stdout 是 TTY 也不提问；适用于 CI、重定向和脚本。 |

未传 `--yes` 且 stdin/stdout 都是 TTY 时，脚本只询问没有由命令行指定的 prefix、port、data-dir、host、是否使用系统 Node.js 和是否写用户级 systemd unit；命令行选项优先。非 TTY 不会读取输入，因此不会卡住 CI。安装时生成的值只是默认值，运行时显式设置的 `OWC_PORT`、`OWC_DATA_DIR`、`OWC_HOST` 仍然优先。

例如，自动化安装可写成：

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3000 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

`--system` 和 `--with-desktop-entry` 目前未实现，脚本会明确失败而不是伪装为完成系统级安装或桌面集成。卸载：`rm -rf <prefix>/lib/openwebcode <prefix>/bin/owc`（加 systemd unit 与数据目录，见 `install.sh` 头部注释）。

### 在线安装与更新

`packaging/install-online.sh` 是不落盘的 `curl | bash` 安装/更新脚本（POSIX sh），适合一条命令完成安装或升级：

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
# 指定版本、前缀并跳过交互：
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh \
  | bash -s -- --version 0.6.0 --prefix /opt/openwebcode --yes
```

脚本从 GitHub Releases 下载 `openwebcode-<version>-linux-x64.tar.gz` 与 `SHA256SUMS.txt`，先用 `sha256sum --check`（只取目标行；无 `sha256sum` 时回落 `shasum -a 256`）校验，失败即中止，再解压到 `mktemp -d` 临时目录（退出时自动清理）。依赖仅为 curl 或 wget、tar、校验工具，不依赖 jq。

| 选项 | 行为 |
| --- | --- |
| `--version <x.y.z>` | 目标版本；缺省查询 `https://api.github.com/repos/snnh/openwebcode/releases/latest` 的 `tag_name`（sed/grep 解析）。 |
| `--prefix <绝对路径>` | 安装前缀，默认 `$HOME/.local`；用于判定全新安装还是更新，并透传给包内 `install.sh`。 |
| `--yes` / `--port` / `--host` / `--data-dir` / `--with-systemd` / `--use-system-node` | 原样透传给包内 `install.sh`（仅全新安装时生效；更新模式不重建启动器，会提示这些参数被忽略）。 |

两种模式：

- **全新安装**：调用解压出的 `install.sh`，行为与离线安装完全一致（生成 `<prefix>/bin/owc`、可选 `--with-systemd`）。
- **更新**：`<prefix>/lib/openwebcode/server/dist/index.js` 已存在时进入更新模式——整体替换 `<prefix>/lib/openwebcode/` 内容为新版，保留 `<prefix>/bin/owc` 启动器与已写入的 systemd unit 不动，数据目录不受影响。目标目录不可写时会给出明确错误（可能需要 sudo 或修正权限）。完成后按提示重启：存在用户级 unit 时 `systemctl --user restart openwebcode`，否则手动重启正在运行的 `owc`。

下载基址可用环境变量 `OWC_INSTALL_BASE_URL` 覆盖（默认 `https://github.com/snnh/openwebcode/releases/download/v<version>`），便于镜像或 `file://` 本地测试。

## owc 启动脚本行为

`owc`（Linux shell 脚本）/ `owc.cmd`（Windows）做三件事：

1. `export OWC_CORE_PATH=<包内 owc-exec>`——server 默认按源码树相对位置找 core，安装布局必须显式指定；
2. 端口与监听地址：显式 `OWC_PORT`/`OWC_HOST` 已设则沿用，否则使用安装时选择的默认值（初始为 **3000** / `127.0.0.1`；server 自身端口兜底是 3210，见 `server/src/config.ts`）；
3. 数据目录：显式 `OWC_DATA_DIR` 优先；未设置时，Linux 启动器使用安装时选择的默认值（初始为
   `${XDG_DATA_HOME:-~/.local/share}/openwebcode`），Windows 启动器注入 `%LOCALAPPDATA%\openwebcode`。只有不经启动脚本
   直接运行 `node server/dist/index.js` 时，才用相对 server 目录的 `../.openwebcode` 作为启动/设置目录兜底。
   `server-settings.json` 固定保留在该目录；环境变量未设时，其中保存的 `dataDir` 会在重启后选择业务数据目录。
   `OWC_DATA_DIR` 与 `dataDir` 建议使用绝对路径。

运行时优先使用包内 `node/`。Linux 在安装时判定：包内 Node 缺失或指定 `--use-system-node` 时把启动器绑定到系统 Node.js（安装时校验 >= 24），不做运行时回落；Windows 启动器在包内 `node.exe` 缺失时回落 PATH 中的 `node`。

## 开发期间快速更新 staging

此流程只适合已有完整 staging 的本地联调，不能代替上面的正式干净打包。`build/stage/` 是完整运行时树，不是只放单个可执行文件的输出目录。修改 Server/Web 后至少重新执行：

```powershell
npm --prefix server run build
npm --prefix web run build
Copy-Item -Recurse -Force server\dist\* build\stage\server\dist\
Copy-Item -Recurse -Force web\dist\* build\stage\web\dist\
```

Server 模块在进程启动时加载，复制后必须重启 `build\stage\bin\owc.cmd`。Vite 入口引用带哈希的 assets；若重启后仍看到旧界面，使用 `Ctrl+F5` 强制刷新。正式发布应按 CI 流程重建整个 staging，并确保 `server/node_modules/` 只含生产依赖，而不是长期在旧目录上叠加文件。

## CI 发布流水线（release.yml）

- 触发：`push: tags: ["v*"]`，或 `workflow_dispatch` 输入 tag（tag 不存在时基于当前提交创建）。手动触发可显式启用 `skip_performance_tests` 跳过性能基准；默认关闭，tag 触发不允许跳过。仅首次建立基线时可显式启用 `bootstrap_benchmark_baseline` 允许无上一版本基线。
- **版本一致性检查**（仅 tag 触发）：tag 去掉前导 `v` 后必须同时等于 `server/package.json` 的 `version` 和 `core/CMakeLists.txt` 的 `project(VERSION)`，不一致即在两个平台 job 的第一步失败。
- **测试门禁**：Windows 与 Linux 两个平台 job 各自跑 core ctest、以真实 `owc-exec` 运行 Server 测试、Web 构建与测试；发布 job 要求两个平台全绿（加上 benchmark job，见下）才会执行。
- Windows：构建测试通过后裁剪生产依赖 → CMake Release 构建 core → 按契约组装 `build/stage/`
  （下载固定版本 Node 24 win-x64 zip，对照官方 `SHASUMS256.txt` 校验后取 `node.exe`）→ `cpack -G WIX`
  → `verify-wix-options.ps1` 校验 Shell integration → `msiexec` 静默安装、`/api/health` 冒烟、卸载 → 上传 MSI。
- Linux：同样构建测试后组装 `build/stage/`（Node 24 linux-x64 tar.gz 同样经 `SHASUMS256.txt` 校验后整树解入 `node/`），
  `tar -C stage . -C packaging install.sh` 打包 → 临时前缀 `./install.sh --yes` 安装并 `/api/health` 冒烟 → 上传 tar.gz。
- bundled Node 版本固定在 workflow 的 `env.NODE_DIST_VERSION`（当前 24.18.0），升级时改这一个常量；下载一律对照 nodejs.org 官方 `SHASUMS256.txt` 校验，不硬编码哈希。
- benchmark job 默认是 release 的依赖；回归对比为警告级（回归超 15% 只告警，不阻断发布），但当前构建必须产出全部基准场景结果，缺场景即失败。无上一 release 基线或基线资产下载失败时告警并跳过对比（不阻断），除非显式启用 `bootstrap_benchmark_baseline`。结果以 `bench-results-*.json` 同 MSI/tar.gz 一起发布，供下一版下载为基线。仅手动发布显式启用 `skip_performance_tests` 时允许跳过，且该次 release 不包含基准 JSON。
- Release 由 `softprops/action-gh-release@v2` 创建/更新，发布说明取自 `CHANGELOG.md` 的 `## [版本]` 段落（缺失或为空会阻断发布），非草稿；同时生成 `SHA256SUMS.txt` 并自检。

推荐发布方式是先推送已审核提交，再创建并推送语义化版本 tag：

```sh
git tag -a v0.5.2 -m "OpenWebCode v0.5.2"
git push origin v0.5.2
```

也可在 GitHub Actions 中手动运行 `release`，输入形如 `v0.5.2` 的 tag。默认要求 Windows、Linux 与 benchmark job 全部成功；紧急发布可显式启用 `skip_performance_tests`，此时仍要求两个平台 job 成功，但不运行性能基准，也不上传基准 JSON。发布后应核对下载文件名、校验和、安装/启动和 `/api/health`。
