# openwebcode

## 安装

### Windows（MSI）

从 Releases 下载 `openwebcode-<version>-windows-x64.msi` 双击安装（默认 `C:\Program Files\openwebcode`，需管理员权限）。装完运行安装目录下 `bin\owc.cmd`（或把 `bin` 加入 PATH 后任意终端 `owc`），浏览器打开 <http://127.0.0.1:3000>。卸载走「设置 → 应用」。

### Linux（tar.gz）

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh --prefix ~/.local    # 可选 --with-systemd 注册用户级服务
~/.local/bin/owc                  # 浏览器打开 http://127.0.0.1:3000
```

卸载：`rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc`（详见 `packaging/install.sh` 头部注释）。

### 从源码构建

- core：`cmake -S core -B build && cmake --build build`（测试：`ctest --test-dir build`）
- server：`cd server && npm ci && npm run build && npm start`
- web：`cd web && npm ci && npm run build`（产物由 server 静态托管）

布局与流水线细节见 `packaging/README.md`。