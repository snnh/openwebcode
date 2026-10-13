# dsh Sync (dsh-sync extension)

An official owc extension that **manually syncs model configuration and sessions both ways** with the **dsh (DeepSeek Harness) data directory** (default `~/.dsh`).

- What it syncs: the `llm-service-lite` model configuration inside dsh's `profiles/<profile>/cordis.patch.yml`, and dsh sessions (**read** v3/v4 `session.v{3,4}.jsonl.zstd`, **write** v3).
- How: it reads and writes files in the dsh data directory directly and **does not require dsh to be running**; every write is triggered by you, after a per-item selection.
- Who it's for: people who move between owc and dsh with the same model configuration and sessions. If you only use one harness day-to-day, you don't need it.

> Terms: **dsh** = DeepSeek Harness (upstream developer preview); **owc** = OpenWebCode; **profile** = a dsh configuration profile (default `web`).

---

## Contents

1. [Overview](#overview)
2. [Enabling it](#enabling-it)
3. [Configuration](#configuration)
4. [Panel workflow](#panel-workflow)
5. [Credential handling](#credential-handling)
6. [Limitations and notes](#limitations-and-notes)

---

## Overview

The dsh Sync extension does two things, each **bidirectional** and independent of the other (the two blocks have their own direction switch):

| Block | Import from dsh | Export to dsh |
|---|---|---|
| **Model configuration** | Read provider/model entries from `cordis.patch.yml` → write into the owc model catalog | owc model providers → rewrite the `llm-service-lite` section of `cordis.patch.yml` |
| **Sessions** | dsh `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd` → owc sessions (continuable) | owc sessions → new dsh session directories (`session.v3.jsonl.zstd`) |

Shared properties:

- **Diff preview**: preview first to see every difference / session entry, then select items and run. Previewing changes nothing.
- **Nothing dropped silently**: every downgrade, dropped event and unmapped field lands in the execution report (warnings / unmapped fields / dropped-event counts).
- **Safeguards on write**: `cordis.patch.yml` is backed up before rewriting; session export **only ever creates new session directories** and never overwrites existing dsh sessions.
- **Continuable**: sessions are mapped faithfully (not a read-only archive), so you can keep chatting in owc after an import and in dsh after an export.

## Enabling it

Go to **Settings → Extensions**, find **dsh Sync**, and turn it on. It is **off by default**.

Once enabled:

- A **"dsh Sync"** tab appears in the bottom panel (it is hidden while the extension is off).
- Data is accessed through the extension's private routes `/api/ext/dsh-sync/*`, covered by the global `/api` authentication.
- Turning the extension back off removes the tab immediately; no further dsh directory reads or writes happen.

Then switch the bottom panel to the **"dsh Sync"** tab:

1. The **Environment status** block probes automatically ("Re-probe" forces a refresh): whether the data directory exists, whether the profile file exists, zstd capability, and whether dsh is running.
2. Work with the **Model configuration sync** and **Session sync** blocks as needed.

## Configuration

Fill these in under **Settings → Extensions → dsh Sync**:

| Item | Default | Description |
|---|---|---|
| **dsh data directory** `dshHome` | `~/.dsh` | The dsh data directory. `~` expands to your home directory; an absolute path also works. |
| **dsh profile** `profile` | `web` | Reads the model configuration from `profiles/<profile>/cordis.patch.yml` (session directories are not profile-specific). |

Leaving a field empty uses the default. Both fields only affect how the "Model configuration" block locates `cordis.patch.yml`; the session block always scans `<dshHome>/sessions/`.

## Panel workflow

The tab has three blocks top to bottom: **Environment status**, **Model configuration sync**, **Session sync**. Each sync block is an independent direction switch + preview + selection + run + report.

### Environment status

Read-only probe results, one line each:

- **Data directory**: the actual `dshHome` path; highlighted when missing ("dsh data directory not found").
- **profile**: the profile name; highlighted when `cordis.patch.yml` is missing (affects model configuration sync only).
- **zstd**: whether `node:zlib` has zstd support; when unavailable it warns "Node ≥22.15 required", and **session sync is unavailable** (model configuration sync is unaffected).
- **dsh is running**: an informational note when dsh is detected listening (default `127.0.0.1:3080`) — see [Limitations](#limitations-and-notes).

### Model configuration sync

1. Choose the **sync direction**: `Import from dsh` or `Export to dsh`.
2. Click **"Preview diff"**: the corresponding side is read, compared with the other side, and every item is listed with a three-state badge:
   - **New** (green): missing on the target side — selected by default;
   - **Changed** (amber): present on both sides but with field differences — **not selected by default** (conflicts are never overwritten implicitly; you must confirm); expand "Field changes" to see `field: current value → value to be written`;
   - **In sync** (grey): identical on both sides — not selectable.
3. The footer shows "Selected N / total"; select what you want and click **"Run sync"**.
4. **Execution report**: applied / skipped counts and lists, warnings, and unmapped fields (fields that don't correspond on the two sides and are therefore **not** synced). The export direction additionally lists:
   - **Original configuration backed up**: the path of the `cordis.patch.yml.owc-sync-backup-<timestamp>` file created before rewriting;
   - **Set the following variables in the dsh environment**: the credentials written back are environment-variable **references** (see [Credential handling](#credential-handling)), so you must set the matching variables in the dsh environment.

> After writing `cordis.patch.yml`, **dsh must be restarted for the change to take effect** (a warning appears in preview/report while dsh is running).

### Session sync

Choose a direction (`Import from dsh` / `Export to dsh`) and click **"Preview sessions"**. Because running writes to disk, preview and run are separate steps.

**Import direction (dsh → owc)**:

1. The preview lists dsh sessions **grouped by working directory (cwd)**, annotating each row: generation, already-synced ("Synced <time>"), subagent transcripts ("Subagent"); message/image counts appear in the execution report (the preview does not count per row).
2. Non-importable items are disabled with a reason: **legacy generation** (v0–v2, "legacy vN: open it once in dsh to upgrade the format"), **newer generation** (>v4, "dsh generation vN is not supported yet: upgrade the dsh-sync extension"), **corrupt format**, **zstd unavailable**.
3. **Sessions without a cwd**: each such row gets a "Choose a local working directory" input; enter an absolute path (e.g. `/home/me/project`) before it can be imported.
4. By default the **importable and not-yet-synced** sessions are selected; already-synced ones are not.
5. If the selection includes already-synced sessions, a **"Conflict handling"** choice appears:
   - **Overwrite the imported session** (`overwrite`): rewrite the owc session history the mapping table points to;
   - **Create a copy** (`new`): create another owc session (default). Note the mapping table keeps only the newest copy per dsh session: after repeated "create a copy" imports, only the newest copy shows "Synced" in the panel; earlier copies remain in the owc session list.
6. Click **"Run import"**. The report includes each session's title and user/assistant/tool counts, image downgrade notes, dropped-event counts, warnings, and the mapping-table save result. Execution is submitted in **batches of up to 20** (60-second timeout per batch); if a run fails midway, the completed part is shown as-is and marked "may have partially taken effect", and the preview refreshes so you can retry. When zstd is unavailable (Node ≥22.15 required) the run button is disabled with the reason shown.

**Export direction (owc → dsh)**:

1. The preview lists owc sessions (title, provider/model, update time, last export time "Exported <time>").
2. Export entries are **always selectable** but **not selected by default** — selecting all could write many sessions at once, so this is left to your explicit choice ("Select all" / "Clear").
3. Click **"Run export"**. Each applied entry reports the written **event count / attachment count**, a subagent badge (below), and downgrade warnings; skipped entries give a reason (e.g. cwd is not an absolute path). Execution is likewise submitted in **batches of up to 20**; the run button is disabled with a reason when zstd is unavailable or the dsh data directory is missing.
4. Export **only creates new dsh session directories**: re-exporting generates another new session on the dsh side and **never overwrites** an existing one.
5. **Model attribution fill-in**: the current dsh generation (v4) requires every assistant message to carry non-empty `provider`/`model`, while an owc session may have picked a provider but no model yet. Export fills in from what the session has: both non-empty → kept as-is; provider but no model → the provider's default model from the current model catalog; no provider → owc's current default (adopted only when its default model matches the session's model); neither → owc's current default. If nothing can be filled, that entry is **skipped** (the reason names which half is missing and what to do), so a session that dsh would refuse to open is never written.
6. **Only the active path is exported**: an owc session is a message tree (fork/retry/rollback only append new branches), so export takes the chain reached by walking back from the current leaf — off-path history (branches you never actually took) never reaches the dsh session; legacy sessions without a leaf record are exported as their whole linear history.
7. **Tool-history cleanup and repair** (each recorded as a warning for that session, never silent): a tool message carrying several results is split into several; orphan results without a preceding call, duplicate results for one call, and **late** results that arrive in a later turn (the kind written back after an interrupted round) are dropped; conversely, an assistant call that never received any result gets a synthesized "tool not started" result event in the shape dsh officially accepts (dsh renders it as "the call was interrupted"). Before writing, the whole event stream is checked against dsh's structural rules — anything invalid is reported as a skipped entry with a reason instead of producing a file dsh would reject.

**Subagent report note** (export direction): when a parent session exports together with its subagent transcripts, the applied row shows a **"N subagent session(s)"** badge; if individual subagent transcripts fail to export, an extra amber warning line appears (with the failing taskId and reason) — a failure **does not affect the parent session's own successful export**.

## Credential handling

Model configuration involves API keys. dsh and owc store credentials differently, so dsh Sync performs a **semantic conversion** between them and avoids leaking plaintext throughout:

### Import (dsh → owc)

- dsh's `apiKeyEnv` (an environment-variable **reference**) → the same-named variable is read from the **current owc (extension host) process** and, if found, its value is **inlined** into the owc provider's `apiKey`. The preview annotates each key's resolution result:
  - **Resolved**: the variable was found;
  - **Missing env var** (red): the variable is not in the owc process environment — fill in the API key in owc settings after importing.
- A plaintext `apiKey` inlined on the dsh side → **passed through** into the owc `apiKey` (preview shows "Inline key").
- Note: the extension host process environment equals the shell environment that started owc, so for resolution to succeed the variable must be visible in **that** environment.

### Export (owc → dsh)

- An owc provider credential → dsh `apiKeyEnv: OWC_SYNC_<PROVIDER_ID_UPPER_SNAKE>_API_KEY` (non-alphanumeric characters in the id become `_`; name collisions get a `_2`/`_3`… suffix).
- **Plaintext is never written**: dsh receives the environment-variable **reference name** only, and you must set the same-named variable in dsh's runtime environment yourself (copying the value from the owc settings page). The execution report's "Set the following variables in the dsh environment" lists the `variable name → provider id` mapping.
- owc providers are read via `providers.listProfiles`, which returns **only a masked view** (`hasApiKey`) — the extension process **never sees the real key**, which is why export can only hand over a reference name.

### Credential badges on both sides

Import: `Resolved` / `Missing env var` (red) / `Inline key` / `No credential`; export: `Env reference` / `No credential`.

## Limitations and notes

- **Report text is Chinese**: execution reports, warnings and skip reasons are produced by the server-side extension and shown in Chinese regardless of the UI language (only the panel chrome is localised).

- **Session generations: v3/v4 are readable, writes still use v3**. **Reading** (import/preview) accepts both v3 and v4 shapes (dsh's current generation is v4: `session.v4.jsonl.zstd`, where `tool/result` is a first-class tool-role message; v4-only events and unknown content blocks are dropped as unknown and counted); **writing** (export) always produces `session.v3.jsonl.zstd`, which dsh upgrades to its current generation through its migration chain on load. Lower generations (v0–v2) must first be opened once in dsh to upgrade the format; higher generations (>v4) are rejected outright (upgrade this extension; migration chains are dsh's responsibility).
- **`compaction/prune` is not mapped**: dsh's `compaction/prune` events are always **dropped and counted** (owc's `evicted` ledger entries are tightly coupled with artifact persistence; recording without evicting would create an inconsistent "the ledger says evicted but the body is still there" view). `compaction/summary` is mapped to an owc compaction anchor (single-compacted semantics, the last one wins).
- **Subagent pairing is a temporal heuristic**: the correspondence between a dsh subagent session and the parent's `subagent` tool call is matched by "the two sequences appear in the same order" (no authoritative link field is confirmed upstream). Unpaired subagent sessions are listed as standalone sessions, and unpaired calls carry no fields — the pairing caveat is written into the report.
- **zstd requires Node ≥22.15**: reading/writing compressed sessions depends on `node:zlib` zstd support. When unavailable, the environment status bar warns and **session sync is unavailable** (model configuration sync still works).
- **Writing `cordis.patch.yml` requires restarting dsh**: while dsh is running the file is rewritten without dsh noticing; dsh must be restarted to pick up the new configuration.
- **Running detection and backup**: when dsh is detected running (something listening on `127.0.0.1:3080` by default) you get a warning but the operation is still **allowed**; before rewriting, `cordis.patch.yml` is copied to `cordis.patch.yml.owc-sync-backup-<ISO timestamp>`.
- **Only the `llm-service-lite` section is rewritten**: the `config.providers` of the `id: llm-service-lite` entry in `profiles/<profile>/cordis.patch.yml` is rewritten with CST comment preservation; other entries (including comments and `!!js` custom tags) are left untouched. If you save the same section from the dsh settings page, it may overwrite this change — restart dsh soon after writing and double-check.
- **The dsh header carries no provider/model; attribution lives on assistant messages**: export writes the session's current provider/model (filled in first per the rules above) into each assistant message's `source`; once opened in dsh the session continues with dsh's current model configuration.
- **Model configuration targets the manual layer**: imported dsh `models[]` are written into the owc model catalog's manual layer; fields that don't map go into the report's "Unmapped fields" and are never guessed.
- **Off by default**: the extension is disabled by default, and once enabled it still only reads/writes files when you click "Preview" / "Run".
