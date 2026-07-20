# Distribution and packaging

[中文](./README.md) | [English](./README.en.md)

The canonical, command-by-command packaging guide is maintained in Chinese in [`README.md`](./README.md). This page summarizes the release contract for English readers.

## Release artifacts

The `release` workflow produces:

| Artifact | Platform | Format |
| --- | --- | --- |
| `openwebcode-<version>-windows-x64.msi` | Windows x64 | CPack/WiX MSI |
| `openwebcode-<version>-linux-x64.tar.gz` | Linux x64 | Runtime tree plus top-level `install.sh` |

`<version>` is the release tag without its leading `v`.

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
git tag -a v0.1.0 -m "OpenWebCode v0.1.0"
git push origin v0.1.0
```

The workflow can also be dispatched manually with a `v*` tag. A release is complete only after both platform jobs succeed, both artifacts appear on the GitHub Release, and installation plus `/api/health` smoke checks pass.
