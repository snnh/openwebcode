# OpenWebCode

English | [简体中文](./README.md)

An AI coding workbench that runs in your browser. It supports Windows and Linux and includes sandboxed execution, reversible snapshots, context management, and a bilingual Chinese/English interface.

```text
Browser (React) ── HTTP/WebSocket ──► Node service (agent loop and tools) ── JSON-RPC ──► C executor (commands, files, sandbox)
```

## Highlights

- Let an agent inspect and edit project files, run commands and tests, and continue autonomously across multiple turns.
- Use Plan mode for read-only investigation before switching to Build mode.
- Create automatic or manual checkpoints and roll back files together with conversation history.
- Run commands in Windows Job Object (default), AppContainer, Windows Sandbox, or Linux Landlock.
- Keep background shell tasks running while continuing the conversation.
- Render GFM Markdown, syntax-highlighted code, KaTeX equations, and collapsed reasoning blocks; reasoning and tool calls render in their true interleaved order, and adjacent tool calls collapse into a foldable group.
- Control context eviction, restoration, compaction, token budgets, and cost budgets per session.
- Extend the system with skills, commands, hooks, sub-agents, MCP servers, and Extension Host packages.
- Automate jobs with the non-interactive `owc run` CLI and NDJSON event output.

## Install

### Windows

1. Download `openwebcode-<version>-windows-x64.msi` from [Releases](https://github.com/snnh/openwebcode/releases).
2. Install it, then run `owc` from a terminal after adding the installed `bin` directory to `PATH`.
3. Open <http://127.0.0.1:3000>.

### Linux

x86_64, aarch64 (arm64), and Loongson loongarch64 are supported; the online installer picks the right package for your architecture automatically:

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
```

Or download the tar.gz for your architecture manually (`linux-x64` / `linux-arm64` / `linux-loongarch64`):

```sh
mkdir openwebcode
tar -xzf openwebcode-<version>-linux-<arch>.tar.gz -C openwebcode
cd openwebcode
# In a TTY, choose prefix, port, data directory, host, and Node.js interactively.
./install.sh
~/.local/bin/owc
```

The loongarch64 package ships no bundled Node.js and requires a system Node.js ≥ 24 (`--use-system-node`; when the package has no `node/` directory the installer takes that path automatically).

For scripts and CI, use `--yes` to suppress prompts:

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3000 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

See [`packaging/README.md`](./packaging/README.md) for every installer option, system Node.js, and user-systemd details.

Open <http://127.0.0.1:3000> after the service starts.

## First run and interface language

The first visit follows the browser language: Chinese browsers use Simplified Chinese and other browsers use English. To change it later, open **Settings → Appearance → Language**. The selection takes effect immediately, is stored in local storage as `owc-language`, and updates the document language used by assistive technology.

Then add and enable one or more named model providers under **Settings → Model Catalog**, choosing the Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses interface. Refresh the catalog; the unified picker shows each entry as `Model ID【Provider】`. Create a session from the **+** button, choose a workspace and model, and describe the task in the composer. A managed workspace first copies its source directory into a disk image; while the session is idle, use **Snapshot now** in the header to create a virtual-disk differential snapshot. Use **Sync back to source** in the Files panel to review changes and explicitly write them back.

Closing the browser tab does not stop an active agent. The server continues the job and persists its output. Reopen the UI and select the session to replay missed events. Use **Stop** when you want to cancel a job.

## Composer shortcuts

| Input | Action |
| --- | --- |
| Plain text | Send instructions to the agent |
| `/skill-name` | Invoke a skill |
| `/custom-command` | Expand a command template from `.owc/commands/` |
| `/compact` | Create a structured context overview |
| `/compact tools` | Compact tool calls with deterministic rules |
| `/clear` | Clear the current model context while retaining reversible history |
| `@path` | Reference a workspace file and inject its content with the message |
| `!command` | Run a shell shortcut through the normal permission chain |

Messages sent while a job is running enter the Steering queue and are injected on the next turn. The default shortcut is Enter to send and Shift+Enter for a new line; it can be changed under Settings.

## Key capabilities

**Agent tools**: bash (including background tasks; the shell is probed per platform — Windows `pwsh > Git Bash > cmd`, Linux `bash > pwsh > $SHELL`, with pwsh enforceable per session), file read/write/edit, glob/grep, `repo_map`/`code_search` (workspace symbol index), `test_runner` (structured diagnostics), `spawn_task`/`spawn_swarm` (isolated-context sub-agents; the swarm fans out several tasks in parallel), `remember` (long-term memory), `todo_write` (live task list), and `web_fetch`/`web_search` (SSRF-guarded), plus tools injected by MCP servers and extensions. Tool schemas, tool-specific prompt guidance, and MCP discovery are sent only to models whose catalog capability enables tools; other models continue as normal chat. Web tools are configured through a shared registry of named provider profiles, each declaring its Search/Fetch capabilities, with the active profile chosen per capability; a tool and its prompt guidance are omitted when no profile with the required capability is selected.

**Sub-agents**: built-in `explore` (read-only exploration) and `general` (read/write, running under the same permission chain and identically configured sandbox as the main agent) types, plus custom sub-agent definitions (frontmatter can declare the toolset, model, provider, and model role); `spawn_swarm` dispatches 2–16 templated tasks at once (concurrency cap 4, excess queued), with per-item agent and model-role overrides. Live cards in the chat track, main-window tabs, and the Subagents panel monitor progress and transcripts in real time, and the panel can also launch sub-agents manually.

**Sessions and the session tree**: conversation history is stored as a tree — a user message offers Edit & resend, Regenerate, and Fork (old branches are always kept), and the Timeline panel can continue from any node. The sidebar manages multiple sessions with rename and pin.

**Permissions**: ask / acceptEdits / review / yolo. "Allow once" approves only the current call, which starts after the response is delivered; "always allow" creates a persistent rule. The review tier routes calls that need confirmation through a reviewer model (the fast model or the session's current model): LOW risk is auto-approved with a `permission.reviewed` audit event, while HIGH risk, a failed review, or an unparseable verdict always falls back to a human, and `git_commit` always requires manual approval. Neither "always allow" nor yolo disables the sandbox — the two mechanisms are orthogonal.

**Sandbox** (on by default): Windows Job Object (default, AppContainer optional), Windows Sandbox (one ephemeral VM per session, for untrusted code), and Linux Landlock. Capability probes report the actual enforcement level (enforced/partial/advisory). The path policy applies `denyPaths > writeRoots > readRoots`. On Windows 11 24H2+, optional Bind Link directory bindings (requires running as administrator) transparently map virtual paths inside the session workspace to real directories outside it — useful for shared dependency caches.

**Snapshots and rollback**: automatic checkpoint before every user turn, or switch to manual-only. Native Btrfs, ZFS, and ReFS backends are auto-detected, with a git shadow repository as the fallback. Managed workspaces keep the project on a VHDX/qcow2 image disk, where differential-chain snapshots are near-instant and can branch; **Snapshot now** in the header creates an image checkpoint whenever the session is idle. They never overwrite the source directory when a session closes or is deleted: the Files panel can generate a three-way diff at any time, and confirmation writes back only conflict-free changes.

**Context management**: token-budget ledger, rolling eviction with placeholder restoration, two fast-model compaction modes, and forced overview compaction at the 85% watermark. The session header shows live context-window usage and the cache-hit rate; the Context panel breaks token attribution down per segment with watermark hints. The frontend always shows full history; eviction only affects the LLM view.

**Models**: multiple named providers can be saved and enabled independently, each pulling or manually maintaining its model list; identically named models coexist per provider. Hot-swap models from the unified list mid-session, with thinking levels, cache-breakpoint optimization, and per-provider cost reports. Four model roles (premium/balanced/fast/cheap) plus a session-default model can be assigned in Settings: sub-agent dispatch accepts a `role` parameter to route each task to a different model — hard problems go to premium, bulk chores to cheap — with costs attributed to the model actually used.

**Custom extension points** (project `.owc/` plus a global level; project entries override same-named global ones):

- `agents/*.md` — dedicated sub-agents (frontmatter declares the toolset, model, provider, and model role; invoked via `spawn_task agent=<name>`);
- `commands/*.md` — slash-command templates (`$ARGUMENTS` / `$1..$9` substitution);
- `hooks.json` — shell hooks for PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart / SessionEnd / PreCompact / PostCompact / Notification / SubagentStart / SubagentStop; Pre-class events veto on exit 2;
- `skills/` — skills triggered by `/name`, with the body loaded on demand;
- `mcp.json` — MCP client configuration (stdio and HTTP transports).

**Extension Host**: an independent child process (IPC, 5-second hook guard, manifest permissions and persistence management). Third-party extensions get the same API surface as the official ones: tool registration, sessions/context/events access, prompt hooks, private storage, REST route registration, a model-completion channel, prompt/tool shaping, and per-session extension state (see `examples/extensions/demo`). Six official extensions ship built in: context-manager, attention-optimizer, content-lens, pdf-to-image, env-sim (persona simulation, switching the prompt style and tool shapes to another product's conventions), and the owc-eval regression harness. Only context-manager and pdf-to-image are enabled by default; the rest are toggled and tuned in Settings, and third-party `owc-ext-*` packages can be installed from a local directory. When enabled, the owc-eval panel replays deterministic mock-provider tasks in isolated workspaces, persists baseline/candidate comparisons with regression and improvement summaries, and exports self-contained JSON reports.

**Index, diagnostics, and SCM**: the symbol index is extracted on the core side and feeds `repo_map`/`code_search`; after `test_runner` runs tests, builds, or lints, structured diagnostics land in the Problems panel grouped by file with click-to-line navigation; the SCM panel shows the branch and change diffs with inline stage/unstage/discard, a commit-history section, and one-click worktree merges, generates commit messages (committing always requires confirmation, even under yolo), and refreshes automatically after agent file writes. The Files panel previews large files with pagination, renders images directly, and offers a rendered/source toggle for Markdown.

**Online update from the WebUI**: when Settings finds a new version, one click updates in place — Windows downloads the MSI and launches the installer for an overwrite upgrade; Linux replaces the install directory and restarts. Release assets ship with SHA256SUMS.txt, and the online install/update flows enforce the checksum; the launcher, systemd unit, and data directory are preserved.

**Session lifecycle**: closing the browser does not stop the agent; reconnecting replays missed events; permission requests stay suspended until you respond (**no timeout** — on long tasks, remember to come back and confirm).

**Misc**: multimodal image input (paste/drag), session export/import (JSONL), session sharing (a self-contained read-only `export.html`), and storage GC.

## Headless CLI

```sh
owc run "Add a unit test for main.ts" --cwd . --json --yolo
```

- `--json` emits one NDJSON event per line.
- `--yolo` automatically allows permission requests for CI use.
- `--session <id>` continues an existing session.
- Exit codes are `0` for success, `1` for an agent error, and `2` for denied permission.

## Build from source

Requirements: Node.js 20 or newer, CMake 3.19 or newer, a C11 compiler, and Python 3 for core protocol tests.

```sh
# Core executor
cmake -S core -B build
cmake --build build --config Debug
ctest --test-dir build -C Debug --output-on-failure

# Server
cd server
npm ci
npm run build
npm test

# Web UI
cd ../web
npm ci
npm run build
npm test
```

The server serves `web/dist`. Distribution layout, clean staging, local packaging, smoke testing, and the release workflow are documented in [`packaging/README.en.md`](./packaging/README.en.md).

## Documentation

- [`CHANGELOG.md`](./CHANGELOG.md) — version history (Chinese)
- [`help/usage.md`](./help/usage.md) — user guide (Chinese)
- [`help/faq.md`](./help/faq.md) — troubleshooting and FAQ (Chinese)
- [`help/development.md`](./help/development.md) — development guide (Chinese)
- Internal design notes under `docs/` are maintained locally and are not distributed through the remote repository.
- [`packaging/README.en.md`](./packaging/README.en.md) — packaging and release pipeline

## Data locations

The boot/settings directory is chosen by the launch path: an explicitly set `OWC_DATA_DIR` wins; otherwise the installed launcher injects `%USERPROFILE%\openwebcode` on Windows or `${XDG_DATA_HOME:-~/.local/share}/openwebcode` on Linux. Only a direct `node server/dist/index.js` run that bypasses the launcher uses the `../.openwebcode` fallback relative to the `server` directory. Use absolute paths for `OWC_DATA_DIR` and the Settings page’s Data directory to avoid server-directory-relative resolution.

The Settings page is persisted as `<boot/settings directory>/server-settings.json`. When `OWC_DATA_DIR` is not set, its saved Data directory value selects the business data directory on the next launch; the settings file itself remains in the boot/settings directory. Without that saved override, both directories are the same.

Session data includes metadata, append-only message JSONL, context ledgers, artifacts, sub-agent state, and checkpoints. Other files under the business data directory include `provider-profiles.json` (provider and web-search profiles with keys), the global `{agents,commands,skills}/` extension points, `hooks.json` (**same trust level as yolo**), `mcp.json`, and `extensions/`; `<cwd>/.owc/` holds project-level overrides.

## Uninstall

- **Windows**: uninstall from Settings → Apps. The default data directory `%USERPROFILE%\openwebcode` is kept, and so is any data directory chosen through `OWC_DATA_DIR`.
- **Linux**: `rm -rf ~/.local/lib/openwebcode ~/.local/bin/owc`; user data is kept.

## Sponsor

OpenWebCode is an open-source project maintained by one person. If it helps your work, consider sponsoring via [donate.md](./donate.md) to support ongoing development.

## Acknowledgments

1. Thanks to deepseek、kimi-k3、qwen for assisting development.
2. Thanks to community friends for inspiration.
3. Thanks to [pi-agent](https://github.com/earendil-works/pi); the default system prompt is adapted from its baseline (MIT, by Mario Zechner).
