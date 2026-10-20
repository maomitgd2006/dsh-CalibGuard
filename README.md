# dsh-calibguard —— CalibGuard × DeepSeek Harness 插件

把 [CalibGuard](https://github.com/maomitgd2006/CG) 的文件安全审计引擎接进 DSH，提供**两种使用形态**：

> 本仓库只是 **DSH 插件**（宿主 + 客户端双半边）；审计引擎本体在 CG 仓库的 `CG_GUI/` 里，
> 本仓库不复制、不修改它，通过常驻 Python 子进程调用。

1. **模型工具**：我在运行/安装/交付任何来路不明的代码之前，先调 `calibguard_audit` 拿四档结论；
2. **浏览器面板**：Harness 左侧边栏出现 CalibGuard 图标，点开是一个页面 —— **直接把文件拖进去审计**、
   粘宿主机路径、调阈值/滑窗/截断，看结果与 Markdown 报告。

> 定位：DSH 的**宿主 + 客户端双半边插件**，不重写任何审计逻辑 —— 它把 `CG_GUI/calibguard`
> 原封不动地跑在一个常驻 Python 子进程里（见 `bridge/calibguard_bridge.py`），
> Node 侧只负责**进程管理 + 协议 + 工具/路由暴露**，浏览器侧只负责**拖拽与展示**。

## 相关仓库

| 仓库 | 内容 |
|---|---|
| [maomitgd2006/DSH_CG](https://github.com/maomitgd2006/DSH_CG) | **本仓库**：DSH 插件 —— 宿主侧工具/服务/路由 + 浏览器面板 + Python 桥接 |
| [maomitgd2006/CG](https://github.com/maomitgd2006/CG) | 引擎与基准：`CG_GUI/`（桌面壳 + `calibguard/` 引擎 + 模型）、`CG_Bench/`（训练/评测）、模型与数据说明 |

> 本插件的运行前提：本机有 CG 仓库的 `CG_GUI/`（含 `.venv` 与模型权重，不入库）。
> 插件配置项 `engineRoot` 默认取**本包同级目录**的 `CG_GUI`，也可显式指定任意路径。
> 版本记录见 [Releases](https://github.com/maomitgd2006/DSH_CG/releases)。

---

## 一、装了什么

| 交付物 | 说明 |
|---|---|
| `lib/index.js` | 插件入口：`{ name, inject, Config, apply }`，注册工具 + UI 路由 + 暴露 `calibguard` 服务 + 可选系统提示词片段 |
| `lib/engine.js` | 桥接进程管理：懒启动、单飞串行、超时、空闲回收、崩溃自愈、凭据每次解析、清洗后的子进程环境 |
| `lib/tools.js` | 两个工具的定义（参数方言 / 输出 schema / 渲染 / 调用级参数校验） |
| `lib/routes.js` | 五条宿主 HTTP 路由：`GET /status`、`GET|PUT /settings`、`PUT /credential`、`POST /audit`（含 base64 拖拽上传）、`GET /report` |
| `lib/client.js` | **浏览器半边**（纯 JS、免打包）：侧边栏图标 + 主面板（拖拽 / 参数 / 结果 / 报告） |
| `lib/config.js` | 配置默认值、归一化与校验；Schemastery `Config` 为**可选**能力 |
| `bridge/calibguard_bridge.py` | 桥接进程：行式 JSON 协议，复用 `AuditPipeline`；**含设备定档**（见第四节） |
| `cordis.patch.yml` | 组合包 patch：把插件行插进 profile 配置树 |
| `test/` | 配置 / 环境清洗 / 工具 / 路由 / 客户端 bundle / 插件注册与凭据解析 / 真 cordis 装载 / 真模型端到端 / DSH 官方校验器 |
| `docs/dsh-plugin-contract.md` | 从 DSH 0.1.5-rc.2 安装里实测提取的插件契约速查（写插件时先看这个） |

**两个工具**：

- `calibguard_audit(paths, include_evidence?, max_files?, …可选覆盖)` —— 审计文件或目录。
  目录会被递归展开并按 `max_files` 截断；相对路径按会话工作目录解析。
  **可以按次覆盖配置**（不改插件配置）：`allow_threshold`、`block_threshold`、`llm_enabled`、
  `llm_content_source`（evidence/raw）、`llm_delivery_mode`（truncate/window/all）、
  `truncate_chars`、`window_chars`、`window_overlap`、`window_stride`（模型侧步长，大文件提速用）。
- `calibguard_status()` —— 引擎就绪状态：Python/torch/CUDA、**设备定档结论与理由**、模型与校准参数是否就位、
  当前门控阈值、云端复核是否配好凭据。

**浏览器面板**（重启 DSH 后出现）：

- 侧边栏图标（`sidebar.panellist`，id=`calibguard`）→ 主面板（`main` keyed by `calibguard`）；
- **设置区照搬 CG_GUI 的设置面板**（同样的顺序、同样的文字、同样的联动显隐）：
  1. `☑ 使用云端 LLM 复核灰区文件` + 关闭后按本地 0.5 判定的说明；
  2. LLM 组（关闭时整组置灰禁用）：**API Key / Base URL / 模型名称 / 送审内容 / 投递方式**，
     选「截断」时只显示**截断大小（字符）**，选「滑窗」时显示**滑窗大小（字符）**与**滑窗重叠（字符）**；
  3. **灰区范围（校准后恶意概率）**：下限 ~ 上限；
  4. **高级**（CG_GUI 没有的项）：**目录文件上限**（默认 20，1–200）—— 只限制"传一个目录时
     递归展开多少个文件"，防止误传 `node_modules`/素材包把审计拖到失控；被截断时结果里会明确
     提示"仅审计了前 N 个"。**你显式拖入或粘贴的文件不受该上限影响**（单次上传上限 50 个）；
     **模型侧窗口不在此暴露**（固定 512 token 窗 / 重叠 254 token，判断优先），需要给大文件
     提速时用工具参数 `window_stride=510` 或在插件配置里设 `windowStride`；
  5. 保存 / 重置 + 提示信息（保存位置、Key 去向）；
- 审计区：**拖文件进来**（或点击选择）、粘宿主机路径；压缩包内存解包后逐文件审计，
  上传只写系统临时目录、审计完即删；大文件会按实测吞吐预估耗时；
- 结果按严重度排序、彩色四档标签、证据与 LLM 复核理由；可点开 Markdown 报告原文。

**API Key 存在哪**：界面上的 Key 输入框会把值写入 **DSH 凭据库**（`ctx.credentials.set`，
引用名由插件配置 `credentialRef` 指定），**不落 `calibguard-settings.json`**。
若对应环境不支持写入凭据库，会提示改用 DSH Models 页或插件配置 `llmApiKey`。

### 为什么是「一个包、两种壳」而不是两个文件夹

两种壳共用同一份引擎、同一个常驻桥接进程、同一份设置，只是入口不同：

| 壳 | 谁触发 | 入口 |
|---|---|---|
| **工具壳** | AI（模型自己判断，或你点名） | `calibguard_audit` / `calibguard_status` 工具 |
| **GUI 壳** | 你（拖文件、粘路径、看报告） | 侧边栏图标 → 主面板 |

拆成两个文件夹会变成两份引擎副本、两个桥接进程、两套配置要同步，反而是负担，所以**保持二合一**；
两者靠**共享设置**打通（见下）。

### 共享设置（GUI ↔ AI 打通的关键，等价 CG_GUI 的 `gui-settings.json`）

| 项 | 说明 |
|---|---|
| 文件 | `$DSH_HOME/calibguard-settings.json`（`$DSH_HOME` 默认 `~/.dsh`，即 Windows 的 `C:\Users\<你>\.dsh`；**不写进仓库**） |
| 内容 | 云端复核开关、Base URL、模型名、送审内容、投递方式、截断/滑窗大小与重叠、灰区上下限、目录上限（**不含凭据、不含模型侧步长**） |
| 优先级 | 插件配置（部署默认） → **共享设置** → 本次调用参数（最高） |
| 写入 | 面板「保存」→ `PUT /api/calibguard/settings`；原子写，非法值不落盘（校验口径与 CG_GUI 一致） |
| 读取 | 面板加载时回填；AI 每次调用时由引擎合并，**改完立即生效、无需重启** |

> 上传走 `POST /api/calibguard/audit`（`{files:[{name,base64}], paths, options}`），
> 浏览器侧只读取 `File` 并转 base64，宿主侧零依赖解析；单次请求体上限 32MB、解码后 24MB、最多 50 个文件。
> 路由清单：`GET /status`、`GET|PUT /settings`、`PUT /credential`、`POST /audit`、`GET /report?name=<id>`。

### 目录文件上限（`maxFiles`）是什么

审计目标可以是一个**目录**：引擎会 `os.walk` 递归收集里面的文件（按路径排序、跳过报告输出目录）。
`maxFiles` **只限制这一步最多取多少个文件**（默认 20，范围 1–200）：

| 你给的东西 | 受 `maxFiles` 限制？ |
|---|---|
| 一个目录，如 `D:\downloads\vendor` | ✅ 递归展开合计最多取 `maxFiles` 个 |
| 一个具体文件，如 `setup.py` | ❌ 全部审计 |
| 面板拖入/上传的文件（单次 ≤50 个） | ❌ 全部审计 |

超出时结果里 `truncated=true`，工具摘要与面板都会提示"仅审计了前 N 个"。
默认只给 20 的理由：单个文件就可能几十秒（见「四、4. 大文件为什么慢」），
目录里若混着 `node_modules`/素材包，不设上限会跑到失控。

**对外服务**：`ctx.calibguard`（`inspect()` / `audit()` / `bridgeOptions()` / `diagnostics()` /
`resolveCredential()` / `setCredential()` / `dispose()`），供其它插件复用同一套阈值与云端复核配置。

---

## 二、快速开始

### 方式 A：源码方式（无需安装）

在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: calibguard
      name: 'file:///<本包绝对路径>/lib/index.js'
      config:
        enabled: true
        device: auto
        announceToModel: true
```

`insert` 行里的绝对路径/`./` 相对路径会被 DSH 自动改写成 `file://` URL（相对 patch 文件所在目录）。
如果你用的是 Electron 桌面版，改的就是 `<DSH_HOME>/profiles/desktop/cordis.patch.yml`（`<DSH_HOME>` 默认 `~/.dsh`）。

然后：

```powershell
# 1) 挂上 DSH 自带的包（仅让 Config/defineTool 这两个可选能力可用；不做也能跑）
node scripts/link-dsh.mjs

# 2) 自检：引擎状态 + 试审计（<engineRoot> 指向 CG_GUI 目录）
node scripts/bridge-selftest.mjs "<engineRoot>/samples"

# 3) 全部测试
node --test
```

### 方式 B：正规安装进 profile

```powershell
dsh plugin --profile <profile> add file:<本包绝对路径>
```
之后同样在 patch 里插一行，只是 `name` 可以写成包名 `dsh-calibguard`（此时本包也会作为 bundle
被识别，`cordis.patch.yml` 会被自动叠加）。`desktop` profile 被 Electron 独占，CLI 会拒绝管理它 —— 桌面版只能走方式 A。

> ⚠️ **改完 patch 需要重启 DSH 才生效**：桌面 profile 没有声明 `patchReload: live`，
> 而且已经加载过的插件模块在 Node 的 ESM 缓存里；重启后新的 schema/代码才会生效。

---

## 三、配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则什么都不注册（临时停用不必删行） |
| `engineRoot` | `''` | CG_GUI 目录；留空自动推导为 `DSH_CG` 的同级 `CG_GUI` |
| `pythonPath` | `''` | 解释器；留空依次尝试 `<engineRoot>/.venv` → `DSH_CALIBGUARD_PYTHON` → PATH |
| `device` | `auto` | `auto` 会做「CUDA 版本 + 算力」双检；`cpu` / `cuda` 为强制 |
| `useGuiSettings` | `true` | 复用 `CG_GUI/gui-settings.json`（与桌面壳共享同一份阈值/云端配置） |
| `announceToModel` | `true` | 是否把「何时该用 CalibGuard」写进系统提示词 |
| `maxFiles` | `20` | **目录展开上限**（1–200）：只限制"给一个目录时递归展开多少个文件"；显式给出的文件/上传的文件全部审计 |
| `auditTimeoutMs` | `600000` | 单次审计超时；首次调用要加载模型 |
| `idleShutdownMs` | `600000` | 空闲多久回收桥接进程（`0`=常驻） |
| `reportDir` | `''` | 报告目录；留空=引擎默认 `<engineRoot>/reports` |
| `allowThreshold` / `blockThreshold` | 跟随引擎 | 灰区上下限 |
| `credentialRef` | `''` | **推荐**：DSH 凭据引用名，交给 `ctx.credentials` 解析（如 `DEEPSEEK_API_KEY`） |
| `llmApiKey` | `''` | 字面值 Key（不推荐，会落在配置文件里）；优先于 `credentialRef` |
| `sensitiveEnvPattern` | `''` | 桥接子进程环境清洗的兜底正则；留空=用 DSH 的实现或内置启发式 |
| `settingsPath` | `''` | GUI 与 AI 共用的设置文件；留空=`$DSH_HOME/calibguard-settings.json` |
| `windowStride` | 跟随引擎（256） | 模型侧全文滑窗步长（1~511）；**不在面板/共享设置里**，只走插件配置或工具参数；设 **510** 时窗口数约减半 |
| `llmEnabled` / `llmBaseUrl` / `llmModel` | 跟随引擎 | 云端复核开关与端点（不配凭据时灰区转人工） |
| `llmContentSource` / `llmDeliveryMode` | 跟随引擎 | 送审内容源（evidence/raw）与投递模式（truncate/window/all） |

**参数优先级**：

```
引擎默认值 < 插件配置(patch 行) < 共享设置(GUI 保存的) < 本次调用参数(工具参数 / 面板单次参数)
```
- AI 工具调用：自动叠加「共享设置」，所以面板里保存的阈值/送审方式对 AI 同样生效；
- 面板「开始审计」：把当前表单作为本次调用参数（最高层）；
- 面板「保存为共享设置」：写入共享设置层（对两个壳都生效，且不用重启）。

> **云端复核的 Key 从哪来（不硬编码、不隐式继承）**
>
> 1. `credentialRef`（推荐）→ 交给 DSH 的 `ctx.credentials.resolve()`，优先级
>    **继承环境 > `~/.dsh/.credentials.yaml` > `.env`**；解析到的值随请求走 stdin 下发，
>    **不进 argv、不进子进程环境变量**，且每次操作重新解析（换 Key 下一次审计即生效）。
> 2. `llmApiKey`（字面值，次选）。
> 3. `gui-settings.json` 里的 `deepseek_api_key`（桌面壳同款，`useGuiSettings: true` 时生效）。
>
> 三者都没有 → 云端复核不可用、灰区转人工（安全降级）。桥接进程**不会**去扒宿主的
> `DEEPSEEK_API_KEY`：子进程环境已按 DSH 的 `scrubbedParentEnv` 清洗。

---

## 四、三个必须知道的实现决策

### 1. 设备定档：低算力显卡必须回落 CPU

开发测试机上是 **GTX 1060 5GB（算力 6.1）**，而 `torch 2.11.0+cu128` 的轮子最低要求 **sm_75**。
`CodeBERTClassifier` 自己只判断 `torch.cuda.is_available()` —— 它**看不到算力**，于是会选中 CUDA，
然后在每个文件上抛 `CUDA error: no kernel image is available`；而引擎的安全降级会把这条错误
包装成「每份文件都转人工」，**看起来像成功，实际上零判别力**。

所以桥接进程在 **import torch 之前**先定档（与 `CG_GUI/launcher.py` 的 `CUDA_MIN_COMPUTE_CAP` 同一阈值）：

- 用 `nvidia-smi --query-gpu=name,compute_cap` 读算力；算力 < 7.5 → 强制 CPU；
- 读不到算力时才在**子进程**里跑一次最小 CUDA 内核自检（失败不污染本进程）；
- 强制手段是 `CUDA_VISIBLE_DEVICES=-1`。**注意不能写空串**：实测 `torch 2.11` 把
  `CUDA_VISIBLE_DEVICES=""` 当作「未设置」，`is_available()` 仍为 `True`；只有 `-1` 才真正隐藏设备。

定档结论会出现在 `calibguard_status` 的 `devicePolicy` 里（含理由），审计结果里也会带上实际设备。

### 2. 凭据：不硬编码、不隐式继承

- **不扒宿主环境**：桥接子进程的环境经过清洗，形如 `*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*`
  以及全部 `DSH_*` 的变量都不传（规则直接复用 DSH 自己导出的 `scrubbedParentEnv`，不复制它的正则）；
- **不写死凭据名**：要哪把凭据由配置 `credentialRef` 指定，交给 DSH 的 `ctx.credentials.resolve()`
  解析（优先级：继承环境 > `~/.dsh/.credentials.yaml` > `.env`）——名字写在你的配置里，代码里没有；
- **不把 Key 放 argv / 环境变量**：解析到的值随请求走 subprocess 的 **stdin 私有管道**下发给桥接，
  不进程列表可见；桥接侧收到后热重建 LLM 客户端（模型不重载）；
- **每次操作重新解析**：因此在 DSH 里换了 Key，下一次审计就生效，无需重启。

不配 `credentialRef`（也没有 `llmApiKey` / `gui-settings.json` 里的 Key）时：云端复核不可用，
灰区会转人工 —— 这是安全的降级，不是故障。

### 3. 客户端半边：先不做，后来做了

DSH 允许插件用**纯 JS**（无需打包器）贡献浏览器 UI，卡片插槽 `tool.call.toolview` 的 `key` 就是工具名
—— 契约已经实测记录在 [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md#8-客户端半边web)。

**早期版本（v0.1）刻意不带客户端半边**：当时无法在开发机上验证浏览器侧代码，而 client bundle 在宿主
启动时就会被读取（文件缺失会直接抛 `MissingClientBundleError`），把没法验证的 UI 代码塞进正在使用的
GUI 风险不对称，工具卡片由 `output.render` 的文本承担。

**现在已实现**（`lib/client.js`）：侧边栏图标 + `main` 面板 + 宿主 HTTP 路由，见「浏览器面板」一节。
UI 注册全部包在 try/catch 里，面板起不来也不影响工具。

### 4. 大文件为什么慢（实测：3.53MB 的 echarts.js）

**不是 bug，是成本随文本长度线性增长。** 实测拆解：

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 预处理 | ~0.05 s | 引擎只读前 1MB，清洗后文本上限 **20 万字符** |
| 特征提取（7 类正则+高熵） | 0.10 s | 不是瓶颈 |
| 分词 | 0.14 s | → **73,573 tokens** |
| 滑窗切分 | — | 512 token 窗 / **256 步长** → **287 个窗口** |
| 模型推理（CPU） | **3.56 窗口/秒** | 测试机 GTX 1060 算力 6.1 不支持 cu128 → 强制 CPU |
| **合计** | **≈ 81 秒** | 小文件只有 1–2 个窗口 → 0.3–0.6 秒，所以"别的不会" |

**提速办法**（都不改引擎代码）：

| 手段 | 效果 | 代价 |
|---|---|---|
| 工具参数 `window_stride=510`，或插件配置 `windowStride: 510` | 窗口数 287→**约 145**，耗时约减半 | 窗口几乎不重叠，跨边界的长逻辑可能被切开（默认 256 有 254 token 重叠，判断优先） |
| `llmEnabled: false` | 灰区不再联网复核 | 灰区按本地 0.5 切分 |
| `llmDeliveryMode: truncate` + 小 `llmTruncateChars` | 大文件最多 1 次 LLM 调用（默认已是 truncate） | 送审内容更少 |
| 只审可疑的**单文件/片段** | 直接线性减少窗口 | 需要先定位 |
| 换算力 ≥ 7.5 的 GPU | 吞吐量级提升 | 硬件成本 |

> 面板会在拖入大文件时按**实测吞吐**预估耗时（例如 "预计 287 个滑窗，约 81 秒"）；
> `calibguard_status` 也会显示 `performance.windowsPerSecond` 与当前滑窗参数。
> 引擎侧的 `MAX_INPUT_BYTES`(1MB) / `MAX_TEXT_CHARS`(20 万) 是常量，本插件**不修改引擎**。

---

## 五、架构与协议

```
DSH (Node)                                  桥接进程 (Python, 常驻)
┌──────────────────────────┐   stdin/stdout  ┌────────────────────────────────┐
│ lib/index.js  apply()    │  行式 JSON 协议  │ bridge/calibguard_bridge.py    │
│  ├─ calibguard_audit ────┼────────────────►│  op=audit  → AuditPipeline     │
│  ├─ calibguard_status ───┼────────────────►│  op=status → 就绪快照           │
│  └─ ctx.provide(         │                 │  （模型只加载一次，单飞串行）    │
│       'calibguard')      │◄────────────────┤  CG_GUI/calibguard（未改动）    │
└──────────────────────────┘   一行一个 JSON  └────────────────────────────────┘
```

请求：`{"id":"cg-1","op":"audit","paths":[…],"options":{…}}`
响应：`{"id":"cg-1","ok":true,"result":{…}}` 或 `{"id":"cg-1","ok":false,"error":{"type","message"}}`

- **stdout 只走协议**，所有日志/进度一律 stderr（`torch` 的进度条不会污染 JSON 行）。
- 进程回收三条路径：fiber 卸载（`ctx.effect` 作用域）→ 空闲计时器 → 宿主退出时 stdin EOF。
- **不做 `unref`**：`unref` 会让「等待响应」的调用方失去事件源而提前退出（实测 `unsettled top-level await`）。

---

## 六、自检与排错

```powershell
node scripts/bridge-selftest.mjs                 # 只看引擎状态
node scripts/bridge-selftest.mjs <路径…>          # 状态 + 审计
node scripts/bridge-selftest.mjs --device cpu <路径>
node --test                                      # 全部测试（配置/清洗/工具/路由/客户端/端到端）
```

| 现象 | 原因 / 处理 |
|---|---|
| `找不到可用的 Python 解释器` | 设 `pythonPath`，或按 `CG_GUI/README.txt` 用 launcher 备好 `.venv` |
| `引擎目录不存在 / 找不到 calibguard 包` | `engineRoot` 必须指向 `CG_GUI`（含 `calibguard/` 与 `models/`） |
| 每份文件都 `manual_review` + `CUDA error: no kernel image` | 设备定档失效：确认 `device` 未被设成 `cuda` |
| 灰区全部转人工、`llm.status=api_error` | 没配凭据：属预期降级 → 设 `credentialRef`（推荐）或 `llmApiKey` / `gui-settings.json` |
| `凭据引用 X 未配置` 告警 | `credentialRef` 指向的引用在 DSH 凭据库里没有值；在 Models 页填 Key 或用 `llmApiKey` |
| 首次审计很久 | 正常：要加载 475MB 权重；之后走常驻进程 |
| **大文件（如 3MB 的 minimified 库）审计几十秒** | 正常：耗时 ≈ 窗口数 ÷ CPU 吞吐（见「四、4. 大文件为什么慢」）。默认口径判断优先；要提速可用工具参数 `window_stride=510` 或插件配置 `windowStride`，面板会预估耗时 |
| **侧边栏没有 CalibGuard 图标** | 客户端 bundle 在**宿主启动时**扫描：改完 `dsh.client`/`lib/client.js` 必须**重启 DSH**；另外确认 `package.json` 的 `name` 与 bundle `id` 一致 |
| **面板打开是空白 / 拖拽后报错** | 先看宿主日志里 `[calibguard]` 开头的 warning；路由是否注册可试 `GET /api/calibguard/status` |
| 面板提示 **`not found` / `Unexpected token ... is not valid JSON`** | 接口没有命中：多半是**宿主未重启**导致路由没注册（本插件已改为 `ctx.inject(['webServer'])` 等待服务就绪后注册，重启即好）。面板现在会把这类非 JSON 响应翻译成可读错误 |
| 面板提示 **401/403** | 浏览器会话未通过宿主鉴权：在 Harness 里重新登录/刷新页面 |
| 面板里改了参数但 AI 调用没变 | 需要点「保存为共享设置」；只改表单不点保存 = 仅影响面板本次「开始审计」 |
| **拖文件提示超限** | 单次请求体 32MB（base64 后）、解码后 24MB、最多 50 个文件；大目录请改用「粘宿主路径」 |
| 想临时关掉 UI | 从 `package.json` 删除 `dsh.client` 段（或删掉插件行）后重启；只关工具用 `config.enabled: false` |

审计报告默认落在 `CG_GUI/reports/`（与桌面壳一致，且已被仓库 `.gitignore` 忽略）。

## 七、面板与四档结论的对应

| 面板标签 | 含义 | 建议动作 |
|---|---|---|
| **BLOCK 拦截**（红） | 本地模型高置信恶意 | 不要执行；点「查看 Markdown 报告」看证据 |
| **SUSPICIOUS 可疑**（橙） | 灰区，云端复核判中等风险 | 找作者确认或补充上下文 |
| **MANUAL 转人工**（黄） | 灰区但复核不可用/失败 | 视为无结论，人工看 |
| **ALLOW 放行**（绿） | 未发现明显可疑信号 | 放行，但不是安全保证 |
