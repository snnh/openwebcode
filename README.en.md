<div align="center">
  <img src="./assets/icon.png" alt="OpenWebCode" width="96">
  <h1>OpenWebCode</h1>
  <p><strong>An AI coding workbench that runs in your browser</strong></p>
  <p>
    <a href="https://github.com/snnh/openwebcode/releases"><img src="https://img.shields.io/github/v/release/snnh/openwebcode" alt="Release"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational" alt="Platform">
  </p>
  <p>English | <a href="./README.md">简体中文</a></p>
</div>

**README_en.md translated by kimi-k3**

OpenWebCode is an AI coding workbench that runs in your browser, with a bilingual Chinese/English interface, natively supporting Windows (x86-64) and Linux (x86-64 / arm64 / loongarch64). Install it locally, open your browser, and let the agent read code, edit files, and run commands and tests for you.

```text
Browser (React) ── HTTP/WebSocket ──► Node service (agent loop, tools) ── JSON-RPC ──► C executor (commands, files, sandbox)
```

## System requirements

1. Server:
   1. OS: Windows 10+ (Windows 7 untested) or Linux
      - Linux version: glibc ≥ 2.28; kernel ≥ 5.13 (Landlock baseline; ≥ 6.7 adds network denial), and installing bubblewrap enables full namespace isolation. Developed and verified on Debian 13 / Ubuntu 24.04
      - A HarmonyOS port is in development
   2. Architectures: x86-64 / arm64 / loongarch64 (the Loongson package ships no bundled Node.js and needs system Node.js ≥ 24)
   3. CPU: dual-core 2.0 GHz
   4. Memory: ≥ 512 MiB free
   5. Disk: ≥ 500 MiB free

2. Client:
   Any device that can run Chrome / Edge ≥ 111 or Firefox ≥ 113 (including phones and tablets)

## Features

- The basics of AI coding.
- More than code: a brand-new ChatGPT-style chat mode, still lightweight.
- Resource usage friendly to low-spec devices: see [Performance and footprint](#performance-and-footprint).
- Comparatively complete sandbox support: Job Object / AppContainer / WSB on Windows, bubblewrap / Landlock on Linux.
- Git and filesystem-level snapshots: ZFS / Btrfs / overlayfs / VHDX / qcow2 backends.
- Better context management.
- Multi-model support: multiple providers coexist with hot switching, four model roles routed per task, and automatic fallback along a per-session chain when the primary model errors.
- Sub-agents and agent swarms: isolated-context parallel dispatch with live progress and transcripts.
- A good range of extension points: skills, slash commands, hooks, custom sub-agents, MCP, and third-party Extension Host packages.
- Free-form session management: edit any message, fork anytime.
- Built-in symbol index (`repo_map` / `code_search`), test diagnostics (Problems panel), and an SCM panel (diffs, staging, worktree merges, generated commit messages).
- The `owc run` CLI.

See the [user guide](./help/usage.md) and [FAQ](./help/faq.md) (both in Chinese) for details.

## Quick start

### Windows

1. Download `openwebcode-<version>-windows-x64.msi` from [Releases](https://github.com/snnh/openwebcode/releases) and install it (administrator rights required).
2. Open a new terminal and run `owc`, or use `bin\owc.cmd` from the install directory.
3. Open <http://127.0.0.1:3210>.

### Linux

1. x86_64, aarch64 (arm64), and Loongson loongarch64 are supported; the online installer picks the right package automatically:

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
```

2. Or download the tar.gz for your architecture, extract it, and run `./install.sh` (an interactive terminal asks for the install prefix, port, and data directory; add `--yes` in scripts or CI to skip the questions).

Note: the loongarch64 package ships no bundled Node.js and requires system Node.js ≥ 24. See [`packaging/README.en.md`](./packaging/README.en.md) for every installer option and the systemd unit.

### Docker (Linux / macOS, x86_64 / arm64)

Release images are hosted on GitHub Container Registry (`ghcr.io/snnh/openwebcode`) with the full runtime baked in (core, Node 24, bubblewrap, git, python3); user data lives in a named volume:

```sh
# 1. Start from the repository root (pulls the GHCR release image)
docker compose up -d

# 2. Find the access link — the server auto-generates an access token on first
#    start because it listens off-loopback; the link includes the token
docker compose logs | grep 访问链接
```

Open the link from the logs (`http://<host-ip>:3210/?token=<token>`). Without compose, the equivalent is:

```sh
docker run -d --name openwebcode --restart unless-stopped \
  -p 3210:3210 -v openwebcode-data:/data \
  ghcr.io/snnh/openwebcode:latest
docker logs openwebcode | grep 访问链接
```

- **Data**: kept in the named volume `openwebcode-data`; upgrade by `docker compose pull && docker compose up -d` — data is untouched.
- **Workspace**: optionally bind-mount a host directory (uncomment `./workspace:/workspace:rw` and `OWC_WORKSPACE` in the compose file; the entrypoint fixes the top-level ownership).
- **Sandbox**: Landlock by default (host kernel ≥ 5.13); for full bubblewrap namespace isolation uncomment `security_opt: seccomp=unconfined` in compose (the host must also allow unprivileged user namespaces). The core degrades gracefully when bwrap is unavailable — by design.
- **Build from source**: `docker build -t openwebcode .`, or uncomment `build:` in the compose file. Image layout, build, and publishing details are in the "Docker image" section of [`packaging/README.en.md`](./packaging/README.en.md).

### First run

1. Under **Settings → Model Catalog**, add and enable a model provider (Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses interfaces are all supported), then refresh the catalog.
2. Click **+** in the sidebar to create a session: pick a working directory, provider/model, and sandbox mode.
3. Describe the task in the composer and press Enter.

## Composer shortcuts

| Input | Action |
| --- | --- |
| Plain text | Send instructions to the agent |
| `/skill-name` | Invoke a skill |
| `/custom-command` | Expand a template from `.owc/commands/` |
| `/compact` | Compact context (`tools` for rule-based compaction) |
| `/clear` | Clear the current view; **history is kept** and reversible |
| `@path` | Reference a workspace file and inject its content with the message |
| `!command` | Shell shortcut through the normal permission chain |

Note: messages sent while the agent is running enter the steering queue.

## Headless CLI

```sh
owc run "Add a unit test for main.ts" --cwd . --json --yolo
```

- `--json` emits one NDJSON event per line for scripts; `--yolo` auto-approves permission requests (for CI).
- `--session <id>` continues an existing session; `--tools` / `--exclude-tools` / `--read-only` restrict the tool surface.
- Exit codes: `0` done, `1` agent error, `2` permission denied.

## Performance and footprint

Measured on a dev machine (Windows x86-64, v1.6.5, 5000-message benchmark dataset; harness and acceptance gates live in [`scripts/bench/`](./scripts/bench/)):

| Component | Memory | CPU (single-core equivalent, 95th percentile of time) | Key numbers |
| --- | --- | --- | --- |
| server (Node service) | ~86 MiB idle; ~100 MiB steady-state with a 5000-message session loaded | 0.8% | Large-session cold load 23ms, history paging p50 0.49ms; incremental context build p50 0.33ms (33× faster than full builds); agent-loop heap churn 0.9 MiB per turn; event dispatch 5300+ events/s; symbol-index queries over 100k files p50 ~16–21ms |
| core (C executor) | ~9 MiB idle; ~25 MiB peak under heavy scans, released afterwards | under 0.5% | 3.4MB file read in 8ms; full-repo index scan (hundreds of thousands of files) completes in 25s with bounded memory |
| browser | ~92 MiB heap with a 5000-message session fully loaded | - | Long-list scrolling p50 59.9 fps; input echo p50 27ms; 0.1% memory growth across repeated scroll cycles (no leak); chat/workbench/share views are lazy-loaded bundles, first-load script 475 KB |

Production reference (v1.6.5, Debian 13 x86-64, measured on a systemd-managed always-on instance): server 114 MiB + extension host 50 MiB + core 1.9 MiB (server down ~15% from 135 MiB on v1.5.0), CPU below 0.5% 95% of the time.

## Documentation

- [`help/usage.md`](./help/usage.md) — user guide: startup, panels, shortcuts, models and costs, extension-point templates (Chinese)
- [`help/faq.md`](./help/faq.md) — FAQ: model setup, permissions and sandbox, snapshot rollback, CLI integration, troubleshooting (Chinese)
- [`help/development.md`](./help/development.md) — development guide: repository layout, the three builds, test conventions, entry points, CI and release (Chinese)
- [`packaging/README.en.md`](./packaging/README.en.md) — packaging, distribution layout, installers, and the release pipeline
- [`CHANGELOG.md`](./CHANGELOG.md) — version history (Chinese)

## Build from source

Requirements: Node.js ≥ 20, CMake ≥ 3.19, a C11 compiler, and Python 3 (for the core protocol tests). Each layer builds independently — there is no root `package.json`:

```sh
cmake -S core -B build && cmake --build build && ctest --test-dir build   # core (C executor)
cd server && npm ci && npm run build && npm test                          # server (Node service)
cd web && npm ci && npm run build && npm test                             # web (served statically by server)
```

## Data and configuration

Settings live in `<data directory>/server-settings.json`. The data directory resolves in this order: an explicitly set `OWC_DATA_DIR` wins; otherwise the launcher injects the platform default (`%USERPROFILE%\openwebcode` on Windows, `~/.local/share/openwebcode` on Linux); only bypassing the launcher with a direct `node server/dist/index.js` falls back to `.openwebcode` next to `server`. Keys, session data, and global extension points all live in the data directory (0600/0700 permissions on POSIX). Project-level overrides go in `.owc/` at the project root.

## Uninstall

- **Windows**: uninstall from Settings → Apps.
- **Linux**: `rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc`.

Note: the data directory is kept by default.

## Sponsor

OpenWebCode is an open-source project maintained by one person. If it helps your work, consider sponsoring via [donate.md](./donate.md) to support ongoing development.

## Acknowledgments

1. Thanks to deepseek, kimi-k3, and qwen for assisting development.
2. Thanks to community friends for inspiration.
3. Thanks to [pi-agent](https://github.com/earendil-works/pi); the default system prompt is adapted from its baseline (MIT, by Mario Zechner).
4. Thanks to [Shyliuli](https://github.com/Shyliuli) for helping test the Loongson (loongarch64) build.

## License

[Apache-2.0](./LICENSE)
