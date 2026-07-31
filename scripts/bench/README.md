# OpenWebCode 基准体系（scripts/bench）

0.4.x 计划 §5.4 的可重复基准。目标：用固定数据集、固定参数把关键性能路径量化成
机器可读的 JSON，让“回归 > 15%”有据可查。已在 `release.yml` 的 benchmark job 中接入 CI：
对比上一 release 的基准资产，任一可比指标回归超过 15% 记为警告（不阻断发布）；
基准运行本身不完整（缺场景结果）则阻断。上一 release 基线缺失时跳过对比（不阻断），
`workflow_dispatch` 可用 `bootstrap_benchmark_baseline` 显式建立首次基线；紧急手动发布可显式设置
`skip_performance_tests` 跳过整个 benchmark job，tag 触发不可跳过，且跳过时不生成基准资产。

## 运行方式

仓库根目录下（tsx 复用 server 的依赖，不在根新增任何依赖）：

```bash
TSX=server/node_modules/.bin/tsx

# 0. 生成固定数据集（只需一次；确定性，重跑逐字节一致）
$TSX scripts/bench/generate-dataset.mjs

# 1. 长历史会话加载（5000 消息 / 1000 工具块）
$TSX scripts/bench/bench-long-history.mjs

# 2. 长流式（~1 MiB/s 突发 token delta，合批开/关对照）
$TSX scripts/bench/bench-long-stream.mjs

# 3. 慢 WS 客户端背压（慢客户端断连 + 正常客户端不受影响）
$TSX scripts/bench/bench-slow-client.mjs

# 4. 多工具回合（50 tool_call + 50 tool_result 事件流）
$TSX scripts/bench/bench-multi-tool.mjs

# 5. 上下文构建稳态（全量 vs 增量 buildView，验收 speedup >= 2x）
$TSX scripts/bench/bench-context-build.mjs

# 6. 浏览器渲染（Playwright，需先 npm run build --prefix web && npx playwright install chromium）
$TSX scripts/bench/browser/bench-browser-render.mjs

# 对比两份结果（回归 > 15% 标红、退出码 1）
$TSX scripts/bench/compare.mjs <baseline.json> <candidate.json>
```

每个基准支持 `--out <path>` 指定结果输出路径，默认写
`scripts/bench/results/<scenario>.json`（覆盖式；要留基线请先自行复制）。

典型对比工作流：

```bash
$TSX scripts/bench/bench-long-history.mjs --out results/baseline.json
# ... 改动被测代码 ...
$TSX scripts/bench/bench-long-history.mjs
$TSX scripts/bench/compare.mjs results/baseline.json results/long-history.json
```

## 结果 JSON 格式

```jsonc
{
  "schemaVersion": 1,
  "scenario": "long-history",
  "timestamp": "…ISO…",
  "environment": { "node", "platform", "arch", "cpu", "cpuCount", "totalMemMB", "commit" },
  "metrics": [
    { "name": "load.p50", "value": 9.04, "unit": "ms", "direction": "lower-better" }
  ]
}
```

- `direction` 决定回归方向：`lower-better` 涨幅 > +15% 记回归；
  `higher-better` 跌幅 > -15% 记回归；`none` 只展示不判定（如 closeCode、数据集规模）。
- 可选 `minDelta`：绝对增量地板（单位同指标）。百分比越阈但绝对增量不超过
  `minDelta` 时不记回归（显示 `[噪声内]`），用于亚毫秒级指标在共享 CI runner 上的防抖。
- 数值只在**同环境**对比时有意义；`environment` 用于比对两次运行是否可比。

## 场景清单

| 场景 | 脚本 | 测量路径 | 关键指标 |
| --- | --- | --- | --- |
| 长历史会话 | `bench-long-history.mjs` | `SessionStore.getTail()/getMessagesBefore()/list()` 真实分页 5000 消息数据集，并在临时副本连续追加消息 | 冷启动、首屏/向前分页、追加索引刷新 p50/p95、堆内存增量 |
| 长流式 | `bench-long-stream.mjs` | 真实 server + WS 客户端，~1 MiB/s 突发 `message.delta`，合批 16ms / 直发对照 | 端到端延迟 p50/p95、吞吐、服务端内存增量 |
| 慢 WS 客户端 | `bench-slow-client.mjs` | 真实 server，慢客户端（socket pause）+ 正常客户端并发 | 慢客户端断连耗时/关闭码、正常客户端交付数/吞吐 |
| 多工具回合 | `bench-multi-tool.mjs` | 真实 server + WS，50 tool_call + 50 tool_result 事件流 | 端到端延迟 p50/p95、事件吞吐 events/s、内存增量 |
| 上下文构建稳态 | `bench-context-build.mjs` | ContextManager 全量 vs 增量 buildView（5000 消息数据集） | 全量/增量 p50/p95、加速比、命中率 |
| 浏览器渲染 | `browser/bench-browser-render.mjs` | Playwright + 真实 server，5000 消息会话 | 滚动 fps、输入回显延迟、内存增长 |

设计约束：

- **不改被测代码行为**：插桩只走既有配置项（`EventBus` 构造器的
  `deltaBatchWindowMs`、`buildServer` 的 `wsBackpressureLimits`）。
- **确定性可重复**：数据集由固定 seed（`generate-dataset.mjs` 中 `SEED`）的
  PRNG 生成；事件总量、洪峰条数均为常量。
- 数据集与结果目录（`data/`、`results/`）已 gitignore，不进版本库。
- 慢客户端基准背压阈值压到 256KB（与
  `server/test/event-stream-backpressure.test.ts` 同手法），避免真的打满 4MB 内核缓冲。

## 阈值语义

对比脚本以 15% 为回归线（§5.4）：任一可比指标越线即标 `[回归]` 并以退出码 1
结束，供 CI/脚本消费；release.yml 的 benchmark job 将该退出码降级为警告（不阻断发布），
仅当基准运行本身不完整（缺场景结果）时阻断。长历史场景分别记录首次 byte-offset 索引构建、缓存分页和
追加后增量扩展；`appendRefresh.p50/p95` 会使重新退化为每次全量建索引的实现触发告警。

## 后续场景 TODO（§5.4 全量清单）

- [x] 多工具回合（50 工具/run）：`bench-multi-tool.mjs`，测事件路径端到端延迟与吞吐
- [ ] 大仓库索引与补全（10 万文件）：需固定文件树生成器 + 索引/补全入口基准
- [x] 上下文构建稳态耗时：`bench-context-build.mjs`，全量 vs 增量 buildView 对比，验收加速比 >= 2.0x
- [x] 浏览器渲染基准：`browser/bench-browser-render.mjs`，Playwright 真实浏览器三项指标
- [x] CI 接入：release 流程默认跑基准并归档结果；基线缺失跳过对比、回归 > 15% 降级为警告、基准运行不完整则阻断，手动触发可显式跳过
- [x] 诊断页接入：turn 各阶段耗时 / 事件吞吐 / 渲染帧率采样（脱敏）

扩展方式：新场景加 `bench-<name>.mjs`（复用 `lib/common.mjs` 的
`startBenchServer` / `writeResult`），需要新数据集就在 `generate-dataset.mjs`
加一个生成函数，场景名进结果 JSON 的 `scenario` 字段即可被 `compare.mjs` 对比。
