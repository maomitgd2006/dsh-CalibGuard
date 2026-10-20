# dsh-calibguard

中文 | [English](README.en.md)

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A520-blue)
![tests](https://img.shields.io/badge/tests-95%20passed-brightgreen)
[![npm](https://img.shields.io/npm/v/dsh-calibguard.svg)](https://www.npmjs.com/package/dsh-calibguard)

把 [CalibGuard](https://github.com/P-436/CG) 的文件安全审计引擎接进 **DeepSeek Harness（DSH）**：
让 AI 在执行 / 安装来路不明的代码之前先过一道**本地**门控，你也可以在侧边栏面板里直接拖文件审计。

- 🔒 **默认离线**：本地 CodeBERT + Platt 校准给出可解释的「恶意概率」，文件内容不出本机；
- ☁️ **灰区才上云**：只有本地拿不准的文件才发一次云端复核（可关闭）；
- 🧭 **四档结论**：放行 / 可疑 / 拦截 / 转人工，附证据与 Markdown 报告；
- 🧰 **两种用法**：AI 工具调用（`calibguard_audit` / `calibguard_status`）+ 浏览器面板；
- ⚙️ **一套设置**：面板里保存的阈值与送审口径，AI 调用同样生效。

> 本仓库只是 **DSH 插件**；审计引擎本体在 [CG](https://github.com/P-436/CG) 仓库的 `CG_GUI/`，
> 本仓库不复制、不修改它，通过常驻 Python 子进程调用。

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

本插件只是"壳"：审计引擎（`calibguard/` + **475 MB 模型权重**）和 Python 依赖需要就位。
**不用手动装**——装好插件重启 DSH 后，若检测到缺少 `<engineRoot>/.venv`，插件会在**后台自动**：

1. 下载 CG 官方发行包 `CalibGuard-GUI.zip`（约 467 MB）并解压为**本包同级的 `CG_GUI/`**；
2. 创建 `.venv`（需要 **64 位 Python 3.10–3.12**，没有会明确报错说明原因）；
3. 按 `requirements-gui.txt` 安装依赖（约 1–3 GB）；
4. 就绪后工具/面板自动可用。

**进度在哪看**：面板顶部会出现「首次运行：正在自动准备引擎与依赖」卡片（含当前步骤与输出尾巴）；
宿主日志里是 `[calibguard]` 开头的行。准备期间审计按钮不可用，完成后点「刷新状态」即可。
首次约需 **10–20 分钟**（取决于网速和 pip 源），只需一次。

> 想提前预热、或断网/锁网环境需要离线安装，也可以手动跑安装器（同一套逻辑，幂等）：
>
> ```powershell
> node setup.mjs                          # 一键：下载 → 解压 → venv → 依赖 → 自检
> node setup.mjs --from D:\CalibGuard-GUI.zip   # 用已下载的发行包，不联网
> node setup.mjs --dest D:\CG_GUI         # 装到自定义位置（之后配置 engineRoot）
> ```
>
> 已有可用 `CG_GUI/`（含 `.venv`）的机器不会重复安装。
> 如果不想让插件自动联网，把插件配置 `autoSetup` 设为 `false`（此时缺环境会直接报错并提示手动安装）。

### 前提

1. **DSH**（DeepSeek Harness）0.1.5-rc.2 实测可用；
2. **Python 64 位 3.10–3.12**（首次自动安装依赖需要；已装好 `.venv` 的机器可忽略）；
3. **CG 引擎**：自动下载，或已有可用的 `CG_GUI/`（含 `calibguard/`、`models/`、`.venv`）。

### 方式 0：桌面端「添加插件」（最省事，推荐）

DSH 桌面版 → 设置 → **添加插件**，输入框里填以下任意一种即可（装完按提示重启 DSH）：

| 填什么 | 示例 | 说明 |
|---|---|---|
| **GitHub 仓库地址**（推荐） | `https://github.com/maomitgd2006/DSH_CG` | 自动拉取源码并登记到当前 profile 的 bundle |
| **本地目录路径** | `J:\CG\DSH_CG` | 已 clone / 解压到本机时用 |
| 包名 | `dsh-calibguard` | ✅ **已发布到 npm**（最新 v0.2.1）；直接输包名即可 |

> 等价命令行（已实测：安装后 DSH 会自动把包加进 profile 的 `dsh.profile.bundles`）：
>
> ```powershell
> dsh plugin --profile <profile> add https://github.com/maomitgd2006/DSH_CG
> dsh plugin --profile <profile> add file:J:\CG\DSH_CG
> ```
>
> 包名已发布：<https://www.npmjs.com/package/dsh-calibguard>（`npm i dsh-calibguard` 亦可）。

**无论用哪种方式**，装好后首次运行都不需要手动装引擎——插件会自动准备（见下一节）。

### 方式 A：源码方式（`file://` 行，无需安装）

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

### 方式 B：安装进 profile

```powershell
dsh plugin --profile <profile> add file:<本包绝对路径>
```

之后同样在 patch 里插一行，`name` 可以直接写包名 `dsh-calibguard`。
（`desktop` profile 被 Electron 独占，CLI 拒绝管理，桌面版只能走方式 A。）

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

面板「设置」区照搬 CG_GUI 的设置面板：**云端复核开关 → API Key / Base URL / 模型名称 / 送审内容 /
投递方式（截断或滑窗，参数联动显隐）→ 灰区范围**。

点「保存」后：

- 参数写入 `$DSH_HOME/calibguard-settings.json`（默认 `~/.dsh`，不写进仓库）；
- **AI 调用同样使用这份设置**（优先级：插件配置 < 共享设置 < 本次调用参数）；
- 改完立即生效，**不用重启**；
- API Key 写入 DSH 凭据库（`ctx.credentials`），不落入该设置文件。

### 4) 工具参数（按次覆盖，写给进阶用户）

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

---

## 配置

插件行 `config` 里常用的几项（完整表见 [docs/configuration.md](docs/configuration.md)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则什么都不注册（临时停用不必删行） |
| `engineRoot` | `''` | CG_GUI 目录；留空自动取本包**同级**的 `CG_GUI` |
| `device` | `auto` | 自动做「CUDA 版本 + 算力」双检，低算力显卡回落 CPU |
| `credentialRef` | `''` | 推荐的云端复核凭据引用名，如 `DEEPSEEK_API_KEY`（交给 DSH 凭据库解析） |
| `announceToModel` | `true` | 是否把「何时该用 CalibGuard」写进系统提示词 |
| `autoSetup` | `true` | 首次运行缺 `.venv` 时**自动**下载引擎并安装依赖；设 `false` 则只报错提示手动 `node setup.mjs` |
| `maxFiles` | `20` | 目录展开上限；显式给出/上传的文件不受限 |

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 侧边栏没有图标 / 面板报 `not found` | 客户端与路由在宿主启动时加载：**重启 DSH** |
| **首次运行要等十几分钟** | 正常：首次自动下载引擎（467 MB）并安装依赖（1–3 GB）；面板顶部有进度卡片，只需一次 |
| 首次审计很慢 | 正常：要加载约 475 MB 权重（之后走常驻进程） |
| 大文件审计几十秒 | 正常：全文滑窗逐窗推理，见 [docs/performance.md](docs/performance.md) |
| 灰区全部转人工 | 没配凭据：设 `credentialRef`（推荐）或在 DSH Models 页配置 |
| 正规第三方库被判 BLOCK | 压缩库充满 eval/base64 等特征，模型语料偏 Python 生态 → 属已知误报倾向，见 [docs/troubleshooting.md](docs/troubleshooting.md) |
| 面板报 401/403 | 浏览器会话未通过宿主鉴权：刷新页面/重新登录 |
| 改了参数 AI 没变 | 面板里需点「保存」（只改表单不保存 = 仅影响那一次） |

完整排错表：[docs/troubleshooting.md](docs/troubleshooting.md)。

---

## 项目结构

```
DSH_CG/
├── lib/                 Node 侧：插件入口、引擎管理、工具、路由、共享设置、浏览器面板
├── bridge/              Python 桥接：常驻子进程，行式 JSON 协议，复用引擎
├── cordis.patch.yml     组合包 patch（把插件行插进 profile 配置树）
├── scripts/             link-dsh（开发期挂包）、bridge-selftest（引擎自检）
├── test/                node --test（87 个用例；缺引擎环境时自动 skip）
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
| **maomitgd2006/DSH_CG**（本仓库） | DSH 插件：工具 / 服务 / 路由 + 浏览器面板 + Python 桥接 |
| [P-436/CG](https://github.com/P-436/CG) | 引擎与基准：`CG_GUI/`（桌面壳 + 引擎 + 模型）、`CG_Bench/`（训练/评测） |

## 许可证

[MIT](LICENSE) © 2026 maomitgd
