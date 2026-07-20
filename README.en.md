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
- Run commands in Windows AppContainer, Windows Sandbox, Job Object, or Linux Landlock.
- Keep background shell tasks running while continuing the conversation.
- Render GFM Markdown, syntax-highlighted code, KaTeX equations, and collapsed reasoning blocks.
- Control context eviction, restoration, compaction, token budgets, and cost budgets per session.
- Extend the system with skills, commands, hooks, sub-agents, MCP servers, and Extension Host packages.
- Automate jobs with the non-interactive `owc run` CLI and NDJSON event output.

## Install

### Windows

1. Download `openwebcode-<version>-windows-x64.msi` from [Releases](https://github.com/snnh/openwebcode/releases).
2. Install it, then run `owc` from a terminal after adding the installed `bin` directory to `PATH`.
3. Open <http://127.0.0.1:3000>.

### Linux

```sh
mkdir openwebcode
tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh --prefix ~/.local       # optionally add --with-systemd
~/.local/bin/owc
```

Open <http://127.0.0.1:3000> after the service starts.

## First run and interface language

The first visit follows the browser language: Chinese browsers use Simplified Chinese and other browsers use English. To change it later, open **Settings → Appearance → Language**. The selection takes effect immediately, is stored in local storage as `owc-language`, and updates the document language used by assistive technology.

Then configure a model provider under **Settings → Server**. Anthropic and OpenAI-compatible endpoints are supported, including services such as DeepSeek, Qwen, and Ollama. Refresh the model catalog, create a session from the **+** button, choose a workspace and model, and describe the task in the composer.

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

## Security and recovery

Permission mode and sandbox mode are independent. `yolo` skips interactive approval but never disables the sandbox. The path policy applies `denyPaths > writeRoots > readRoots`. Use Windows Sandbox for untrusted code; it runs one ephemeral VM per session.

Automatic snapshot mode creates a checkpoint before every user turn. Native Btrfs, ZFS, and ReFS backends are detected when available, with a git shadow repository as the fallback. Managed workspaces use VHDX or qcow2 differential images for low-cost snapshots.

## Extension points

Project configuration lives under `<workspace>/.owc/` and overrides matching global entries under the data directory:

- `agents/*.md` — named sub-agent definitions;
- `commands/*.md` — slash-command templates;
- `skills/*/SKILL.md` — on-demand skills;
- `hooks.json` — lifecycle shell hooks;
- `mcp.json` — stdio or HTTP MCP servers.

The independent Extension Host also manages installable `owc-ext-*` packages. Three official extensions are included: Context Manager, Attention Optimizer, and Content Lens.

## Headless CLI

```sh
owc run "Add a unit test for main.ts" --cwd . --json --yolo
```

- `--json` emits one NDJSON event per line.
- `--yolo` automatically allows permission requests for CI use.
- `--session <id>` continues an existing session.
- Exit codes are `0` for success, `1` for an agent error, and `2` for denied permission.

## Build from source

Requirements: Node.js 20 or newer, CMake 3.16 or newer, a C11 compiler, and Python 3 for core protocol tests.

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

- [`help/usage.md`](./help/usage.md) — user guide (Chinese)
- [`help/faq.md`](./help/faq.md) — troubleshooting and FAQ (Chinese)
- [`help/development.md`](./help/development.md) — development guide (Chinese)
- Internal design notes under `docs/` are maintained locally and are not distributed through the remote repository.
- [`packaging/README.en.md`](./packaging/README.en.md) — packaging and release pipeline

## Data locations

Installed launchers use `%LOCALAPPDATA%\openwebcode` on Windows and `${XDG_DATA_HOME:-~/.local/share}/openwebcode` on Linux. Source runs default to `../.openwebcode` relative to the server directory unless `OWC_DATA_DIR` is set.

Session data includes metadata, append-only message JSONL, context ledgers, artifacts, sub-agent state, and checkpoints. Uninstalling the application does not delete user data automatically.
