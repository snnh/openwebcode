# Distribution and packaging

[中文](./README.md) | [English](./README.en.md)

The canonical, command-by-command packaging guide is maintained in Chinese in [`README.md`](./README.md). This page summarizes the release contract for English readers.

## Release artifacts

The `release` workflow produces:

| Artifact | Platform | Format |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows x64 | CPack/WiX MSI |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux x64 | Runtime tree plus top-level `install.sh` |
| `install-online.sh` | Linux x64 | `curl \| bash` online install/update script |
| `SHA256SUMS.txt` | Both | SHA-256 checksums for the two release archives |

`<version>` is the release tag without its leading `v` (for example, `v0.5.2` becomes `0.5.2`).

Windows MSI packaging requires CMake 3.19 or newer (for CPack's WiX custom-namespace support) and WiX Toolset v3.

## Required pipeline

Every distributable follows the same sequence:

1. Install the locked Server and Web dependencies.
2. Build a Debug core, run the core ctest suite, and run Server tests against the real `owc-exec` binary.
3. Build and test the Web UI.
4. Prune Server dependencies to production-only.
5. Build the Release core.
6. Assemble a clean `build/stage/` tree with the pinned Node 24 runtime and platform launcher.
7. Validate and smoke-test staging.
8. Create the MSI or tar.gz and calculate its SHA-256 digest.

Do not package `server/dist` or `web/dist` alone. A valid staging tree contains:

```text
bin/owc-exec(.exe)
bin/owc.cmd                 # Windows only
server/dist/
server/package.json
server/node_modules/        # production dependencies only
server/assets/
web/dist/
node/                       # pinned Node 24 runtime
install.sh                  # archive top level, Linux only
uninstall.sh                # archive top level, Linux only
```

The pinned runtime version is `NODE_DIST_VERSION` in [`.github/workflows/release.yml`](../.github/workflows/release.yml). The exact PowerShell and shell commands, prerequisites, staging validation, smoke test, and troubleshooting notes are in the [canonical packaging guide](./README.md).

## Windows MSI shell integration

The MSI always creates an OpenWebCode Start menu entry. Its **Shell integration** page has two checkboxes, both selected by default: create a desktop shortcut, and add `<install-dir>\bin` to the current user's `PATH`. Uncheck either option to omit it. The choices are remembered for repair and major upgrades; a full uninstall removes only the shortcut and PATH entry created by its corresponding MSI component. Open a new terminal before using `owc` after selecting the PATH option.

After a local MSI build, run `./packaging/verify-wix-options.ps1 -MsiPath "openwebcode-<version>-windows-x64.msi"`. It reads the MSI database to verify the dialog, conditional components, and UAC-safe properties; the release workflow runs the same gate.

The copied WiX `InstallDir` dialog flow in [`openwebcode-ui.wxs`](./openwebcode-ui.wxs) is covered by the Microsoft Reciprocal License; its full text is in [`LICENSE.WiXUI.txt`](./LICENSE.WiXUI.txt).

## Data directory

An explicitly set `OWC_DATA_DIR` always takes precedence. If it is not set, the Windows launcher injects `%USERPROFILE%\openwebcode`; the Linux launcher uses the data-directory default selected during installation (initially `${XDG_DATA_HOME:-~/.local/share}/openwebcode`). Only a direct `node server/dist/index.js` run that bypasses the launcher uses `../.openwebcode` relative to the `server` directory as its boot/settings-directory fallback. The settings file remains `server-settings.json` in that boot directory; with no `OWC_DATA_DIR`, a saved `dataDir` selects the business data directory after restart. Use absolute paths for either override.

## Linux installer options

Run `./install.sh` from the unpacked Linux tarball in a terminal to configure the unspecified values interactively. It asks for the prefix, port, data directory, whether to enable LAN access (or a specific host), whether to use the system Node.js, and the systemd service (write it, and enable+start it now; root with LAN access is also asked about the firewall port). A supplied flag always wins. With redirected stdin/stdout, or with `--yes`, it never prompts, so CI cannot block:

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3210 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1

# One-shot server install (root): system paths + LAN access + autostart + firewall
sudo ./install.sh --yes --system --lan --enable-service --open-firewall
```

- `--prefix <absolute-dir>` installs under `<prefix>/lib/openwebcode` and writes `<prefix>/bin/owc`. The script creates and physically canonicalizes it, then rejects `/`. Defaults are per-user `$HOME/.local`, or `/usr/local` as root (likewise `${XDG_DATA_HOME:-~/.local/share}/openwebcode` vs `/var/lib/openwebcode` for `--data-dir`).
- `--port <1-65535>`, `--data-dir <absolute-dir>`, and `--host <address>` become launcher defaults. Runtime `OWC_PORT`, `OWC_DATA_DIR`, and `OWC_HOST` still override them. `--lan` is shorthand for `--host 0.0.0.0` (mutually exclusive with `--host`).
- A non-loopback listen requires token authentication: with no explicit `OWC_ACCESS_TOKEN` (32+ characters) the server auto-generates one on first start and persists it to `<data-dir>/access-token` (0600), then prints one-click `/?token=...` links to the console and to Settings → Remote access. Browser origins default to same-origin auto-allow; set `OWC_ALLOWED_ORIGINS` (comma-separated http(s) origins) to restrict explicitly. Keep the service on a trusted network or behind an authenticated reverse proxy.
- `--use-system-node` skips bundled `node/` and requires an absolute executable Node.js **24+** on `PATH` at install time. If the bundle is missing, the installer switches to that validated mode.
- `--system` requests an explicit system-level install (requires root). `--with-systemd` writes a unit without enabling it (root: `/etc/systemd/system/openwebcode.service`; otherwise a user unit). `--enable-service` implies `--with-systemd` and runs `systemctl daemon-reload && systemctl enable --now openwebcode` (`systemctl --user` for user installs; boot persistence needs `loginctl enable-linger $USER`). `--open-firewall` (root + non-loopback only) opens the port via firewalld/ufw when available.
- When the access token already exists at the end of a LAN install (e.g. the service was just enabled), the installer prints the one-click access links; otherwise it points at the server console and Settings → Remote access.
- `--with-desktop-entry` is deliberately not implemented: the installer fails explicitly instead of claiming desktop integration. A root service runs agent-executed commands as root too — only run trusted tasks.
- Re-running `install.sh` over an existing installation behaves as an update: it locates any existing systemd unit by uid (system-level as root, user-level otherwise), derives the previous prefix from `ExecStart`, and for a same-path rerun asks for one confirmation instead of every item (non-TTY just prints the detection status). A unit pointing at a different prefix triggers an interactive three-way choice (switch the service here / install files only / abort); non-TTY warns and defaults to files-only unless `--with-systemd` is explicit. An existing `<prefix>/bin/owc` launcher donates its `OWC_DEFAULT_PORT`/`OWC_DEFAULT_DATA_DIR`/`OWC_DEFAULT_HOST`/`OWC_NODE` as this run's defaults (explicit flags still win). Update rewrites the unit but preserves its enabled state (probed via `systemctl is-enabled`) and restarts the service when it was active. Newly written units always set `NoNewPrivileges=true`; system-level units add `ProtectSystem=full` with `ReadWritePaths=` keeping the data directory writable. The interactive systemd question only appears when systemd is actually usable, and the installer ends with an `export PATH` hint (rc file inferred from `$SHELL`) when `<prefix>/bin` is not on `PATH`.

### Uninstall

The installer drops an uninstaller at `<prefix>/bin/owc-uninstall` (the tarball also ships `uninstall.sh` at its top level). Running it reverses the installation completely: stops and disables the systemd service, removes the unit (system-level as root, user-level otherwise), deletes `<prefix>/lib/openwebcode` and `<prefix>/bin/owc`, and finally removes itself.

```sh
~/.local/bin/owc-uninstall                    # interactive confirmation; data is kept by default
~/.local/bin/owc-uninstall --yes              # non-interactive
~/.local/bin/owc-uninstall --yes --purge-data # also delete the data directory
sudo /usr/local/bin/owc-uninstall --yes --purge-data --remove-firewall  # system-level + firewall rule
```

`--prefix` defaults to the installation containing the uninstaller itself, falling back to the uid-based default (`~/.local`, or `/usr/local` as root) when run from the tarball. `--data-dir` follows the same uid-based defaults. Manually started (non-systemd) `owc` processes are out of scope — stop them first.

Run `sh packaging/test-install.sh` from a checkout for the portable installer smoke tests; the test file is not shipped in the release tarball.

## Linux online install and update

[`install-online.sh`](./install-online.sh) is a POSIX `curl | bash` installer for Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh | bash
curl -fsSL https://raw.githubusercontent.com/snnh/openwebcode/main/packaging/install-online.sh \
  | bash -s -- --version 0.6.0 --prefix /opt/openwebcode --yes
```

It downloads `openwebcode-<version>-linux-x64.tar.gz` and `SHA256SUMS.txt` from GitHub Releases, verifies the tarball with `sha256sum --check` (target line only; falls back to `shasum -a 256`) and aborts on mismatch, then extracts into a `mktemp -d` working directory cleaned up on exit. It needs only curl or wget, tar, and a checksum tool — no jq.

- `--version <x.y.z>` picks the release; without it the script queries the `tag_name` of the latest GitHub release.
- `--prefix <absolute-dir>` (default `$HOME/.local`) selects the install prefix and decides the mode; `--yes`, `--port`, `--host`, `--data-dir`, `--with-systemd`, and `--use-system-node` pass through to the bundled `install.sh`.
- **Fresh install**: delegates to the bundled `install.sh`, identical to an offline install.
- **Update**: when `<prefix>/lib/openwebcode/server/dist/index.js` already exists, the script replaces the contents of `<prefix>/lib/openwebcode/` with the new version while keeping the `<prefix>/bin/owc` launcher and any systemd unit untouched; the data directory is never affected. When the existing launcher pins a system Node.js (`OWC_NODE` not in bundled form), the `node/` directory is not copied (about 100 MB of redundancy, and any stale copy is removed). A non-writable target fails with a clear error (sudo or ownership fix may be required). Restart afterward according to the actual unit location: `systemctl restart openwebcode` for the system unit (`sudo` is suggested when not root), `systemctl --user restart openwebcode` for the user unit, otherwise restart the running `owc` manually.

Set `OWC_INSTALL_BASE_URL` to override the download base URL (default `https://github.com/snnh/openwebcode/releases/download/v<version>`), which is useful for mirrors or `file://` local testing.

## Development-only staging refresh

When a complete `build/stage/` already exists, Server and Web outputs can be refreshed for local testing:

```powershell
npm --prefix server run build
npm --prefix web run build
Copy-Item -Recurse -Force server\dist\* build\stage\server\dist\
Copy-Item -Recurse -Force web\dist\* build\stage\web\dist\
```

Restart `build\stage\bin\owc.cmd` afterward and use `Ctrl+F5` if the browser retained an old Vite entry point. This shortcut is not a release build; official packaging must recreate staging from an empty directory.

## Publishing

Pushing a semantic version tag starts the release workflow:

```sh
git tag -a v0.5.2 -m "OpenWebCode v0.5.2"
git push origin v0.5.2
```

The workflow can also be dispatched manually with a `v*` tag (created from the current commit if it does not exist). The pipeline enforces:

- **Version consistency** (tag-triggered runs only): the tag without its leading `v` must equal both `server/package.json`'s `version` and `core/CMakeLists.txt`'s `project(VERSION)`; a mismatch fails both platform jobs at their first step.
- **Test gate**: each platform job (Windows and Linux) runs the core ctest suite, the Server tests against the real `owc-exec`, and the Web build and tests. Publishing requires both platform jobs to be green.
- **Bundled Node verification**: the pinned Node 24 runtime (`env.NODE_DIST_VERSION`, currently 24.18.0) is downloaded from nodejs.org and verified against the official `SHASUMS256.txt`; no hash is hardcoded.
- **Install smoke checks**: the Windows MSI is verified with `verify-wix-options.ps1`, silently installed, health-checked at `/api/health`, and uninstalled; the Linux tarball is installed with `./install.sh --yes` into a temporary prefix and health-checked.
- **Benchmarks**: the benchmark job is a hard release dependency by default, but regression comparison is warning-level — a regression over 15% only warns and does not block the release, while a current build that fails to produce every benchmark scenario result fails the job. A missing or undownloadable previous-release baseline also skips comparison with a warning, unless `bootstrap_benchmark_baseline` is explicitly enabled for the first baseline. Normalized `bench-results-*.json` files ship as release assets for the next baseline. A manual dispatch may explicitly set `skip_performance_tests` for an emergency release; tag-triggered releases cannot skip benchmarks, and a skipped run publishes no benchmark JSON.
- **Release notes**: the GitHub Release body is extracted from the matching `## [version]` section of `CHANGELOG.md`; a missing or empty section blocks the release. `SHA256SUMS.txt` is generated for both archives and self-checked before upload.
