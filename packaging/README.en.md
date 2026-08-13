# Distribution and Packaging

[中文](./README.md) | [English](./README.en.md)

This page is for people who want to build, deploy, or publish OpenWebCode packages themselves. Day-to-day install steps are in the [root README](../README.md). Every command and behavior described here is grounded in the scripts under `packaging/`, the CPack section of `core/CMakeLists.txt`, and `.github/workflows/release.yml`.

## Release artifacts

Pushing a `v*` tag (or dispatching the `release` workflow manually with a tag input) produces:

| Artifact | Platform | Notes |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows x64 | CPack/WiX installer |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux x86_64 | Runtime tree plus top-level `install.sh`/`uninstall.sh` |
| `openwebcode-<version>-linux-arm64.tar.gz` | Linux aarch64 | Same, natively built on `ubuntu-24.04-arm` |
| `openwebcode-<version>-linux-loongarch64.tar.gz` | Linux LoongArch | Same, cross-compiled on an x64 runner, no bundled Node.js |
| `install-online.sh` | Linux | `curl \| bash` online install/update script, picks the arch from `uname -m` |
| Docker image | Linux x86_64 / arm64 | `ghcr.io/snnh/openwebcode` (built and published by docker.yml on tag pushes; see "Docker image" below) |
| `SHA256SUMS.txt` | All | SHA-256 checksums for the four archives |
| `bench-results-*.json` | All | Benchmark results, used as the regression baseline for the next release |

`<version>` is the tag without its leading `v` (`v1.5.0` → `1.5.0`). For a prerelease tag (e.g. `v1.5.0-beta.1`) the artifact names carry the full version, and the GitHub Release is automatically marked as a pre-release.

## Package layout

The MSI and the tarballs unpack to the same runtime tree. The staging contract lives in the CPack comment block of `core/CMakeLists.txt`:

```
bin/owc-exec(.exe)      core executable (sandbox / file-operation backend)
bin/owc.cmd             Windows launcher (MSI only, generated from packaging/owc.cmd as CRLF)
bin/owc-launch.cmd      Launcher used by the MSI exit-page Launch checkbox (MSI only)
server/dist/            compiled server, entry point dist/index.js
server/package.json     "type": "module" declaration (required, dist is ESM)
server/node_modules/    production dependencies (after npm prune --omit=dev)
server/assets/          runtime assets
web/dist/               frontend static assets (server resolves server/dist/../../web/dist)
node/                   pinned Node runtime (Windows: node.exe only; Linux: full distribution)
install.sh              Linux installer (tarball only, at archive top level)
uninstall.sh            Linux uninstaller (tarball only; installed as <prefix>/bin/owc-uninstall)
```

The bundled Node version is pinned by `env.NODE_DIST_VERSION` in release.yml (currently 24.18.0); bumping it is a one-line change. CI verifies every Node download against the official `SHASUMS256.txt` from nodejs.org instead of hardcoding hashes. loongarch64 has no official Node build, so `node/` is not created and `install.sh` automatically falls back to the system Node.js.

## Version numbers

- `server/package.json`'s `version` holds the full version (`web/package.json` follows in lockstep).
- `core/CMakeLists.txt`'s `project(VERSION)` holds only the numeric base version (`1.5.0-beta.1` stores `1.5.0`). It generates `version.h` via `configure_file` and is reported by `core.ping` — the single version source on the core side.
- Both platform jobs of release.yml verify consistency in their first step: the tag without `v` must equal the server and web `version`, and its numeric base must equal the CMake `project(VERSION)`; any mismatch fails immediately. The check runs for both tag pushes and manual dispatches.
- When invoking CPack: `-DCPACK_PACKAGE_VERSION=<numeric base>` (MSI ProductVersion only accepts numbers) and `-DCPACK_FULL_VERSION=<full version>` (used only for artifact file names). For a stable release the two values are identical.

## Windows MSI

### Prerequisites

- Windows x64, PowerShell 5.1+;
- Node.js ≥ 20 (build only; the bundled Node is pinned by `NODE_DIST_VERSION`);
- CMake ≥ 3.19 (CPack's WiX custom-namespace support comes from this version);
- Visual Studio 2022 Build Tools ("Desktop development with C++");
- WiX Toolset v3 (`candle.exe`/`light.exe` found via PATH or the `WIX` environment variable).

All commands below run from the repository root.

### 1. Build and pass the test gate

```powershell
$ErrorActionPreference = "Stop"
$Version = "1.5.0"          # full version; prerelease e.g. 1.5.0-beta.1
$BaseVersion = ($Version -split "-")[0]
$NodeVersion = "24.18.0"    # keep in sync with NODE_DIST_VERSION in release.yml

npm --prefix server ci
npm --prefix server run build

cmake -S core -B build-debug -A x64
cmake --build build-debug --config Debug --parallel
ctest --test-dir build-debug -C Debug --output-on-failure
$env:OWC_CORE_PATH = (Resolve-Path "build-debug\Debug\owc-exec.exe").Path
npm --prefix server test
Remove-Item Env:OWC_CORE_PATH

npm --prefix web ci
npm --prefix web run build
npm --prefix web test
```

### 2. Prune dependencies, build the Release core, assemble staging

```powershell
# Prune only after tests pass; this removes the server's devDependencies.
# Run npm --prefix server ci again before continuing development.
npm --prefix server prune --omit=dev
# @fastify/send ships test fixtures with directory names WiX v3's code page
# cannot represent; they are unused at runtime, so delete them.
Remove-Item server\node_modules\@fastify\send\test -Recurse -Force -ErrorAction SilentlyContinue

cmake -S core -B build -A x64 -DCPACK_PACKAGE_VERSION=$BaseVersion -DCPACK_FULL_VERSION=$Version
cmake --build build --config Release --target owc-exec --parallel

# Always start from an empty staging tree to avoid stale hashed Vite assets or dependencies.
Remove-Item build\stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path build\stage\bin, build\stage\server, build\stage\web, build\stage\node | Out-Null

Copy-Item build\Release\owc-exec.exe build\stage\bin\
Copy-Item server\dist build\stage\server\dist -Recurse -Force
Copy-Item server\package.json build\stage\server\
Copy-Item server\node_modules build\stage\server\node_modules -Recurse -Force
Copy-Item server\assets build\stage\server\assets -Recurse -Force
Copy-Item web\dist build\stage\web\dist -Recurse -Force

# Download and embed the same Node runtime CI uses.
Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile build\node.zip
Expand-Archive build\node.zip -DestinationPath build\node-runtime -Force
Copy-Item "build\node-runtime\node-v$NodeVersion-win-x64\node.exe" build\stage\node\node.exe

# cmd.exe parses batch files in the OEM code page: launchers must be ASCII without BOM, CRLF endings.
foreach ($f in "owc.cmd", "owc-launch.cmd") {
  $content = (Get-Content "packaging\$f" -Raw) -replace "`r?`n", "`r`n"
  [IO.File]::WriteAllText((Join-Path $PWD "build\stage\bin\$f"), $content, [Text.Encoding]::ASCII)
}
```

### 3. Validate staging, smoke-test, build the MSI

```powershell
$Required = @(
  "build\stage\bin\owc-exec.exe",
  "build\stage\bin\owc.cmd",
  "build\stage\bin\owc-launch.cmd",
  "build\stage\server\dist\index.js",
  "build\stage\server\package.json",
  "build\stage\server\node_modules",
  "build\stage\server\assets",
  "build\stage\web\dist\index.html",
  "build\stage\node\node.exe"
)
$Missing = $Required | Where-Object { -not (Test-Path $_) }
if ($Missing) { throw "staging is missing: $($Missing -join ', ')" }

# Optional smoke test: start it, open http://127.0.0.1:3210/api/health, then Ctrl+C.
$env:OWC_DATA_DIR = Join-Path $env:TEMP "openwebcode-package-smoke"
& build\stage\bin\owc.cmd
Remove-Item Env:OWC_DATA_DIR

cpack --config build\CPackConfig.cmake -G WIX -C Release
.\packaging\verify-wix-options.ps1 -MsiPath "openwebcode-$Version-windows-x64.msi"
Get-FileHash "openwebcode-$Version-windows-x64.msi" -Algorithm SHA256
```

The MSI lands in the repository root. `verify-wix-options.ps1` reads the MSI database directly and confirms the Shell integration page, the conditional desktop-shortcut/PATH components, and the UAC-safe property passing are all present — a CPack/WiX template change cannot silently drop the checkboxes. If WiX fails with an encoding error, confirm `@fastify/send/test` was removed; if the packaged UI is stale, delete the whole `build/stage` and reassemble instead of overwriting.

### Installation and the options page

- Double-click to install; the default location is `C:\Program Files\openwebcode` (administrator rights required). The UpgradeCode is fixed, so upgrades install over the old version. Exception: a beta and its stable release share the same numeric ProductVersion (e.g. `1.5.0`), so installing beta↔stable directly may report "another version is already installed" — uninstall first. This is a known WiX limitation.
- A Start menu **OpenWebCode** shortcut (pointing at `bin\owc.cmd`) is always created.
- After the install-directory page comes the **Shell integration** page with two checkboxes, both selected by default: create a desktop shortcut, and add `<install-dir>\bin` to the `PATH` of **the user running the installer**. The choices are written to the registry (`HKCU\Software\OpenWebCode\Installer`) and retained across repairs and major upgrades. With PATH unchecked you can still run `bin\owc.cmd` from the install directory.
- The exit page has a "Launch OpenWebCode" checkbox, selected by default, which runs `bin\owc-launch.cmd`: it starts the server in a minimized window and opens `http://localhost:<port>` in the default browser after 3 seconds.

### Uninstall and data cleanup

Uninstall from "Settings → Apps". By default all user data is kept, in both `%USERPROFILE%\openwebcode` and the legacy default `%LOCALAPPDATA%\openwebcode`. To explicitly delete the default data, run this while you still have the MSI file:

```powershell
msiexec /x "openwebcode-<version>-windows-x64.msi" PURGE_DATA=1
```

This cleans both default data directories, old and new. It never touches a directory set via `OWC_DATA_DIR`, nor any `.owc/` inside a workspace. Upgrade installs never trigger the cleanup. The installer deliberately has no "delete data" checkbox in the UI, so users are not led to believe an unimplemented control can manage this destructive action.

Maintenance note: do not add a second WiX sequencing entry for `WixRemoveFoldersEx` (WiX v3's `RemoveFolderEx` schedules itself); `wix-patch.xml` only replaces the private directory property from its inert placeholder with the default data directory, conditionally, right before that action — this is what keeps a default uninstall non-destructive.

## Linux tar.gz

### Manual packaging

Same test gate and production-only pruning as Windows; the differences are a single-config core build and a full Linux Node distribution in staging:

```sh
set -euo pipefail
VERSION=1.5.0              # full version; prerelease e.g. 1.5.0-beta.1
BASE_VERSION=${VERSION%%-*}
NODE_VERSION=24.18.0

npm --prefix server ci
npm --prefix server run build
cmake -S core -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build-debug --parallel
ctest --test-dir build-debug --output-on-failure
OWC_CORE_PATH="$PWD/build-debug/owc-exec" npm --prefix server test

npm --prefix web ci
npm --prefix web run build
npm --prefix web test

npm --prefix server prune --omit=dev
rm -rf server/node_modules/@fastify/send/test

cmake -S core -B build -DCMAKE_BUILD_TYPE=Release \
  -DCPACK_PACKAGE_VERSION="$BASE_VERSION" -DCPACK_FULL_VERSION="$VERSION"
cmake --build build --target owc-exec --parallel

rm -rf build/stage
mkdir -p build/stage/{bin,server,web,node}
cp build/owc-exec build/stage/bin/
cp -r server/dist server/package.json server/node_modules server/assets build/stage/server/
cp -r web/dist build/stage/web/
# For arm64 swap linux-x64 for linux-arm64; loongarch64 has no official Node
# build, so do not create build/stage/node at all.
curl -fsSLo build/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"
tar -xzf build/node.tar.gz -C build/stage/node --strip-components=1

test -x build/stage/bin/owc-exec
test -x build/stage/node/bin/node
test -f build/stage/server/dist/index.js
test -f build/stage/web/dist/index.html

tar -czf "openwebcode-${VERSION}-linux-x64.tar.gz" \
  -C build/stage . \
  -C "$PWD/packaging" install.sh uninstall.sh
sha256sum "openwebcode-${VERSION}-linux-x64.tar.gz"
```

Smoke test: unpack into a temporary directory, run `./install.sh --yes --prefix <temp-prefix>`, start `<temp-prefix>/bin/owc`, and check `/api/health`. The repo also has script-level regression tests that are not shipped in the tarball: `sh packaging/test-install.sh`.

### install.sh

Run it from the unpacked package root:

```sh
mkdir openwebcode && tar -xzf openwebcode-<version>-linux-x64.tar.gz -C openwebcode
cd openwebcode
./install.sh          # in a TTY it asks about anything not given on the command line
~/.local/bin/owc
```

`install.sh` copies `bin/`, `server/`, `web/` (and optionally `node/`) into `<prefix>/lib/openwebcode/` (re-running overwrites everything, idempotently), generates the launcher `<prefix>/bin/owc`, and drops the uninstaller at `<prefix>/bin/owc-uninstall`. The prefix must be an absolute path; it is physically resolved after creation and `/` is rejected.

| Option | Behavior |
| --- | --- |
| `--prefix <dir>` | Install prefix (absolute path). Defaults are uid-based: `~/.local` for regular users, `/usr/local` for root. |
| `--port <1-65535>` | Launcher default for `OWC_PORT` (default 3210; `04312` is normalized to `4312`). |
| `--data-dir <dir>` | Launcher default for `OWC_DATA_DIR` (absolute path, not `/`). Defaults: `${XDG_DATA_HOME:-~/.local/share}/openwebcode` for users, `/var/lib/openwebcode` for root. |
| `--host <addr>` | Launcher default for `OWC_HOST` (default `127.0.0.1`; accepts DNS names, IPv4, and unbracketed IPv6). |
| `--lan` | Shorthand for `--host 0.0.0.0`; mutually exclusive with `--host`. |
| `--system` | Explicit system-level install (requires root; running as root already defaults to system paths). |
| `--use-system-node` | Skip the bundled `node/` and require Node.js ≥ 24 on PATH at install time. Also selected automatically when the bundle has no `node/bin/node`. |
| `--with-systemd` | Write a systemd unit without enabling it: root writes `/etc/systemd/system/openwebcode.service`, otherwise the user unit `${XDG_CONFIG_HOME:-~/.config}/systemd/user/openwebcode.service` (target directory overridable via `OWC_SYSTEMD_UNIT_DIR`). A prefix containing spaces or systemd-special characters is rejected (in update/switch scenarios the old unit is kept instead of rewritten). |
| `--enable-service` | Implies `--with-systemd` and runs `systemctl daemon-reload && systemctl enable --now openwebcode` (`systemctl --user` for user installs; boot persistence without login also needs `loginctl enable-linger $USER`). |
| `--open-firewall` | Root + non-loopback listen only: opens the port via firewalld/ufw, or prints manual instructions if neither exists. |
| `--yes` / `-y` | Never prompt; suitable for CI and scripts. |
| `--with-desktop-entry` | Not implemented; the script fails explicitly rather than pretending to do desktop integration. |

Interactive behavior: without `--yes`, when stdin/stdout are both TTYs, the script only asks about values not given on the command line — the prefix (root is first asked to confirm a system-level install), port, data directory, LAN access or a specific listen address, whether to use the system Node.js, whether to write the systemd unit and enable it immediately (asked only when systemd is actually usable: root checks `/run/systemd/system`, user installs check `systemctl --user`), and the firewall question for root with a non-loopback listen. Non-TTY installs never read input, so CI cannot block. The written values are only defaults; explicitly set `OWC_PORT`/`OWC_DATA_DIR`/`OWC_HOST` still win at runtime.

A non-loopback listen forces access-token authentication: without an explicit `OWC_ACCESS_TOKEN` (32+ characters) the server generates one on first start and persists it to `<data-dir>/access-token` (0600); one-click access links are printed to the server console and shown under Settings → Remote access. If the token already exists when the installer finishes (e.g. the service was just started via `--enable-service`), the script prints the token-bearing links directly. Only expose the service on a trusted network or behind an authenticated reverse proxy. When the service runs as root, agent-executed commands run as root too — only run trusted tasks.

Re-running `install.sh` over an existing installation:

- **Existing-install detection**: the script locates an existing unit by uid (system-level for root, user-level otherwise) and derives the previous prefix from `ExecStart`. Same path means an update: interactive mode asks for a single confirmation, non-TTY just prints the detection status and continues. A unit pointing at a different prefix triggers an interactive three-way choice (switch the service to the new path / install files only / abort); non-TTY warns and defaults to files-only, and only an explicit `--with-systemd` switches the service.
- **Launcher variable preservation**: when `<prefix>/bin/owc` already exists, its `OWC_DEFAULT_PORT`, `OWC_DEFAULT_DATA_DIR`, `OWC_DEFAULT_HOST`, and `OWC_NODE` become this run's defaults; explicit command-line flags still take priority.
- **Unit rewrite**: updates and switches rewrite the unit but preserve its enabled state (probed via `systemctl is-enabled` — a service that was never enabled does not get enabled); a running service is restarted automatically after installation. Newly written units always set `NoNewPrivileges=true`; system-level units add `ProtectSystem=full` with `ReadWritePaths=` keeping the data directory writable.
- At the end the script checks whether `<prefix>/bin` is on `PATH`; if not, it prints an `export PATH` hint with the rc file inferred from `$SHELL` (bash → `~/.bashrc`, zsh → `~/.zshrc`, otherwise `~/.profile`).

Automated install examples:

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3210 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1

# One-shot server install (root): system paths + LAN access + autostart + firewall
sudo ./install.sh --yes --system --lan --enable-service --open-firewall
```

### Uninstall

Run the uninstaller the installer dropped at `<prefix>/bin/owc-uninstall` (the tarball also carries `uninstall.sh` at its top level):

```sh
~/.local/bin/owc-uninstall                    # interactive confirmation; data is kept by default
~/.local/bin/owc-uninstall --yes              # non-interactive
~/.local/bin/owc-uninstall --yes --purge-data # also delete the data directory
sudo /usr/local/bin/owc-uninstall --yes --purge-data --remove-firewall  # system-level + firewall rule
```

Actions in order: if a systemd unit exists, `disable --now` (best effort) → delete the unit → `daemon-reload`; with `--remove-firewall`, remove the port rule based on the launcher's `OWC_DEFAULT_PORT` (root only); delete `<prefix>/lib/openwebcode` and `<prefix>/bin/owc`; with `--purge-data`, delete the data directory (refusing `/`, `$HOME`, and the prefix itself); finally delete the uninstaller itself. `--prefix` defaults to the installation containing the uninstaller, falling back to the uid-based default when run from the tarball root; `--data-dir` follows the same uid-based defaults. If a user-level install ever used `loginctl enable-linger`, the uninstaller prints the matching `disable-linger` hint. Manually started (non-systemd) `owc` processes are out of scope — stop them first.

### install-online.sh (online install and update)

A `curl | bash` script (POSIX sh) that installs or upgrades in one command:

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
# Pin a version and prefix, skip interaction:
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh \
  | bash -s -- --version 1.5.0 --prefix /opt/openwebcode --yes
```

Flow: check dependencies (curl or wget, tar, sha256sum or shasum — no jq) → download `openwebcode-<version>-linux-<arch>.tar.gz` and `SHA256SUMS.txt` into a `mktemp -d` working directory → verify with `sha256sum --check` on the target line only (falls back to `shasum -a 256`), aborting on mismatch → extract → pick one of two modes based on whether `<prefix>/lib/openwebcode/server/dist/index.js` already exists. The working directory is cleaned up on exit.

The architecture is mapped from `uname -m`: `x86_64→x64`, `aarch64→arm64`, `loongarch64→loongarch64`; anything else fails with a clear error.

| Option | Behavior |
| --- | --- |
| `--version <x.y.z>` | Target version (semver shape, one prerelease suffix allowed); by default the script queries the `tag_name` of the latest GitHub release (parsed with sed/grep). |
| `--prefix <dir>` | Install prefix, default `~/.local` for users and `/usr/local` for root; decides fresh install vs update, and is passed through to the bundled `install.sh` on fresh installs. |
| `--yes` / `--port` / `--host` / `--lan` / `--data-dir` / `--system` / `--with-systemd` / `--enable-service` / `--open-firewall` / `--use-system-node` | Passed through verbatim to the bundled `install.sh`, effective only on fresh installs; update mode does not rebuild the launcher and prints a notice that these arguments were ignored. |

- **Fresh install**: delegates to the extracted `install.sh`, identical to an offline install.
- **Update**: replaces the contents of `<prefix>/lib/openwebcode/` with the new version, keeping the `<prefix>/bin/owc` launcher and any written systemd unit untouched; the data directory is never affected. When the existing launcher pins a system Node.js (`OWC_NODE` not in bundled form), the `node/` directory is not copied (about 100 MB of redundancy, and any stale copy is removed). A non-writable target fails with a clear error (sudo may be required). Afterwards the script suggests a restart based on the actual unit location: `systemctl restart openwebcode` for the system unit (`sudo` suggested when not root), `systemctl --user restart openwebcode` for the user unit, or a manual restart of the running `owc` when there is no unit.

The download base URL can be overridden with `OWC_INSTALL_BASE_URL` (default `https://github.com/snnh/openwebcode/releases/download/v<version>`), useful for mirrors or `file://` local testing.

## Docker image

Docker is the third installation method (containerized deployment alongside the Windows installer and the Linux tar.gz). The files live at the repository root: `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`, `.dockerignore`, and the publishing pipeline in `.github/workflows/docker.yml`.

### Image layout

Same contract as the release staging tree (see "Package layout"), except the Node runtime comes from the base image (no bundled `node/`):

```
/opt/openwebcode/
├── bin/owc-exec                  core executable (Release build)
└── server/  web/
    ├── dist/                     server build output (entry dist/index.js) and web static assets
    ├── package.json              "type": "module" declaration (dist is ESM, required)
    ├── node_modules/             production dependencies (after npm prune --omit=dev)
    └── assets/                   runtime assets (sandbox-proxy.mjs etc.)
```

- Base images `node:24-trixie` (builder) and `node:24-trixie-slim` (runtime), i.e. Debian 13 (trixie, glibc 2.41) — matching the project's development/test environment; multi-arch amd64 / arm64.
- The builder stage compiles all three tiers inside the image: core (cmake Release, `-DBUILD_TESTING=OFF`; the test gate is the CI's job), server (tsc), web (tsc + vite + bundle-size check); `npm ci --ignore-scripts` with lockfiles copied first keeps the dependency layers cached.
- The runtime stage additionally installs: bubblewrap (namespace sandbox), git (SCM/snapshots), python3 (agent tasks/Chat fallback), bash (preferred POSIX shell), curl (healthcheck), tini (PID 1), procps.
- Runs as the unprivileged user: the `node` user shipped by the official node image (uid/gid 1000, matching most desktop host users, so bind mounts work out of the box). When started as root, `docker-entrypoint.sh` first fixes the ownership of `/data` and, optionally, the top level of `OWC_WORKSPACE` (a freshly mounted named volume is root-owned, and the server's `ensureDirWithMode(0700)` requires an owner-writable dir), then drops privileges with `setpriv`; with a custom `user:` the user is responsible for ownership.
- Environment: `OWC_CORE_PATH`, `OWC_DATA_DIR=/data`, `OWC_HOST=0.0.0.0` (off-loopback, so the server auto-generates an access token on first start and prints the token link to the logs), `OWC_PORT=3210`, `OWC_BROWSE_ROOTS=/workspace`, `OWC_UPDATE_CHECK_ENABLED=false`.
- Healthcheck: `GET /api/health` (`{"status":"ok"}`, unauthenticated), defined both in the Dockerfile and in compose.

### Build and run

```sh
docker build -t openwebcode .                 # local build (current architecture)
docker run -d --name openwebcode -p 3210:3210 \
  -v openwebcode-data:/data openwebcode       # run; docker logs shows the access link
docker compose up -d                          # or just compose (pulls the GHCR release image by default)
```

### Sandbox capabilities and limits

- **Landlock**: available by default inside the container (host kernel ≥ 5.13), no extra configuration — this is the default sandbox tier in containers.
- **bubblewrap**: requires the host to allow unprivileged user namespaces and the container to allow `mount` and friends — uncomment `security_opt: seccomp=unconfined` in compose (add `cap_add: [SYS_ADMIN]` if needed). When unavailable, the core degrades to Landlock with a diagnostic trace — by design.
- **Snapshots**: overlayfs mounts are subject to the same seccomp limits; the default snapshot backend probe chain degrades automatically (git-shadow/refs); unblock seccomp if overlay is required.
- No in-place self-update inside the container (`OWC_UPDATE_CHECK_ENABLED=false`, `/opt/openwebcode` is read-only for the `owc` user) — upgrading means pulling a new image; the data volume is untouched.

### Publishing (docker.yml)

- Triggered by pushing a `v*` tag (same source as release.yml) or manually via `workflow_dispatch` (with a tag input the run builds that tag's tree; with no input it builds the current branch and takes the version from `server/package.json` — useful for rebuilding the image after a packaging fix without moving an already-published tag); fully decoupled from release.yml — an image publishing failure does not block the GitHub Release.
- `docker/setup-buildx-action` + `docker/login-action` (`GITHUB_TOKEN`, `packages: write`) build `linux/amd64,linux/arm64` and push to `ghcr.io/snnh/openwebcode`.
- Tags: `v<version>` (e.g. `v1.7.3`); stable versions (no `-` in the version) additionally get `latest`. Prereleases (e.g. `1.7.3-beta.1`) only get the version tag so `latest` never points at a prerelease.
- loongarch64 is not supported (no official node image for it).

## The owc launcher scripts

The Linux `<prefix>/bin/owc` (generated by install.sh) and the Windows `bin\owc.cmd` do the same three things:

1. Set `OWC_CORE_PATH` to the bundled `owc-exec` — the server locates core relative to a source tree by default, so an installed layout must set it explicitly;
2. Port and listen address: explicitly set `OWC_PORT`/`OWC_HOST` win, otherwise the defaults written at install time apply (initially 3210 / `127.0.0.1`);
3. Data directory: an explicit `OWC_DATA_DIR` wins; otherwise Linux uses the install-time default (initially `${XDG_DATA_HOME:-~/.local/share}/openwebcode`) and Windows injects `%USERPROFILE%\openwebcode`. Only a direct `node server/dist/index.js` run that bypasses the launcher falls back to `../.openwebcode` next to the server directory. `server-settings.json` always stays in that boot/settings directory; with no `OWC_DATA_DIR`, the `dataDir` saved inside it selects the business data directory after a restart. Use absolute paths for both `OWC_DATA_DIR` and `dataDir`.

The bundled `node/` is preferred at runtime. Linux decides at install time: if the bundle is missing or `--use-system-node` was given, the launcher is bound to the system Node.js (validated as ≥ 24 during installation) with no runtime fallback; the Windows `owc.cmd` instead warns at runtime and falls back to `node` from PATH when `node\node.exe` is missing.

`owc run ...` goes to the headless CLI (`server/dist/cli.js`); anything else starts the server.

Two Windows-specific script behaviors:

- `owc.cmd` performs a one-time data-directory migration: when `OWC_DATA_DIR` is not set explicitly, the legacy default `%LOCALAPPDATA%\openwebcode` exists, and the new default does not, it moves the legacy directory to `%USERPROFILE%\openwebcode` (falling back to `robocopy /E /MOVE` if `move` fails), never blocking startup. When the server fails to start (e.g. port already in use) it `pause`s to keep the console visible; the `owc run` path never pauses.
- `owc-launch.cmd` exists only for the MSI exit-page Launch checkbox: it starts `owc.cmd` minimized, waits 3 seconds, then opens `http://localhost:%OWC_PORT%`.

## Quick staging refresh during development

Only for local testing when a complete staging tree already exists — not a substitute for a proper build:

```powershell
npm --prefix server run build
npm --prefix web run build
Copy-Item -Recurse -Force server\dist\* build\stage\server\dist\
Copy-Item -Recurse -Force web\dist\* build\stage\web\dist\
```

Server modules load at process start, so `build\stage\bin\owc.cmd` must be restarted after copying; Vite entry points are hashed, so use `Ctrl+F5` if the UI looks stale. A real release must rebuild staging from an empty directory and ensure `server/node_modules/` contains only production dependencies.

## Release pipeline (release.yml)

- **Trigger**: push a `v*` tag, or dispatch the `release` workflow manually with a tag input (created from the current commit if it does not exist). `concurrency` uses `cancel-in-progress: false` — a release run is never interrupted. Manual dispatch has two switches: `skip_performance_tests` (skip benchmarks; not allowed for tag triggers) and `bootstrap_benchmark_baseline` (allow a missing previous baseline, for the very first baseline only).
- **Version check**: the first step of both platform jobs, run for tag pushes and manual dispatches alike; see "Version numbers" above.
- **Test gate**: Windows and Linux x64/arm64 each run the core ctest suite, the server tests against the real `owc-exec`, and the web build and tests. The publish job requires Windows, Linux, and the benchmark job all green.
- **Windows job**: tests → `npm prune --omit=dev` → Release core → assemble `build/stage/` (the Node win-x64 zip is verified against the official `SHASUMS256.txt` before `node.exe` is taken; `owc.cmd`/`owc-launch.cmd` are converted to CRLF) → `cpack -G WIX` → `verify-wix-options.ps1` → silent `msiexec` install + `/api/health` smoke + uninstall → upload the MSI.
- **Linux job**: matrix over `arch: [x64, arm64, loongarch64]`. x64/arm64 build natively (arm64 on `ubuntu-24.04-arm`), then assemble staging after tests (the Node linux-<arch> tarball is likewise verified and extracted whole into `node/`), pack with `tar -C stage . -C packaging install.sh uninstall.sh`, and smoke-test with `./install.sh --yes` into a temporary prefix plus `/api/health`. loongarch64 is cross-compiled on an x64 runner with `gcc-14-loongarch64-linux-gnu` (`core/toolchains/loongarch64-linux-gnu.cmake`), skips ctest/server tests and the smoke test, verifies with `file` that the artifact is a loongarch64 ELF, and ships without `node/`.
- **Benchmark job**: a hard release dependency by default, with two levels of judgment — the relative regression comparison is warning-level (`compare.mjs` regressions over 15% only warn, never block); the absolute acceptance gates built into each bench script fail the job and block the release, which is intended behavior. A current build missing any benchmark scenario result also fails. With no previous-release baseline, or when the baseline assets cannot be downloaded, comparison is skipped with a warning (non-blocking) unless `bootstrap_benchmark_baseline` was explicitly enabled. Results ship as `bench-results-*.json` release assets for the next version's baseline. A manual dispatch with `skip_performance_tests` skips the whole job, and that release contains no benchmark JSON.
- **Publish job**: downloads all artifacts and verifies completeness → generates `SHA256SUMS.txt` and self-checks it → extracts the release notes from the `## [<version>]` section of `CHANGELOG.md` (a missing or empty section fails the job — update the changelog before releasing) → creates the Release with `softprops/action-gh-release@v2` (non-draft; versions containing `-` are marked pre-release; `target_commitish` is pinned to the commit that started the run). Uploaded files: the MSI, the three tarballs, `SHA256SUMS.txt`, `packaging/install-online.sh`, and the benchmark JSON (when present).

### Cutting a release

Push the reviewed commits first, confirm `CHANGELOG.md` has the matching section and all four version numbers agree, then:

```sh
git tag -a v1.5.0 -m "OpenWebCode v1.5.0"
git push origin v1.5.0
```

You can also run `release` manually in Actions with `v1.5.0` as the tag. After the release, verify the file names and `SHA256SUMS.txt` on the Release page, MSI install/uninstall, tarball installation, and `/api/health`.
