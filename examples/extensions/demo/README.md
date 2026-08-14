# 扩展示例（owc-ext-demo）

演示 1.1.0 起对第三方扩展开放的 API 面：

- **私有存储** `ctx.storage.*`（无需权限）：`<dataDir>/extensions-data/demo/notes.json` 读写便签。
- **私有 HTTP 路由**（权限 `http:route`）：`GET/POST/DELETE /api/ext/demo/notes`。
- **快速模型通道**（权限 `model:fast`）：`ext__demo__summarize` 工具经快速模型做摘要。
- **会话上下文读取**（权限 `context:read`，注册工具另需 `tools:register`）：`ext__demo__vault_peek` 工具经 `ctx.context.readVaultFile` 只读读取会话 `compact/` 归档（compact-vault 扩展产出）。
- **提示词钩子**（权限 `prompt:shape`）：读取会话级扩展状态 `extensionState.demo.tagline`，注入系统提示词段落。

## 安装

方式一：把本目录复制为 `<数据目录>/extensions/owc-ext-demo/`（数据目录解析见 `help/usage.md`，Windows 默认 `%USERPROFILE%\openwebcode`），重启 server。

方式二：用 install REST（路径必须是绝对路径）：

```sh
curl -X POST http://localhost:3210/api/extensions \
  -H 'content-type: application/json' \
  -d '{"action":"install","path":"/绝对路径/examples/extensions/demo"}'
```

安装后在设置页启用 `demo` 扩展（或 `POST /api/extensions` 带 `{"id":"demo","enabled":true}`）。

## 试用

```sh
# 写一条便签
curl -X POST http://localhost:3210/api/ext/demo/notes \
  -H 'content-type: application/json' -d '{"text":"hello extension"}'
# 读便签列表
curl http://localhost:3210/api/ext/demo/notes

# 设置会话级扩展状态（<id> 为会话 id）
curl -X PUT http://localhost:3210/api/sessions/<id>/config \
  -H 'content-type: application/json' \
  -d '{"extensionState":{"demo":{"tagline":"本会话由 demo 扩展加持。"}}}'
```

`ext__demo__summarize` 工具需要先在设置里配置快速模型（`model:fast` 通道走 FastModelClient）。

`ext__demo__vault_peek` 供模型在会话中调用，参数形如 `{ "sessionId": "<会话id>", "path": "summary.md" }`，读取 `<会话目录>/compact/` 内的归档文件；无归档或文件缺失时返回 `(no archive or file missing)`。
