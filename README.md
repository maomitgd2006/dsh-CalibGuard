# dsh-calibguard

中文 | [English](README.en.md)

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A520-blue)
![tests](https://img.shields.io/badge/tests-126%20passed-brightgreen)
[![npm](https://img.shields.io/npm/v/dsh-calibguard.svg)](https://www.npmjs.com/package/dsh-calibguard)

把 [CalibGuard](https://github.com/P-436/CalibGuard) 的文件安全审计引擎接进 **DeepSeek Harness（DSH）**：
让 AI 在执行 / 安装来路不明的代码之前先过一道**本地**门控，你也可以在侧边栏面板里直接拖文件审计。

- 🔒 **默认离线**：本地 CodeBERT + Platt 校准给出可解释的「恶意概率」，文件内容不会上传；
- ☁️ **灰区才上云**：只有本地拿不准的文件才发一次云端复核（可关闭）；
- 🧭 **四档结论**：放行 / 可疑 / 拦截 / 转人工，附证据与 Markdown 报告；
- 🧰 **三种用法**：AI 工具（`calibguard_audit` 审计 / `calibguard_status` 状态 / `calibguard_configure` 改设置）+ 浏览器面板；
- 🛡️ **插件体检**：安装/更新**别的 DSH 插件**时自动扫一遍并提醒（一个频率下拉控制：插件列表更新时 / 周期 / 关闭；不扫自己）；
- 🔔 **新版本提示**：定时检查本插件是否有新版本，**弹窗询问是否升级，绝不静默升级**（可设置跳过此版本/以后不再询问）；
- ⚙️ **一套设置**：面板里保存的阈值与送审口径，AI 调用同样生效。

> **本仓库只是 DSH 插件，不是 CalibGuard 主仓库。**
> CalibGuard 主仓库（引擎、桌面 GUI、基准）：**[P-436/CalibGuard](https://github.com/P-436/CalibGuard)**。
> 为了让插件开箱即用，运行所需的引擎核心
>（`calibguard/`、`audit_service.py`、词表与校准参数）已**复制到本仓库 [`engine/`](engine/README.md)**
>（只复制、不改逻辑，同步方法见该目录 README）；模型权重（475 MB）由本仓库 Release 资产分发；
> 运行时通过常驻 Python 子进程调用引擎。

---

## 有什么用（典型场景）

| 场景 | 你怎么用 | 它给你什么 |
|---|---|---|
| AI 要运行下载的脚本/安装包 | 说一句「安装前先审一下 `D:\downloads\setup.py`」 | 四档结论 + 触发证据 + 报告路径，AI 据此决定是否继续 |
| 手动检查可疑文件 / 压缩包 | 拖进侧边栏面板 | 逐文件结论、可排序、可点开 Markdown 报告 |
| 审计一整个目录 | 粘宿主机目录路径 | 递归逐文件审计（超过上限会明确提示「只审了前 N 个」） |
| 不想把代码传到云上 | 默认即离线；需要时关掉云端复核 | 全程本地推理，灰区按本地 0.5 切分 |
| 想要更稳/更省 | 面板调阈值、送审内容源、投递方式并保存 | 面板与 AI 共用同一套口径 |

## 结论怎么读

| 标签 | 含义 | 建议动作 |
|---|---|---|
| **BLOCK 拦截** | 本地模型高置信度恶意 | 不要执行；看报告里的证据 |
| **MANUAL 转人工** | 拿不准 / 云端复核失败 | 人工确认，或换个送审口径再跑 |
| **SUSPICIOUS 可疑** | 中等概率，可能是正常库里的危险 API | 结合报告判断；压缩后的第三方库常落这里或拦截（见 FAQ） |
| **ALLOW 放行** | 本地模型判定安全 | 可以继续 |

结果里还有：校准后概率 `p`、推理设备（cpu/cuda）、窗口数、文件 sha256、以及报告文件路径。

---

## 安装

### 开始前：引擎依赖会自动准备（对齐 CG_GUI 的「首启装环境」）

本插件**自带引擎**（`engine/`：复制自 CG_GUI 的 `calibguard/` 包、`audit_service.py`、词表与校准参数），
只差 **475 MB 模型权重**和 Python 依赖。**不用手动装**——装好插件重启 DSH 后，
若检测到缺少 `<engineRoot>/.venv`，插件会在**后台自动**：

1. 把内置 `engine/` 复制到 `<engineRoot>`（默认 `~/.dsh/calibguard-engine`）；
2. 从**本仓库 Release** 下载模型权重 `model.safetensors`（约 442 MB 压缩包，GitHub 直连失败会自动尝试 ghproxy 等镜像，
   缓存于 `~/.dsh/calibguard-tools/model-cache`）；
3. 创建 `.venv`（**不需要你预装 Python**：会自动选择本机 64 位 Python 3.10–3.12——会检查 PATH、`py` 启动器、
   `%LOCALAPPDATA%\Programs\Python`、常见安装目录；只有 3.13+ 或 32 位 Python 时**自动下载便携 Python 3.10.8**，
   约 30 MB，走 GitHub 镜像回退）；想单独准备/排查 Python 可运行 `node setup.mjs --prepare-python`；
4. 按 `requirements-gui.txt` 安装依赖（约 1–3 GB，默认清华 PyPI 镜像）；
5. 就绪后工具/面板自动可用。

> 默认**不再**从 GitHub 下载 CG 发行包；只有显式 `node setup.mjs --from <zip>` 或 `--url <地址>`
> 才会走 CG 发行包，用于离线/指定引擎版本。

**安装速度**：模型/引擎包默认 **4 路并发分段下载**（实测单连接 0.6 MB/s → 并发 2.3 MB/s），
GitHub 直连失败会自动换 gh-proxy / ghfast / ghproxy 镜像；pip 依赖按 清华 → 阿里 → 中科大 → 腾讯 → 官方
依次回退。可用 `DSH_CALIBGUARD_DOWNLOAD_CONNECTIONS` 调整并发数。

**GPU 自动定档**：检测到 NVIDIA 且 **CUDA ≥ 12.8、算力 ≥ 7.5**（RTX 20/30/40 系）时自动安装
**CUDA（cu128）版 torch**；否则装 CPU 版（GTX 10 系算力 6.1，cu128 轮子里没有对应 kernel，只能 CPU）。
面板顶部会显示「推理设备：cpu/cuda」和定档原因。

手动覆盖（可选）：
`node setup.mjs --force-cuda`（强制装 CUDA 版，跳过 CUDA/算力检查，风险自负）、
`node setup.mjs --cpu`（强制 CPU 版），或环境变量 `DSH_CALIBGUARD_FORCE_CUDA=1` /
`DSH_CALIBGUARD_CPU_ONLY=1`。装完想切换：`node setup.mjs --reinstall-torch --force-cuda` 或
`--reinstall-torch --cpu`。

> CPU 版与 CUDA 版 torch **不能同时存在于同一个 venv**（同名包会互相覆盖）；
> 但 CUDA 版 torch 本身就是完整 torch，没有 GPU 时会自动用 CPU，所以不需要共存。
>
> **已经有 CPU 版的机器**：仅当显卡算力 **≥7.5**（如 RTX 2060）且 torch 是 CPU 版时，面板顶部才会显示
> 「检测到 NVIDIA … 但当前 torch 是 CPU 版」并提供 **「一键重装 GPU 版 torch（约 2.5 GB）」** 按钮
>（会先卸载 CPU 版再装 CUDA 版，完成后自动重启桥接）；算力低于 7.5 的卡（如 GTX 1060 5GB / 6.1）强制 CPU
> 是正常行为，不会再提示重装。命令行：`node "<插件目录>/setup.mjs" --reinstall-torch --force-cuda`。

**进度在哪看**：面板顶部会出现「首次运行：正在自动准备引擎与依赖」卡片（含当前步骤与输出尾巴）；
宿主日志里是 `[calibguard]` 开头的行。准备期间审计按钮不可用，完成后点「刷新状态」即可。
首次约需 **10–20 分钟**（取决于网速和 pip 源），只需一次。

> **安装被中断怎么办**：0.5.4 起，装完依赖会实际导入 torch / transformers / sklearn / openai 校验，
> 成功才写 `<引擎目录>/.deps-ok.json`；如果安装中途被中断（关掉 DSH、关机），下次启动会检测到
> 依赖不完整并**自动补装**，不会再把半成品 venv 当作就绪（面板会显示"正在自动补装缺失依赖"）。

> 想提前预热、或断网/锁网环境需要离线安装，也可以手动跑安装器（同一套逻辑，幂等）：
>
> ```powershell
> node setup.mjs                          # 一键：内置引擎 → 下载模型 → venv → 依赖 → 自检
> node setup.mjs --from D:\CalibGuard-GUI.zip   # 用已下载的发行包，不联网
> node setup.mjs --dest D:\CG_GUI         # 装到自定义位置（之后配置 engineRoot）
> ```
>
> 已有可用 `CG_GUI/`（含 `.venv`）的机器不会重复安装。
> 如果不想让插件自动联网，把插件配置 `autoSetup` 设为 `false`（此时缺环境会直接报错并提示手动安装）。

### 前提

1. **DSH**（DeepSeek Harness）0.1.5-rc.2 实测可用；
2. **Python**：无需预装——没有 64 位 3.10–3.12 时安装器会自动下载便携版（缓存在 `~/.dsh/calibguard-tools`，可用 `--no-portable-python` 关闭）；
3. **引擎**：插件自带；模型权重会自动从本仓库 Release 下载（自动镜像回退）。也可用 `--from` 指定 CG 发行包，或把 `engineRoot` 指向已有 `CG_GUI/`。

### 方式 0：桌面端「添加插件」（最省事，推荐）

**DSH 桌面版只需要一步：设置 → 添加插件 → 输入 `dsh-calibguard` → 重启 DSH。**
默认装 npm 上的最新版；要固定版本就写 `dsh-calibguard@0.3.3`（`@` 后面是版本号）。
不需要命令行、不需要下载源码。

输入框里也可以填以下任意一种（装完按提示重启 DSH）：

| 填什么 | 示例 | 说明 |
|---|---|---|
| **GitHub 仓库地址**（推荐） | `https://github.com/maomitgd2006/dsh-CalibGuard` | 自动拉取源码并登记到当前 profile 的 bundle |
| **本地目录路径** | `<你的插件目录>`（例：`D:\code\dsh-calibguard`） | 已 clone / 解压到本地时用 |
| **包名** | `dsh-calibguard` 或 `dsh-calibguard@0.3.3` | ✅ **已发布到 npm**；不写版本=装 latest，写 `@版本`=固定版本 |

> 等价命令行（已实测：安装后 DSH 会自动把包加进 profile 的 `dsh.profile.bundles`）：
>
> ```powershell
> dsh plugin --profile <profile> add dsh-calibguard                                   # npm 包（推荐）
> dsh plugin --profile <profile> add https://github.com/maomitgd2006/dsh-CalibGuard           # GitHub 源码
> dsh plugin --profile <profile> add file:<本包绝对路径>                                # 本地目录
> ```
>
> npm 包页：<https://www.npmjs.com/package/dsh-calibguard>

**无论用哪种方式**，装好后首次运行都不需要手动装引擎——插件会自动准备（见下一节）。

### 方式 A：命令行安装（npm 包，适合非桌面版 / 脚本化）

```powershell
dsh plugin --profile <profile> add dsh-calibguard
```

之后同样在 profile 的 `cordis.patch.yml` 里插一行，`name` 直接写包名 `dsh-calibguard`
（本包自带的 `cordis.patch.yml` 会自动把插件行叠加进配置树）。

> `desktop` profile 被 Electron 独占，CLI 拒绝管理它 —— 桌面版请用「方式 0」，
> 或「方式 B」的 `file://` 行。

### 方式 B：源码方式（`file://` 行，适合本地开发 / 离线）

在 profile 的 `cordis.patch.yml` 末尾追加（路径改成你的实际位置）：

```yaml
- insert:
    - id: calibguard
      name: 'file:///<本包绝对路径>/lib/index.js'
      config:
        enabled: true
        device: auto
        announceToModel: true
```

`insert` 行的路径会被 DSH 自动改写成 `file://` URL；桌面版的 profile 在
`<DSH_HOME>/profiles/desktop/cordis.patch.yml`（`<DSH_HOME>` 默认 `~/.dsh`）。

可选：`node scripts/link-dsh.mjs` 把 DSH 自带的 `@deepseek-ai/*` 以目录联接挂到本包，让
`defineTool` / Config 结构校验这两个可选能力生效（不做也能跑）。

### 方式 C：发行包（离线 / 不想用 npm）

从 [Releases](https://github.com/maomitgd2006/dsh-CalibGuard/releases/latest) 下载
`dsh-calibguard-<版本>.zip`（约 100 KB，不含 `test/`），解压到一个固定目录，然后按「方式 B」
把 `name` 指向解压目录下的 `lib/index.js` 即可。

### 验证

- 重启 DSH 后，左侧边栏出现盾牌图标；面板顶部显示「引擎就绪 / 阈值 / 云端复核」状态；
- 或在对话里让我调用 `calibguard_status`，应返回设备、模型、阈值、凭据是否就绪；
- 命令行自检（不经 DSH，直接测引擎）：

```powershell
node scripts/bridge-selftest.mjs                       # 只看引擎状态
node scripts/bridge-selftest.mjs "<engineRoot>/samples" # 状态 + 试审计
```

> ⚠️ 改完 patch / 面板代码后**必须重启 DSH**：客户端 bundle 在宿主启动时加载，
> 已加载的 ESM 模块也有缓存。

---

## 使用

### 1) 让 AI 审计（工具调用）

直接说自然语言即可，AI 会调用 `calibguard_audit`：

```
「安装前先审一下 D:\downloads\setup.py」
「这个压缩包安全吗？D:\downloads\vendor.zip」
「把 D:\projects\vendor 目录里可疑的文件过一遍」
```

AI 能看到完整四档结论与证据；若你说「只审高危文件」，它还能按次改阈值（不影响你的全局设置）。

### 2) 面板（浏览器 UI）

侧边栏盾牌图标 → **拖文件进虚线框**（或点击选择、或粘贴宿主机路径）→「开始审计」。

- 压缩包由引擎在内存中解包后逐文件审计；上传只写系统临时目录、审计完即删；
- 大文件会按实测吞吐预估耗时（例如「预计 287 个滑窗，约 76 秒」），不会让你以为卡死；
- 结果按严重度排序，可点「查看 Markdown 报告」。

### 3) 共享设置（面板 ↔ AI 打通）

面板「常规参数设置」区照搬 CG_GUI 的设置面板（**默认收起**，摘要会显示当前阈值与云端复核状态）：
**云端复核开关 → API Key / Base URL / 模型名称 / 送审内容 / 投递方式（截断或滑窗，参数联动显隐）→ 灰区范围**。

点「保存」后：

- 参数写入 `$DSH_HOME/calibguard-settings.json`（默认 `~/.dsh`，不写进仓库）；
- **AI 调用同样使用这份设置**（优先级：插件配置 < 共享设置 < 本次调用参数）；
- 改完立即生效，**不用重启**；
- API Key 写入 DSH 凭据库（`ctx.credentials`），不落入该设置文件；
- **凭据名**只是"保存位置"的名字（不是密钥本身，面板默认预填 `DEEPSEEK_API_KEY`）：填 API Key 保存后，
  名字记进共享设置的 `credentialRef`，值优先写入 DSH 凭据库；**当前 DSH 版本不支持从插件写凭据库时，
  自动保存到本机 `~/.dsh/calibguard-credentials.json`（0600，仅本机）**，面板会明确提示存储位置；
- **审计结果**：每次审计在引擎的 `reports/` 目录生成 JSON + Markdown（默认 `<engineRoot>/reports`，
  `engineRoot` 默认 `~/.dsh/calibguard-engine`）。面板结果区会显示该路径并可「清空结果」，
  条目里的「查看 Markdown 报告」可直接打开。

### 4) 让 AI 帮你改设置（`calibguard_configure`）

不知道面板里怎么调、或者想让 AI 按建议设好，直接说：

> "把放行阈值改成 0.1、拦截阈值 0.95" / "开启云端复核，用 deepseek-chat" / "目录最多审 50 个文件" / "恢复默认设置"

AI 会调用 `calibguard_configure` 写入**共享设置**（与面板同一份，立刻生效）：

- 可改：灰区阈值、云端复核开关、Base URL / 模型名、送审内容源与投递方式、截断/滑窗参数、目录上限、凭据**名**；
- 传 `reset: true` 等价于面板「重置」（回到插件配置默认值）；某个键传 `null` 表示该项恢复默认；
- **安全限制**：该工具**不能读取、也不能写入 API Key**（返回值里永远只有白名单设置项，不含任何凭据值）。
  需要配置 Key 时，让 AI 提醒你在面板「设置 → API Key」里填，**不要把 Key 发在对话里**。

### 5) 其他 DSH 插件扫描（装插件时自动体检）

CalibGuard 会盯着当前 profile 的插件列表（`dsh.profile.bundles`），用**一个频率下拉**控制：

| 频率选项 | 行为 |
|---|---|
| **插件列表更新时**（默认） | 新装/升级别的插件后自动扫一遍并提醒（已删除的忽略） |
| **每周 / 每月 / 每季度 / 每半年** | 到期时全量巡检一遍 |
| **不扫描** | 完全关闭（「立即扫描全部」按钮仍可手动触发） |

- **不扫自己**（`dsh-calibguard` 自带模型/词表，自身就是高敏感大包），默认也跳过 `@deepseek-ai/*` 官方核心包；
- 每个插件默认最多扫 100 个文件（可调 1–500），结果按插件汇总（拦截/转人工/可疑/放行）；
- 有风险时宿主日志会打 `[calibguard] 插件提醒：xxx@1.2.3 → 拦截 …`；
- 结果文件：`$DSH_HOME/calibguard-plugin-scan.json`；
- 这些设置在面板底部 **「高级 / 其他设置」折叠区**里；也可让 AI 用 `calibguard_configure` 改。

### 6) 本插件更新检查（弹窗提示，绝不静默升级）

- 按频率检查 npm 上 `dsh-calibguard` 的最新版本：**关闭 / 每次启动 DSH / 每天 / 每周**（默认每次启动）；
- 发现新版本时面板顶部弹出提示：显示当前版本与最新版本、升级方式（桌面端「设置 → 添加插件 → 输入 `dsh-calibguard`」，或 CLI 命令、Release/npm 链接）；
- **不会自动升级**；用户可以选「跳过此版本」或「以后不再询问」（持久化，对应插件扫描状态文件旁的自更新状态文件）；
- 状态文件：`$DSH_HOME/calibguard-self-update.json`；也可以在折叠区点「立即检测」。

### 7) 工具参数（按次覆盖，写给进阶用户）

| 参数 | 说明 |
|---|---|
| `paths` | 必填；文件或目录绝对路径（相对路径按会话工作目录解析） |
| `include_evidence` | 是否返回证据详情（默认 `true`） |
| `max_files` | 目录递归展开上限（默认 20，1–200） |
| `allow_threshold` / `block_threshold` | 本次的灰区上下限（0<p<1） |
| `llm_enabled` | 本次是否启用云端复核 |
| `llm_content_source` | `evidence`（精炼证据）/ `raw`（文件原文） |
| `llm_delivery_mode` | `truncate` / `window` / `all` |
| `truncate_chars` / `window_chars` / `window_overlap` | 送审分片参数 |
| `window_stride` | 模型侧全文滑窗步长（1–511，默认 256；大文件可设 510 提速） |

> 另有 `calibguard_configure`：改**持久**共享设置（阈值/云端复核/送审方式/目录上限/凭据名），
> 与面板同一份；**不读写 API Key**。

---

## 配置

插件行 `config` 里常用的几项（完整表见 [docs/configuration.md](docs/configuration.md)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则什么都不注册（临时停用不必删行） |
| `engineRoot` | `''` | 引擎目录；留空自动推导：**npm/桌面端安装**时为 `~/.dsh/calibguard-engine`，源码仓库里为本包同级 `CG_GUI` |
| `device` | `auto` | 自动做「CUDA 版本 + 算力」双检，低算力显卡回落 CPU |
| `credentialRef` | `''` | 云端复核凭据**名**（保存位置，不是密钥），如 `DEEPSEEK_API_KEY`；留空=用面板「凭据名」保存的名字；值存放在 DSH 凭据库/环境变量 |
| `announceToModel` | `true` | 是否把「何时该用 CalibGuard」写进系统提示词 |
| `autoSetup` | `true` | 首次运行缺 `.venv` 时**自动**准备引擎（内置代码 + npm 模型分片）、按需下载便携 Python、安装依赖；设 `false` 则只报错提示手动 `node setup.mjs` |
| `maxFiles` | `20` | 目录展开上限；显式给出/上传的文件不受限 |
| `pluginScanMode` | `'update'` | 其他 DSH 插件扫描频率：`off` / `update`（插件列表更新时）/ `weekly` / `monthly` / `quarterly` / `halfyearly` |
| `pluginScanMaxFiles` | `100` | 单个插件一次最多扫描的文件数（1–500） |
| `selfUpdateCheck` | `'startup'` | 本插件新版本检查频率：`off` / `startup` / `daily` / `weekly`（只提示，不静默升级） |

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 侧边栏没有图标 / 面板报 `not found` | 客户端与路由在宿主启动时加载：**重启 DSH** |
| **首次运行要等十几分钟** | 正常：首次下载模型（约 442 MB，自动镜像回退）并安装依赖（1–3 GB）；面板顶部有进度卡片，只需一次 |
| 首次审计很慢 | 正常：要加载约 475 MB 权重（之后走常驻进程） |
| **装了别的 DSH 插件会提醒吗 / 怎么关** | 默认「插件列表更新时」扫描并提醒；面板底部「高级 / 其他设置」折叠区可改为每周/每月/每季度/每半年，或选「不扫描」关闭；不扫自己与 `@deepseek-ai/*`；结果在 `$DSH_HOME/calibguard-plugin-scan.json` |
| **会不会自动升级 CalibGuard** | **不会**。默认每次启动检查一次，发现新版本只在面板弹提示；你可以「打开 Release 页/复制命令」自行升级，或「跳过此版本」「以后不再询问」；检查频率可在折叠区改为关闭/每天/每周 |
| **关掉云端复核后保存，勾选状态又自动变回开启** | 0.5.5 已修复：桥接的 status 之前会复用「首次加载模型时的旧配置」，保存后刷新状态把旧值带回面板（其实设置文件已保存、后续审计也会用新值）。现在 status 按当前共享设置实时计算，客户端也会用已保存的设置兜底；升级到 ≥0.5.5 即可 |
| **点「保存」没反应 / 报错（旧版本）** | 旧版本（≤0.3.5）在 DSH 凭据库不可写时保存 API Key 会失败；升级到 ≥0.3.6（当前 0.5.1）会自动回退到本机凭据文件并提示存储位置。参数与 Key 是分两步保存的：参数先落盘，Key 失败会单独提示「参数已保存，但 API Key 写入失败」 |
| **不知道怎么改设置** | 直接让 AI 改：说"把阈值/云端复核/送审方式改成…"，AI 会调 `calibguard_configure` 写入共享设置（面板同步生效）；涉及 API Key 时必须自己在面板填，AI 不会读也不会写 Key |
| **面板保存 API Key 提示"需要 credentialRef"** | 升级到 ≥ **0.3.3**：面板「凭据名」可直接填写并记住（默认预填 `DEEPSEEK_API_KEY`）；旧版本请把 `credentialRef` 写进插件配置 |
| **提示"当前环境不支持写入 DSH 凭据库"** | ≥0.3.6 起会自动回退到本机凭据文件 `~/.dsh/calibguard-credentials.json`（0600），面板会显示存储位置；想改回凭据库时在 DSH Models 页配置即可。也可用插件配置 `llmApiKey`（不推荐） |
| **审计结果保存在哪 / 想清空** | 保存在引擎 `reports/` 目录（默认 `<engineRoot>/reports`），每次审计生成 JSON + Markdown；面板结果区显示路径并带「清空结果」按钮；AI 工具返回 `report_md_path` / `report_json_path` |
| **提示"需要 64 位 Python 3.10–3.12"或自动装 Python 失败** | 0.5.6 起会自动跳过 3.13+/32 位 Python，改用便携 Python 3.10.8（uv + GitHub 镜像回退）。想单独排查可运行 `node setup.mjs --prepare-python`（会打印检测到的 Python 列表并自动下载便携版）；网络受限时可手动安装 64 位 Python 3.12 后用 `--python "C:\Python312\python.exe"` 指定 |
| **报错 No module named 'sklearn' / 'torch' / 'openai'，或状态显示 torch unavailable** | 说明引擎 venv 的依赖没装全（典型原因：上次安装被中断后 DSH 重启）。升级到 **0.5.4** 后启动时会自动检测并补装；旧版本请在插件目录运行 `node setup.mjs --dest "<引擎目录>"`，完成后重启 DSH（或点刷新状态） |
| **审计时总提示"首次会加载模型"** | 0.3.3 起只在模型尚未加载时提示；加载后按钮只显示「审计中…」，顶部状态显示「模型 已加载」 |
| **有 NVIDIA 显卡（如 RTX 2060 / GTX 1060）但一直显示 CPU** | 先看面板的「推理设备」原因：算力 **≥7.5**（如 RTX 2060）却显示 CPU → 装的是 CPU 版 torch，升级到 ≥0.3.3 后点提示或运行 `node setup.mjs --reinstall-torch`（约 2.5 GB）；算力 **<7.5**（如 GTX 1060 5GB / 6.1）→ **强制 CPU 是正常行为**，CPU 版 torch 已是最优，面板不会提示重装 |
| **想强制用 GPU / CPU 版 torch** | 安装时加 `--force-cuda` / `--cpu`（配合 `--reinstall-torch` 可覆盖已装版本）；运行时设备由插件配置 `device`（auto/cpu/cuda）决定，`cuda` 需要 CUDA 版 torch |
| 大文件审计几十秒 | 正常：全文滑窗逐窗推理，见 [docs/performance.md](docs/performance.md) |
| 灰区全部转人工 | 没配凭据：在面板「凭据名 + API Key」保存，或设 `credentialRef`、或在 DSH Models 页配置 |
| 正规第三方库被判 BLOCK | 压缩库充满 eval/base64 等特征，模型语料偏 Python 生态 → 属已知误报倾向，见 [docs/troubleshooting.md](docs/troubleshooting.md) |
| 面板报 401/403 | 浏览器会话未通过宿主鉴权：刷新页面/重新登录 |
| 改了参数 AI 没变 | 面板里需点「保存」（只改表单不保存 = 仅影响那一次） |

完整排错表：[docs/troubleshooting.md](docs/troubleshooting.md)。

---

## 项目结构

```
dsh-CalibGuard/
├── lib/                 Node 侧：插件入口、引擎管理、工具、路由、共享设置、浏览器面板
├── bridge/              Python 桥接：常驻子进程，行式 JSON 协议，复用引擎
├── engine/              从 CG_GUI 复制来的引擎核心（代码/词表/校准参数，不含 475 MB 权重）
├── cordis.patch.yml     组合包 patch（把插件行插进 profile 配置树）
├── scripts/             link-dsh（开发期挂包）、bridge-selftest（引擎自检）
├── test/                node --test（126 个用例；缺引擎环境时自动 skip）
├── .github/workflows/   publish.yml：npm 可信发布（OIDC，可选）
└── docs/                配置全表、性能、排错、插件契约、实现决策
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/configuration.md](docs/configuration.md) | 完整配置项、参数优先级、凭据来源、共享设置 |
| [docs/performance.md](docs/performance.md) | 大文件为什么慢、两套滑窗（大小/步长/重叠）、提速手段、`maxFiles` 语义 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排错表、面板报错解读 |
| [docs/design-notes.md](docs/design-notes.md) | 三个关键实现决策（设备定档 / 凭据 / 客户端半边）与协议 |
| [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) | 从 DSH 0.1.5-rc.2 实测提取的插件契约速查（写插件用） |

## 相关仓库

| 仓库 | 内容 |
|---|---|
| **maomitgd2006/dsh-CalibGuard**（本仓库） | DSH 插件：工具 / 服务 / 路由 + 浏览器面板 + Python 桥接 |
| **[P-436/CalibGuard](https://github.com/P-436/CalibGuard)**（CalibGuard 主仓库） | 引擎与基准：`CG_GUI/`（桌面壳 + 引擎 + 模型）、`CG_Bench/`（训练/评测） |

## 许可证

[MIT](LICENSE) © 2026 maomitgd
