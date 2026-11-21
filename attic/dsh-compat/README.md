# dsh 兼容模式（已归档）

本目录保留 dsh（DeepSeek Harness）兼容模式的源码、测试、vendor 抓取脚本与用户文档，供未来重新设计或恢复时参考。**当前主分支不编译、不测试、不加载这里的任何文件，也没有任何运行入口。**

归档时对应 OpenWebCode 1.17.1 之后的未发布版本。兼容模式曾是实验功能，默认关闭，依赖 dsh `0.1.6-alpha.2` 的 vendor 产物。

## 目录

路径与移除前保持一致，便于恢复：

```
server/src/dsh/                        兼容层源码（loader、垫片宿主、Typert Remote 翻译、独立端口 SPA 托管）
server/test/dsh-*.test.ts              兼容模式单测与集成测试（不含 dsh-sync-*）
server/test/helpers/dsh-vendor-*.ts    vendor 契约测试辅助
server/test/fixtures/dsh-plugins*/     插件加载测试 fixture
server/assets/dsh-bridge/              随包发布的前端桥接插件
scripts/fetch-dsh-web.mjs              钉版 dsh UI vendor 抓取脚本
web/src/app/dsh-mode-sync.ts           前端设置读取、入口 URL 与未就绪提示
web/src/test/dsh-mode-router.test.ts   前端入口同步测试
help/dsh-compat.md                     原用户文档
```

## 移除的接线点

恢复时需要重新接回以下位置（按当前代码结构，具体行号会变）：

- `server/src/config.ts`：`dshCompat` 配置字段与 `OWC_DSH_COMPAT_ENABLED` / `OWC_DSH_PORT` / `OWC_DSH_UI_PATH` 解析。
- `server/src/settings-service.ts`：`dshCompatEnabled`、`dshPort`、`dshUiPath` 三个字段与 `requireDshPort` 校验。
- `server/src/index.ts`：`DshCompatRuntime` 构造、设置变更监听、启动同步、`dshStatus` 注入与关闭。
- `server/src/app.ts` / `server/src/routes/system.ts`：`GET /api/dsh/status` 与其依赖类型。
- `server/src/extensions/extension-manager.ts`：dsh 插件扫描、伪扩展 API 分发、工具前置/后置钩子桥、宿主启动/重载后的加载计划重放。
- `server/src/extensions/extension-host-process.ts`：dsh 宿主运行时、事件派发、`dsh.sync` / `dsh.beforeTool` / `dsh.afterTool` 通道与关闭清理。
- `server/src/extensions/types.ts`：`HostRequest.method` 里的三个 dsh 通道名。
- **注意**：`server/src/extensions/dsh-sync-session-events.ts` 是从归档的 `session-events.ts` 抽出的独立投影（图片尺寸改用 dsh-sync 自己的 `imageSize()`），`dsh-sync` 导出依赖它；恢复兼容层时不要把两者合并回带兼容运行时依赖的版本。
- `web/src/app/App.tsx` / `ui-store.ts` / `workbench/Rail.tsx` / `workbench/Workbench.tsx`：设置同步、活动栏/移动端入口与 store 字段。
- `web/src/lib/api.ts`：`dshStatus()`。
- `web/src/settings/sections/shared.ts`：三个设置项的英文文案覆盖。
- `server/knip.json`：三个 shim entry 与 fixture / bridge ignore。
- `Dockerfile`、`.github/workflows/release.yml`、`.github/workflows/server.yml`：vendor 抓取步骤；发布 tar 需重新加入 `fetch-dsh-web` 或其替代实现。
- `packaging/install.sh`、`packaging/install-online.sh`：原 `--dsh-compat` 安装开关。
- `README.md` / `README.en.md` / `help/usage.md` / `help/faq.md` / `help/development.md` / `packaging/README.md`：用户入口与开发说明。

## 恢复步骤

1. 把本目录下的 `server/`、`web/`、`scripts/`、`help/` 内容按原相对路径移回仓库。
2. 按上面的接线点逐项恢复；注意 `extension-manager.ts` 与 `extension-host-process.ts` 已不再 import `server/src/dsh/`，需要重新加入。
3. 恢复 `server/knip.json` 的 shim entry 与 fixture/bridge ignore。
4. 重新执行 `node scripts/fetch-dsh-web.mjs` 生成 `server/assets/dsh-web/`（gitignored），或重新设计 vendor 产出方式。
5. 重新加入三份设置项、Web 入口、安装参数和发布/CI 抓取步骤。
6. 跑 `cd server && npm test`、`cd web && npm test`，并重新评估下面的已知失败。

## 已知状态

归档时兼容模式的测试并非全绿；恢复后需要先修：

- `server/test/dsh-services.test.ts`：5 个用例失败（服务缝/工具钩子桥未按预期激活）。
- `server/test/dsh-plugins-host.test.ts`：4 个用例失败（宿主插件加载与工具注册）。
- 依赖 vendor 的测试在缺少 `server/assets/dsh-web/` 时会跳过；恢复后先跑抓取脚本。
- `dsh-sync` 扩展与 `dsh-minimal` 拟态**没有归档**，仍在主分支维护；它们不依赖本目录的兼容运行时。

## 清理旧部署

兼容模式入口下线后，旧部署可能仍有 vendor、插件数据与设置残留。显式清理方式：

```sh
# Linux 安装器 / 在线更新
./install.sh --purge-dsh-compat --yes --prefix <prefix> --data-dir <dataDir>
./install-online.sh --purge-dsh-compat --prefix <prefix> --data-dir <dataDir>

# 跨平台独立脚本
node scripts/purge-dsh-compat.mjs --prefix <prefix> --data-dir <dataDir> --yes
```

清理会删除受管的 `dsh-web`、`dsh-bridge`、`<dataDir>/dsh-plugins`、`<dataDir>/dsh.json`，并从 `server-settings.json` 移除三个 dsh 设置键；`dshUiPath` 指向的自选 UI 目录只打印、不删除。
