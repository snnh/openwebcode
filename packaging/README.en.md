# Distribution and packaging

[中文](./README.md) | [English](./README.en.md)

The canonical, command-by-command packaging guide is maintained in Chinese in [`README.md`](./README.md). This page summarizes the release contract for English readers.

## Release artifacts

The `release` workflow produces:

| Artifact | Platform | Format |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows x64 | CPack/WiX MSI |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux x64 | Runtime tree plus top-level `install.sh` |
| `SHA256SUMS.txt` | Both | SHA-256 checksums for the two release archives |

`<version>` is the release tag without its leading `v` (for example, `v0.2.4` becomes `0.2.4`).

Windows MSI packaging requires CMake 3.19 or newer (for CPack's WiX custom-namespace support) and WiX Toolset v3.

## Required pipeline

Every distributable follows the same sequence:

1. Install the locked Server and Web dependencies.
2. Build a Debug core and run Server tests against the real `owc-exec` binary.
3. Build and test the Web UI.
4. Prune Server dependencies to production-only.
5. Build the Release core.
6. Assemble a clean `build/stage/` tree with the pinned Node 20 runtime and platform launcher.
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
node/                       # pinned Node 20 runtime
install.sh                  # archive top level, Linux only
```

The pinned runtime version is `NODE_DIST_VERSION` in [`.github/workflows/release.yml`](../.github/workflows/release.yml). The exact PowerShell and shell commands, prerequisites, staging validation, smoke test, and troubleshooting notes are in the [canonical packaging guide](./README.md).

## Windows MSI shell integration

The MSI always creates an OpenWebCode Start menu entry. Its **Shell integration** page has two checkboxes, both selected by default: create a desktop shortcut, and add `<install-dir>\bin` to the current user's `PATH`. Uncheck either option to omit it. The choices are remembered for repair and major upgrades; a full uninstall removes only the shortcut and PATH entry created by its corresponding MSI component. Open a new terminal before using `owc` after selecting the PATH option.

After a local MSI build, run `./packaging/verify-wix-options.ps1 -MsiPath "openwebcode-<version>-windows-x64.msi"`. It reads the MSI database to verify the dialog, conditional components, and UAC-safe properties; the release workflow runs the same gate.

The copied WiX `InstallDir` dialog flow in [`openwebcode-ui.wxs`](./openwebcode-ui.wxs) is covered by the Microsoft Reciprocal License; its full text is in [`LICENSE.WiXUI.txt`](./LICENSE.WiXUI.txt).

## Data directory

An explicitly set `OWC_DATA_DIR` always takes precedence. If it is not set, the Windows launcher injects `%LOCALAPPDATA%\openwebcode`; the Linux launcher uses the data-directory default selected during installation (initially `${XDG_DATA_HOME:-~/.local/share}/openwebcode`). Only a direct `node server/dist/index.js` run that bypasses the launcher uses `../.openwebcode` relative to the `server` directory as its boot/settings-directory fallback. The settings file remains `server-settings.json` in that boot directory; with no `OWC_DATA_DIR`, a saved `dataDir` selects the business data directory after restart. Use absolute paths for either override.

## Linux installer options

Run `./install.sh` from the unpacked Linux tarball in a terminal to configure the unspecified values interactively. It asks for the prefix, port, data directory, host, whether to use the system Node.js, and whether to write a user-systemd unit. A supplied flag always wins. With redirected stdin/stdout, or with `--yes`, it never prompts, so CI cannot block:

```sh
./install.sh --yes --prefix "$HOME/.local" --port 3000 \
  --data-dir "$HOME/.local/share/openwebcode" --host 127.0.0.1
```

- `--prefix <absolute-dir>` installs under `<prefix>/lib/openwebcode` and writes `<prefix>/bin/owc`. The script creates and physically canonicalizes it, then rejects `/`.
- `--port <1-65535>`, `--data-dir <absolute-dir>`, and `--host <address>` become launcher defaults. Runtime `OWC_PORT`, `OWC_DATA_DIR`, and `OWC_HOST` still override them.
- A non-loopback `--host` prints a warning. This distribution does not configure HTTP authentication; expose it only on a trusted network or behind an authenticated reverse proxy.
- `--use-system-node` skips bundled `node/` and requires an absolute executable Node.js 20+ on `PATH` at install time. If the bundle is missing, the installer switches to that validated mode.
- `--with-systemd` writes a user unit only and never runs `systemctl`; follow the printed `systemctl --user daemon-reload && systemctl --user enable --now openwebcode` command.
- `--system` and `--with-desktop-entry` are deliberately not implemented: the installer fails explicitly instead of claiming system-wide installation or desktop integration.

Run `sh packaging/test-install.sh` from a checkout for the portable installer smoke tests; the test file is not shipped in the release tarball.

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
git tag -a v0.2.4 -m "OpenWebCode v0.2.4"
git push origin v0.2.4
```

The workflow can also be dispatched manually with a `v*` tag. A single release job publishes the MSI, tar.gz, and `SHA256SUMS.txt` only after both platform jobs succeed; installation and `/api/health` smoke checks are release gates.
