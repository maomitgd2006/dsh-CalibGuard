# dsh-calibguard

English | [中文](README.md)

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A520-blue)
![tests](https://img.shields.io/badge/tests-95%20passed-brightgreen)
[![npm](https://img.shields.io/npm/v/dsh-calibguard.svg)](https://www.npmjs.com/package/dsh-calibguard)

Plugs the [CalibGuard](https://github.com/P-436/CG) file-security auditing engine into
**DeepSeek Harness (DSH)**: the agent screens untrusted code *locally* before running or installing it,
and you can also drag files into a sidebar panel for the same audit.

- 🔒 **Offline by default** — a local CodeBERT model plus Platt calibration yields an interpretable
  "malicious probability"; file contents never leave the machine;
- ☁️ **Cloud review only for the gray zone** — only files the local model is unsure about trigger one
  cloud LLM call (can be disabled);
- 🧭 **Four verdicts** — allow / suspicious / block / manual review, with evidence and a Markdown report;
- 🧰 **Two interfaces** — agent tools (`calibguard_audit` / `calibguard_status`) and a browser panel;
- ⚙️ **One set of settings** — saved in the panel, used by the AI too.

> This repository is only the **DSH plugin**. The auditing engine lives in the
> [CG](https://github.com/P-436/CG) repository under `CG_GUI/`; it is neither copied nor modified here —
> the plugin runs it in a persistent Python child process.

---

## What it is for

| Scenario | How you use it | What you get |
|---|---|---|
| The agent is about to run a downloaded script/installer | Ask: "audit `D:\downloads\setup.py` before installing" | A verdict + triggering evidence + report path; the agent decides whether to proceed |
| You want to check a suspicious file or archive | Drag it into the sidebar panel | Per-file verdicts, sorted, with a clickable Markdown report |
| Audit a whole directory | Paste a host directory path | Recursive per-file audit (truncation is reported explicitly) |
| You don't want code sent to the cloud | Offline by default; toggle cloud review off | Fully local inference, gray zone split at 0.5 |
| You want a stricter/cheaper policy | Tune thresholds and delivery in the panel, then save | The panel and the AI share the same policy |

## Reading a verdict

| Label | Meaning | Suggested action |
|---|---|---|
| **BLOCK** | Locally high-confidence malicious | Do not run it; read the evidence |
| **MANUAL** | Uncertain / cloud review failed | Human review, or retry with another delivery mode |
| **SUSPICIOUS** | Medium probability; could be dangerous APIs inside a legitimate library | Combine with the report; compressed third-party libs often land here or in BLOCK (see FAQ) |
| **ALLOW** | Locally judged safe | Proceed |

Each result also carries the calibrated `p`, the inference device (cpu/cuda), window count,
file sha256, and the report path.

---

## Install

### Before you start: engine dependencies are prepared automatically (like CG_GUI's launcher)

The plugin **ships the engine code** (`engine/`: `calibguard/`, `audit_service.py`, tokenizer files and
calibration parameters copied from CG_GUI); only the **475 MB of model weights** and the Python dependencies
are missing. **You don't install them by hand.** After you install the plugin and restart DSH, if
`<engineRoot>/.venv` is missing the plugin automatically, in the background:

1. copies the bundled `engine/` into `<engineRoot>` (default `~/.dsh/calibguard-engine`);
2. downloads the model weights from a **release asset of this repository** (~442 MB; GitHub is tried first,
   then ghproxy-style mirrors; cached in `~/.dsh/calibguard-tools/model-cache`);
3. creates `.venv` (**no preinstalled Python required**: if no 64-bit 3.10–3.12 is found, a portable Python 3.10.8 is downloaded automatically, ~30 MB);
4. installs dependencies from `requirements-gui.txt` (1–3 GB, Tsinghua PyPI mirror by default);
5. becomes ready — tools and the panel just work.

> The CG release zip is **no longer downloaded from GitHub by default**; only an explicit
> `node setup.mjs --from <zip>` or `--url <url>` uses it (offline installs / pinning an engine version).

**Where to watch progress**: the panel shows a "First run: preparing engine and dependencies" card with
the current step and the tail of the installer output; host logs show `[calibguard]` lines. The audit
button stays disabled until it is ready — press "刷新状态 / Refresh" afterwards. Expect **10–20 minutes**
once (depends on network and pip mirror).

> You can also pre-warm, or install offline, by running the same installer manually (idempotent):
>
> ```powershell
> node setup.mjs                          # bundled engine → model release asset → venv → deps → self-check
> node setup.mjs --from D:\CalibGuard-GUI.zip   # use an already-downloaded release zip (offline)
> node setup.mjs --dest D:\CG_GUI         # custom location (then configure engineRoot)
> ```
>
> Machines that already have a working `CG_GUI/` (with `.venv`) are not touched.
> To disable the auto-download entirely, set the plugin option `autoSetup: false`.

### Prerequisites

1. **DSH** (DeepSeek Harness) — verified on 0.1.5-rc.2;
2. **Python**: nothing to install — when no 64-bit 3.10–3.12 is available the installer downloads a portable Python automatically (cached in `~/.dsh/calibguard-tools`; disable with `--no-portable-python`);
3. **Engine** — bundled with the plugin; model weights are downloaded from npm mirrors automatically. You can also pass `--from <zip>` or point `engineRoot` at an existing `CG_GUI/`.

### Option 0 — desktop "Add plugin" dialog (easiest, recommended)

DSH desktop → Settings → **Add plugin**, paste any one of the following (restart DSH afterwards):

| Paste | Example | Notes |
|---|---|---|
| **GitHub repository URL** (recommended) | `https://github.com/maomitgd2006/dsh-CalibGuard` | Fetches the source and registers the bundle in the current profile |
| **Local directory path** | `<path to this package>` (e.g. `/opt/dsh-calibguard`) | For a local clone / extracted copy |
| **Package name** | `dsh-calibguard` | ✅ **Published on npm**; just enter the package name (installs npm `latest`) |

> Equivalent CLI (verified: after install DSH automatically appends the package to the profile's
> `dsh.profile.bundles`):
>
> ```powershell
> dsh plugin --profile <profile> add dsh-calibguard                          # npm package (recommended)
> dsh plugin --profile <profile> add https://github.com/maomitgd2006/dsh-CalibGuard  # GitHub source
> dsh plugin --profile <profile> add file:<absolute path to this package>     # local directory
> ```
>
> npm package page: <https://www.npmjs.com/package/dsh-calibguard>

**Whichever way you install it**, the first run prepares the engine automatically (next section) — no manual setup needed.

### Option A — install via the CLI (npm package; for non-desktop / scripted setups)

```powershell
dsh plugin --profile <profile> add dsh-calibguard
```

Then insert the loader row in the profile's `cordis.patch.yml` with `name: dsh-calibguard`
(this package ships its own `cordis.patch.yml`, which is applied automatically as a bundle).

> The `desktop` profile is managed exclusively by the Electron app — CLI refuses it. Desktop users
> should use "Option 0", or the `file://` row in "Option B".

### Option B — source mode (a `file://` loader row, for local development / offline use)

Append to the profile's `cordis.patch.yml` (replace the path with yours):

```yaml
- insert:
    - id: calibguard
      name: 'file:///<absolute path to this package>/lib/index.js'
      config:
        enabled: true
        device: auto
        announceToModel: true
```

The `insert` path is rewritten to a `file://` URL by DSH. On desktop the profile lives at
`<DSH_HOME>/profiles/desktop/cordis.patch.yml` (`<DSH_HOME>` defaults to `~/.dsh`).

Optional: `node scripts/link-dsh.mjs` junctions DSH's own `@deepseek-ai/*` packages into this package so
the optional `defineTool` / Config schema support is active (everything still works without it).

### Option C — release archive (offline / no npm)

Download `dsh-calibguard-<version>.zip` (~100 KB, no `test/`) from
[Releases](https://github.com/maomitgd2006/dsh-CalibGuard/releases/latest), extract it to a fixed directory,
then point the `name` in "Option B" at `<extracted dir>/lib/index.js`.

### Verify

- After restarting DSH a shield icon appears in the sidebar; the panel header shows
  engine / thresholds / cloud-review status;
- Or ask the agent to call `calibguard_status` — it reports device, model, thresholds and credential state;
- Command-line self-check (bypasses DSH, tests the engine directly):

```powershell
node scripts/bridge-selftest.mjs                        # engine status only
node scripts/bridge-selftest.mjs "<engineRoot>/samples" # status + a trial audit
```

> ⚠️ Restart DSH after changing the patch or the panel code: the client bundle is loaded at host
> startup and ESM modules are cached.

---

## Usage

### 1) Let the agent audit (tool calls)

Just ask in natural language; the agent calls `calibguard_audit`:

```
"Audit D:\downloads\setup.py before installing it."
"Is this archive safe? D:\downloads\vendor.zip"
"Go through D:\projects\vendor and flag anything suspicious."
```

The agent sees the full verdict, evidence and report path. It can also override thresholds for a single
call (without touching your saved settings).

### 2) The panel (browser UI)

Sidebar shield icon → **drop files onto the dashed area** (or pick files, or paste host paths) → "开始审计" (Start).

- Archives are unpacked in memory and audited file by file; uploads are written to a temp dir and deleted afterwards;
- Large files get an ETA based on measured throughput (e.g. "287 windows, ~76 s"), so it never looks hung;
- Results are sorted by severity; click "查看 Markdown 报告" to read the report.

### 3) Shared settings (panel ↔ AI)

The panel's settings section mirrors CG_GUI: **cloud-review toggle → API Key / Base URL / model name /
content source / delivery mode (with the matching truncation or sliding-window fields) → gray zone**.

After pressing Save:

- values are written to `$DSH_HOME/calibguard-settings.json` (defaults to `~/.dsh`, never committed);
- **the AI uses the same values** (precedence: plugin config < shared settings < per-call options);
- changes take effect immediately, no restart;
- the API key goes into the DSH credential store (`ctx.credentials`), not into that settings file.

### 4) Tool parameters (per-call, advanced)

| Parameter | Description |
|---|---|
| `paths` | Required; absolute file or directory paths |
| `include_evidence` | Return evidence details (default `true`) |
| `max_files` | Directory recursion cap (default 20, 1–200) |
| `allow_threshold` / `block_threshold` | Gray-zone bounds for this call (0 < p < 1) |
| `llm_enabled` | Enable cloud review for this call |
| `llm_content_source` | `evidence` (distilled) / `raw` (preprocessed text) |
| `llm_delivery_mode` | `truncate` / `window` / `all` |
| `truncate_chars` / `window_chars` / `window_overlap` | Cloud-delivery chunking |
| `window_stride` | Model-side sliding-window stride (1–511, default 256; 510 speeds up big files) |

---

## Configuration

Common keys of the loader row `config` (full table: [docs/configuration.md](docs/configuration.md)):

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | When false nothing is registered (no need to remove the row) |
| `engineRoot` | `''` | CG_GUI directory; empty = the `CG_GUI` next to this package |
| `device` | `auto` | Checks both CUDA build and compute capability; low-end GPUs fall back to CPU |
| `credentialRef` | `''` | Recommended credential reference name, e.g. `DEEPSEEK_API_KEY` (resolved via the DSH credential store) |
| `announceToModel` | `true` | Add "when to use CalibGuard" to the system prompt |
| `autoSetup` | `true` | On first run, automatically download the engine, a portable Python when needed, and install deps; set `false` to only fail with instructions |
| `maxFiles` | `20` | Directory recursion cap; explicitly given/uploaded files are not capped |

---

## FAQ

| Symptom | Fix |
|---|---|
| No sidebar icon / panel says `not found` | Client bundle and routes load at host startup: **restart DSH** |
| **First run takes 10–20 minutes** | Normal: the model (476 MB) is downloaded from npm mirrors and dependencies (1–3 GB) are installed once; the panel shows progress |
| First audit is slow | Normal: ~475 MB of weights are loaded once (then the process stays resident) |
| Big file takes tens of seconds | Normal: full-text sliding-window inference; see [docs/performance.md](docs/performance.md) |
| Gray zone always goes to manual review | No credential configured: set `credentialRef` (recommended) or configure it in DSH Models |
| A legitimate third-party library is BLOCKed | Minified libraries are full of eval/base64 patterns and the corpus is Python-heavy — known false-positive tendency, see [docs/troubleshooting.md](docs/troubleshooting.md) |
| Panel returns 401/403 | Browser session isn't authenticated with the host: refresh / sign in again |
| The AI ignores changed settings | Press Save in the panel; editing fields without saving applies to that run only |

Full troubleshooting table: [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Layout

```
dsh-CalibGuard/
├── lib/                 Node side: plugin entry, engine manager, tools, routes, settings, browser panel
├── bridge/              Python bridge: persistent child process, line-delimited JSON protocol
├── engine/              Bundled engine core copied from CG_GUI (code / tokenizer / calibration, no weights)
├── cordis.patch.yml     Bundle patch (inserts the loader row)
├── scripts/             link-dsh (dev-time junction), bridge-selftest (engine self-check)
├── test/                node --test (95 cases; auto-skip when the engine env is missing)
├── .github/workflows/   publish.yml: npm trusted publishing (OIDC, optional)
└── docs/                configuration, performance, troubleshooting, plugin contract, design notes
```

## Docs

| Document | Contents |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Full option table, precedence, credential sources, shared settings |
| [docs/performance.md](docs/performance.md) | Why big files are slow, the two sliding windows (size/stride/overlap), speed-ups, `maxFiles` semantics |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Troubleshooting table, panel error decoding |
| [docs/design-notes.md](docs/design-notes.md) | Three key design decisions (device tiering / credentials / client half) and the protocol |
| [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) | DSH plugin contract cheat-sheet extracted from 0.1.5-rc.2 (Chinese) |

## Related repositories

| Repository | Contents |
|---|---|
| **maomitgd2006/dsh-CalibGuard** (this repo) | DSH plugin: tools / service / routes + browser panel + Python bridge |
| [P-436/CG](https://github.com/P-436/CG) | Engine and benchmark: `CG_GUI/` (desktop shell + engine + model), `CG_Bench/` (training/eval) |

## License

[MIT](LICENSE) © 2026 maomitgd
