# dsh-calibguard

English | [中文](README.md)

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A520-blue)
![tests](https://img.shields.io/badge/tests-126%20passed-brightgreen)
[![npm](https://img.shields.io/npm/v/dsh-calibguard.svg)](https://www.npmjs.com/package/dsh-calibguard)

Plugs the [CalibGuard](https://github.com/P-436/CalibGuard) file-security auditing engine into
**DeepSeek Harness (DSH)**: the agent screens untrusted code *locally* before running or installing it,
and you can also drag files into a sidebar panel for the same audit.

- 🔒 **Offline by default** — a local CodeBERT model plus Platt calibration yields an interpretable
  "malicious probability"; file contents never leave the machine;
- ☁️ **Cloud review only for the gray zone** — only files the local model is unsure about trigger one
  cloud LLM call (can be disabled);
- 🧭 **Four verdicts** — allow / suspicious / block / manual review, with evidence and a Markdown report;
- 🧰 **Three interfaces** — agent tools (`calibguard_audit` audit / `calibguard_status` status / `calibguard_configure` settings) and a browser panel;
- 🛡️ **Plugin health checks** — when another DSH plugin is installed/updated, CalibGuard scans it and warns
  (one frequency dropdown: on update / periodic / off; never scans itself);
- 🔔 **Update notices** — periodically checks for a newer version of this plugin and **asks before upgrading
  (never silently upgrades)**; you can skip a version or disable the prompt;
- ⚙️ **One set of settings** — saved in the panel, used by the AI too.

> **This repository is only the DSH plugin — it is not the CalibGuard main repository.**
> CalibGuard main repository (engine, desktop GUI, benchmarks): **[P-436/CalibGuard](https://github.com/P-436/CalibGuard)**.
> To make the plugin work out of the box,
> the engine core needed at runtime (`calibguard/`, `audit_service.py`, tokenizer files and calibration
> parameters) is **copied into this repository under [`engine/`](engine/README.md)** (copied as-is, logic not
> modified; see that folder's README for how to re-sync). The 475 MB model weights are distributed as a
> release asset of this repository; at runtime the plugin runs the engine in a persistent Python child process.

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

**Install speed**: the model/engine archive is downloaded with **4 parallel ranged connections** (measured
0.6 MB/s single → 2.3 MB/s parallel); GitHub direct failures fall back to the gh-proxy / ghfast / ghproxy
mirrors, and pip tries Tsinghua → Aliyun → USTC → Tencent → PyPI in order. Tune with
`DSH_CALIBGUARD_DOWNLOAD_CONNECTIONS`.

**GPU auto-tiering**: with an NVIDIA GPU that has **CUDA ≥ 12.8 and compute capability ≥ 7.5** (RTX 20/30/40)
the installer pulls the **CUDA (cu128) build of torch**; otherwise it installs the CPU build (GTX 10 series is
SM 6.1 and has no kernels in the cu128 wheels). The panel header shows the inference device and the reason.

Manual override (optional): `node setup.mjs --force-cuda` (force the CUDA build, skipping the CUDA/compute
checks — use at your own risk) or `node setup.mjs --cpu` (force CPU), or the env vars
`DSH_CALIBGUARD_FORCE_CUDA=1` / `DSH_CALIBGUARD_CPU_ONLY=1`. Switch later with
`node setup.mjs --reinstall-torch --force-cuda` (or `--cpu`).

> The CPU and CUDA builds of torch **cannot coexist in one venv** (same package name; installing one replaces
> the other). The CUDA build is a full torch and falls back to CPU when no GPU is available, so coexistence is
> unnecessary.
>
> **Machines that already have the CPU build**: only when the GPU compute capability is **≥7.5** (e.g. RTX 2060)
> and torch is the CPU build does the panel header detect "NVIDIA … but torch is the CPU build" and offer a
> **one-click "Reinstall GPU torch (~2.5 GB)"** button (uninstalls the CPU build, installs CUDA, then restarts the
> bridge). GPUs below 7.5 (e.g. GTX 1060 5GB / 6.1) correctly stay on CPU and are no longer prompted to reinstall.

**Where to watch progress**: the panel shows a "First run: preparing engine and dependencies" card with
the current step and the tail of the installer output; host logs show `[calibguard]` lines. The audit
button stays disabled until it is ready — press "刷新状态 / Refresh" afterwards. Expect **10–20 minutes**
once (depends on network and pip mirror).

> **If the install was interrupted**: since 0.5.4, the installer actually imports torch / transformers /
> sklearn / openai and only then writes `<engineRoot>/.deps-ok.json`. If the install was interrupted
> (DSH closed, machine shut down), the next start detects the incomplete venv and **automatically repairs**
> it instead of treating it as ready (the panel shows "reinstalling missing dependencies").

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

**On DSH desktop it is one step: Settings → Add plugin → enter `dsh-calibguard` → restart DSH.**
That installs the latest npm release; to pin a version write `dsh-calibguard@0.3.3` (`@` + version).
No terminal and no source download needed.

The dialog also accepts any of the following (restart DSH afterwards):

| Paste | Example | Notes |
|---|---|---|
| **GitHub repository URL** (recommended) | `https://github.com/maomitgd2006/dsh-CalibGuard` | Fetches the source and registers the bundle in the current profile |
| **Local directory path** | `<path to this package>` (e.g. `/opt/dsh-calibguard`) | For a local clone / extracted copy |
| **Package name** | `dsh-calibguard` or `dsh-calibguard@0.3.3` | ✅ **Published on npm**; without a version it installs `latest`, with `@version` it pins that version |

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

The panel's "Regular parameters" section mirrors CG_GUI (**collapsed by default**; the summary shows the current
thresholds and cloud-review state): **cloud-review toggle → API Key / Base URL / model name / content source /
delivery mode (with the matching truncation or sliding-window fields) → gray zone**.

After pressing Save:

- values are written to `$DSH_HOME/calibguard-settings.json` (defaults to `~/.dsh`, never committed);
- **the AI uses the same values** (precedence: plugin config < shared settings < per-call options);
- changes take effect immediately, no restart;
- the API key goes into the DSH credential store (`ctx.credentials`), not into that settings file;
- the **credential name** is only the name of the storage slot (not the secret; pre-filled as
  `DEEPSEEK_API_KEY`): fill in the API key and save; the name is remembered in shared settings
  (`credentialRef`) and the value goes to the DSH credential store first. **If the current DSH version
  cannot be written from a plugin, the key is stored in the local `~/.dsh/calibguard-credentials.json`
  (0600, this machine only)** and the panel tells you where it landed;
- **audit results**: every audit writes JSON + Markdown into the engine's `reports/` directory
  (default `<engineRoot>/reports`, `engineRoot` defaults to `~/.dsh/calibguard-engine`). The panel shows
  that path, has a "clear results" button, and each item links to its Markdown report.

### 4) Let the agent change settings (`calibguard_configure`)

If the user does not know where to change something — or wants the agent to apply recommended values — just say:

> "set the allow threshold to 0.1 and block to 0.95" / "turn on cloud review with deepseek-chat" / "cap directory audits at 50 files" / "reset to defaults"

The agent calls `calibguard_configure`, which writes the **shared settings** (the same ones the panel saves;
effective immediately):

- editable: gray-zone thresholds, cloud-review switch, base URL / model name, content source, delivery mode,
  truncate/window sizes, directory `max_files`, and the credential **name**;
- `reset: true` behaves like the panel "reset"; passing `null` for one key restores that key's default;
- **security**: this tool can **never read or write an API key** (the result only contains the settings
  whitelist, never credential values). If a key is needed, ask the user to fill it in the panel —
  never ask for the key in chat.

### 5) Other DSH plugin scanning (automatic health check)

CalibGuard watches the profile's plugin list (`dsh.profile.bundles`) with **one frequency dropdown**:

| Frequency | Behavior |
|---|---|
| **On plugin-list update** (default) | scans newly installed/updated plugins and warns (removed plugins are ignored) |
| **Weekly / monthly / quarterly / half-yearly** | full scan when due |
| **Off** | disabled (the "scan all now" button still works manually) |

- **never scans itself** (`dsh-calibguard` ships models/tokenizer data and is the most sensitive package in
  the profile), and skips `@deepseek-ai/*` core packages by default;
- up to 100 files per plugin (adjustable 1–500), results summarized per plugin
  (block / manual_review / suspicious / allow);
- risky plugins are logged as `[calibguard] 插件提醒：name@version → …`; state lives in
  `$DSH_HOME/calibguard-plugin-scan.json`;
- these settings live in the collapsed **"Advanced / other settings"** section at the bottom of the panel;
  the AI can change them via `calibguard_configure`.

### 6) Update notices for this plugin (ask, never auto-upgrade)

- checks npm for a newer `dsh-calibguard` version: **off / on every DSH startup / daily / weekly**
  (default: every startup);
- when a newer version exists, the panel shows a notice at the top with current/latest versions and how to
  upgrade (desktop "Settings → Add plugin → `dsh-calibguard`", the CLI command, Release/npm links);
- **nothing is upgraded silently**; you can "skip this version" or "don't ask again" (persisted);
- state file: `$DSH_HOME/calibguard-self-update.json`; there is also an "check now" button in the collapsed area.

### 7) Tool parameters (per-call, advanced)

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

> There is also `calibguard_configure` for **persistent** shared settings (thresholds / cloud review /
> delivery mode / directory limit / credential name), shared with the panel; it never reads or writes the API key.

---

## Configuration

Common keys of the loader row `config` (full table: [docs/configuration.md](docs/configuration.md)):

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | When false nothing is registered (no need to remove the row) |
| `engineRoot` | `''` | CG_GUI directory; empty = the `CG_GUI` next to this package |
| `device` | `auto` | Checks both CUDA build and compute capability; low-end GPUs fall back to CPU |
| `credentialRef` | `''` | Credential **name** (storage slot, not the secret), e.g. `DEEPSEEK_API_KEY`; empty = use the name saved from the panel; the value lives in the DSH credential store / env |
| `announceToModel` | `true` | Add "when to use CalibGuard" to the system prompt |
| `autoSetup` | `true` | On first run, automatically download the engine, a portable Python when needed, and install deps; set `false` to only fail with instructions |
| `maxFiles` | `20` | Directory recursion cap; explicitly given/uploaded files are not capped |
| `pluginScanMode` | `'update'` | Other-plugin scan frequency: `off` / `update` (on plugin-list update) / `weekly` / `monthly` / `quarterly` / `halfyearly` |
| `pluginScanMaxFiles` | `100` | Max files scanned per plugin (1–500) |
| `selfUpdateCheck` | `'startup'` | Update-check frequency for this plugin: `off` / `startup` / `daily` / `weekly` (notice only, never silent upgrade) |

---

## FAQ

| Symptom | Fix |
|---|---|
| No sidebar icon / panel says `not found` | Client bundle and routes load at host startup: **restart DSH** |
| **First run takes 10–20 minutes** | Normal: the model (~442 MB, from the repository's model release asset with mirror fallback) and dependencies (1–3 GB) are installed once; the panel shows progress |
| First audit is slow | Normal: ~475 MB of weights are loaded once (then the process stays resident) |
| Big file takes tens of seconds | Normal: full-text sliding-window inference; see [docs/performance.md](docs/performance.md) |
| Gray zone always goes to manual review | No credential configured: save "credential name + API key" in the panel, or set `credentialRef`, or configure it in DSH Models |
| **Will it warn me about other DSH plugins / how to disable** | Default is "on plugin-list update"; the collapsed "Advanced / other settings" section lets you switch to weekly/monthly/quarterly/half-yearly or "off"; never scans itself or `@deepseek-ai/*`; state file `$DSH_HOME/calibguard-plugin-scan.json` |
| **Does CalibGuard auto-upgrade itself** | **No.** By default it checks once per DSH startup and only shows a notice; you can open the Release page / copy the command to upgrade, or "skip this version" / "don't ask again"; the check frequency (off/daily/weekly) is in the collapsed section |
| **After disabling cloud review and saving, the checkbox flips back on** | Fixed in 0.5.5: the bridge status reused the config captured when the model was first loaded, so a refresh restored stale values in the panel (the settings file was actually saved and later audits used the new values). Status now computes from the current shared settings, and the client overlays the saved values as a fallback; upgrade to ≥0.5.5 |
| **Clicking "Save" does nothing / errors (old versions)** | Old versions (≤0.3.5) failed to save the API key when the DSH credential store was not writable; since 0.3.6 (current 0.5.1) the key falls back to the local credential file and the panel shows the storage location. Settings and the key are saved in two steps: settings are written first, and a key failure is reported separately |
| **Don't know how to change the settings** | Just ask the agent: "set the thresholds / cloud review / delivery mode to …" — it calls `calibguard_configure` and the panel reflects it. API keys must be entered by the user in the panel; the tool never reads or writes them |
| **Panel says "credentialRef required" when saving the API key** | Upgrade to ≥ **0.3.3**: the panel has a "credential name" field (defaults to `DEEPSEEK_API_KEY`) and remembers it; older versions require `credentialRef` in the plugin config |
| **"This environment does not support writing the DSH credential store"** | Since 0.3.6 the key automatically falls back to the local `~/.dsh/calibguard-credentials.json` (0600) and the panel shows the storage location; you can also configure it in the DSH Models page, or use plugin config `llmApiKey` (not recommended) |
| **Where are audit results saved / how to clear them** | In the engine's `reports/` directory (default `<engineRoot>/reports`): JSON + Markdown per audit. The panel shows the path and has a "clear results" button; AI tools return `report_md_path` / `report_json_path` |
| **"No module named ''sklearn'' / ''torch'' / ''openai''", or status shows torch unavailable** | The engine venv is missing dependencies (usually because a previous install was interrupted and DSH restarted). Since **0.5.4** the plugin detects this on startup and automatically repairs it; on older versions run `node setup.mjs --dest "<engineRoot>"` in the plugin directory, then restart DSH (or press refresh) |
| **"First audit will load the model" hint shows every time** | Since 0.3.3 it is only shown while the model is not loaded yet; afterwards the button just says "auditing…" and the header shows "model loaded" |
| **NVIDIA GPU (e.g. RTX 2060 / GTX 1060) but the engine keeps using CPU** | Check the panel's "inference device" reason: compute capability **≥7.5** (e.g. RTX 2060) with CPU → the installed torch is the CPU build, upgrade to ≥0.3.3 and use the panel prompt or run `node setup.mjs --reinstall-torch` (~2.5 GB); compute capability **<7.5** (e.g. GTX 1060 5GB / 6.1) → **CPU is the expected behavior**, the CPU torch build is already optimal and the panel no longer prompts to reinstall |
| **Want to force the GPU / CPU torch build** | Add `--force-cuda` / `--cpu` at install time (combine with `--reinstall-torch` to replace an existing build); the runtime device is controlled by the plugin config `device` (auto/cpu/cuda); `cuda` requires the CUDA build |
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
├── test/                node --test (126 cases; auto-skip when the engine env is missing)
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
| **[P-436/CalibGuard](https://github.com/P-436/CalibGuard)** (CalibGuard main repository) | Engine and benchmark: `CG_GUI/` (desktop shell + engine + model), `CG_Bench/` (training/eval) |

## License

[MIT](LICENSE) © 2026 maomitgd
