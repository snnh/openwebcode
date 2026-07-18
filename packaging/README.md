# 分发与打包

打 tag `v*`（或 Actions 手动触发 `release` 工作流并输入 tag）后，
`.github/workflows/release.yml` 产出两个分发物并上传到该 tag 的 GitHub Release：

| 产物 | 平台 | 内容 |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows | CPack/WiX 安装包 |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux | tar.gz + 顶层 `install.sh` |

`<version>` 为 tag 去掉前导 `v`（如 `v0.1.0` → `0.1.0`）。

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
node/                   Node 20 运行时（Windows: node.exe；Linux: bin/node 及完整发行目录）
install.sh              Linux 安装脚本（仅 tar.gz，位于包顶层）
```

## Windows（MSI）

- 双击安装，默认装到 `C:\Program Files\openwebcode\`（需要管理员权限；升级码固定，可覆盖升级）。
- 运行 `bin\owc.cmd` 启动（或把 `<安装目录>\bin` 加入 PATH 后在任意终端运行 `owc`），
  浏览器打开 <http://127.0.0.1:3000>。
- 卸载：Windows「设置 → 应用」里移除 openwebcode；用户数据留在 `%LOCALAPPDATA%\openwebcode`，按需手删。

## Linux（tar.gz）

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh --prefix ~/.local            # 可选 --with-systemd
~/.local/bin/owc
```

- `install.sh` 把运行时树复制到 `<prefix>/lib/openwebcode/`（重跑整体覆盖，幂等），
  并生成启动脚本 `<prefix>/bin/owc`。
- `--with-systemd` 额外写 `~/.config/systemd/user/openwebcode.service`，按提示
  `systemctl --user daemon-reload && systemctl --user enable --now openwebcode` 即可常驻。
- 卸载：`rm -rf <prefix>/lib/openwebcode <prefix>/bin/owc`
  （加 systemd unit 与数据目录，见 install.sh 头部注释）。

## owc 启动脚本行为

`owc`（Linux shell 脚本）/ `owc.cmd`（Windows）做三件事：

1. `export OWC_CORE_PATH=<包内 owc-exec>`——server 默认按源码树相对位置找 core，安装布局必须显式指定；
2. 端口：`OWC_PORT` 已设则沿用，否则默认 **3000**（server 自身兜底值是 3210，见 `server/src/config.ts`）；
3. 数据目录：`OWC_DATA_DIR` 已设则沿用，否则 Linux 默认 `${XDG_DATA_HOME:-~/.local/share}/openwebcode`，
   Windows 默认 `%LOCALAPPDATA%\openwebcode`。不经启动脚本直接跑 `node server/dist/index.js` 时，
   server 兜底为 `../.openwebcode`（相对 server 目录解析，会落进安装树）。

运行时优先使用包内 `node/`，缺失时回落系统 `node`（要求 >= 20）。

## CI 发布流水线（release.yml）

- 触发：`push: tags: ["v*"]`，或 `workflow_dispatch` 输入 tag（tag 不存在时基于当前提交创建）。
- Windows：`npm ci/build`（server+web）→ CMake Release 构建 core → 按契约组装 `build/stage/`
  （含下载 Node 20 win-x64 zip 取 `node.exe`）→ `cpack -G WIX` → 上传 MSI。
- Linux：同样构建后组装 `build/stage/`（下载 Node 20 linux-x64 tar.gz 整树解入 `node/`），
  `tar -C stage . -C packaging install.sh` 打包 → 上传 tar.gz。
- bundled Node 版本固定在 workflow 的 `env.NODE_DIST_VERSION`（当前 20.19.0），升级时改这一个常量。
- Release 由 `softprops/action-gh-release@v2` 创建/更新，`generate_release_notes: true`，非草稿。
