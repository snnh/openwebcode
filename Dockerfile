# syntax=docker/dockerfile:1
# OpenWebCode 镜像（多阶段构建）
#
# builder  阶段：在 node:24-trixie（Debian 13，与项目开发/实测环境一致）上
#           编译三层产物 —— core（C，cmake Release）、server（tsc）、web（vite）。
# runtime  阶段：node:24-trixie-slim 组装最小运行树（与发行版 staging 契约一致，
#           见 core/CMakeLists.txt 的 CPack 注释），以非特权用户 node 运行。
#
# 构建：docker build -t openwebcode .
# 发布：tag 推送后由 .github/workflows/docker.yml 构建 linux/amd64,linux/arm64
#       并推送到 ghcr.io/snnh/openwebcode（vX.Y.Z；稳定版另加 latest）。

########## builder ##########
FROM node:24-trixie AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake gcc make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# 依赖层缓存：lockfile 未变时 npm ci 层可复用
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix server --ignore-scripts \
 && npm ci --prefix web --ignore-scripts

# core：Release 构建（镜像构建不跑测试，测试门禁由 CI 负责）
COPY core core
RUN cmake -S core -B /build/core -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
 && cmake --build /build/core --target owc-exec --parallel

# server：tsc 编译 -> dist/
COPY server server
RUN npm run build --prefix server

# web：tsc + vite 打包 + bundle 体积检查 -> dist/
COPY web web
RUN npm run build --prefix web

# 裁剪 server 生产依赖（devDependencies 不进镜像）
RUN npm prune --prefix server --omit=dev

########## runtime ##########
FROM node:24-trixie-slim AS runtime

# 运行时依赖：
#   bubblewrap  完整命名空间沙盒（不可用时 core 自动降级 Landlock，属设计内行为）
#   git         SCM 集成与 git-shadow 快照后端
#   python3     agent 任务 / Chat 模式 Python 回退环境
#   bash        POSIX 首选 shell（shell-detect.ts：bash > pwsh > $SHELL）
#   curl        容器健康检查
#   tini        PID 1（信号转发 / 僵尸回收）
#   procps      ps/kill 等进程工具
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap git curl ca-certificates bash python3 tini procps \
 && rm -rf /var/lib/apt/lists/*

# 非特权运行用户：node 官方镜像内置 node 用户（uid/gid 1000，/home/node），
# 与多数桌面宿主用户一致，bind 挂载开箱即用；/workspace 为默认工作区根（OWC_BROWSE_ROOTS）
RUN mkdir -p /workspace \
 && chown node:node /workspace

# 运行树（staging 契约）：
#   bin/owc-exec                       core 可执行文件
#   server/dist|package.json|node_modules|assets   服务端产物与生产依赖
#   web/dist                           前端静态资源（server 按 ../.. 解析托管）
COPY --from=builder /build/core/owc-exec /opt/openwebcode/bin/owc-exec
COPY --from=builder /src/server/dist /opt/openwebcode/server/dist
COPY --from=builder /src/server/package.json /opt/openwebcode/server/package.json
COPY --from=builder /src/server/node_modules /opt/openwebcode/server/node_modules
COPY --from=builder /src/server/assets /opt/openwebcode/server/assets
COPY --from=builder /src/web/dist /opt/openwebcode/web/dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# OWC_HOST=0.0.0.0：非回环监听，服务端首次启动自动生成访问令牌
# （/data/access-token，0600），带 token 的访问链接打印在容器日志；
# 容器内不做原地自更新（升级 = 拉新镜像），显式关闭更新检查。
ENV OWC_CORE_PATH=/opt/openwebcode/bin/owc-exec \
    OWC_DATA_DIR=/data \
    OWC_HOST=0.0.0.0 \
    OWC_PORT=3210 \
    OWC_BROWSE_ROOTS=/workspace \
    OWC_UPDATE_CHECK_ENABLED=false \
    HOME=/home/node

VOLUME ["/data"]
EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3210/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
