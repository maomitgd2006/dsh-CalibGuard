# 配置参考

本页是完整配置说明；README 里只列常用项。

## 一、插件行 `config` 全表

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则什么都不注册（临时停用不必删行） |
| `engineRoot` | `''` | 引擎目录；留空自动推导：**npm/桌面端安装**时为 `~/.dsh/calibguard-engine`，源码仓库里为本包同级 `CG_GUI` |
| `pythonPath` | `''` | Python 解释器；留空依次尝试 `<engineRoot>/.venv` → `DSH_CALIBGUARD_PYTHON` → PATH |
| `device` | `auto` | `auto` 做「CUDA 版本 + 算力」双检；`cpu` / `cuda` 为强制 |
| `useGuiSettings` | `true` | 复用 `CG_GUI/gui-settings.json`（与桌面壳共享阈值/云端配置） |
| `announceToModel` | `true` | 是否把「何时该用 CalibGuard」写进系统提示词 |
| `autoSetup` | `true` | 首次运行缺 `.venv` 时**自动**准备引擎（复制内置 `engine/` + 从 npm 镜像下载模型分片约 476 MB，缓存 `~/.dsh/calibguard-tools/model-cache`）、按需下载便携 Python 3.10.8、安装依赖（1–3 GB）；面板显示进度。设 `false` 则只报错并提示手动 `node setup.mjs` |
| `maxFiles` | `20` | **目录展开上限**（1–200）：只限制"给一个目录时递归展开多少个文件"；显式给出/上传的文件全部审计 |
| `pluginScanMode` | `'update'` | 其他 DSH 插件扫描频率：`off` / `update`（插件列表更新时）/ `weekly` / `monthly` / `quarterly` / `halfyearly` |
| `pluginScanMaxFiles` | `100` | 单个插件一次最多扫描的文件数（1–500） |
| `selfUpdateCheck` | `'startup'` | 本插件新版本检查频率：`off` / `startup` / `daily` / `weekly`（只提示，不静默升级） |
| `auditTimeoutMs` | `600000` | 单次审计超时（毫秒） |
| `idleShutdownMs` | `600000` | 空闲多久回收桥接进程（`0`=常驻不回收） |
| `reportDir` | `''` | 报告目录；留空=引擎默认 `<engineRoot>/reports` |
| `allowThreshold` / `blockThreshold` | 跟随引擎 | 灰区上下限（`0 < allow < block < 1`） |
| `llmEnabled` | 跟随引擎 | 云端复核开关（三态：不写=跟随；`true`/`false`=强制） |
| `llmBaseUrl` / `llmModel` | 跟随引擎 | OpenAI 兼容端点与模型名 |
| `llmContentSource` | 跟随引擎 | 送审内容源：`evidence`（精炼证据）/ `raw`（预处理后全文） |
| `llmDeliveryMode` | 跟随引擎 | 投递方式：`truncate` / `window` / `all` |
| `credentialRef` | `''` | **推荐**：凭据**名**（保存位置，不是密钥，如 `DEEPSEEK_API_KEY`），交给 `ctx.credentials.resolve()`。留空时用面板「凭据名」保存进共享设置的名字 |
| `llmApiKey` | `''` | 字面值 Key（不推荐，会落在配置文件里）；优先于 `credentialRef` |
| `sensitiveEnvPattern` | `''` | 桥接子进程环境清洗的兜底正则；留空=用 DSH 的实现或内置启发式 |
| `settingsPath` | `''` | GUI 与 AI 共用的设置文件；留空=`$DSH_HOME/calibguard-settings.json` |
| `windowStride` | 跟随引擎（256） | 模型侧全文滑窗步长（1~511）。**不在面板/共享设置里**，只走插件配置或工具参数；设 510 时窗口数约减半 |

> **GPU 定档**：安装器检测到 NVIDIA 且 CUDA ≥ 12.8、算力 ≥ 7.5 时自动装 CUDA（cu128）版 torch，
> 否则装 CPU 版。已经装成 CPU 版时：在插件目录运行 `node setup.mjs --reinstall-torch`。
> 手动覆盖：`--force-cuda` / `--cpu`（或环境变量）决定**安装哪个 build**（面板顶部也有「一键重装 GPU 版 torch」按钮，走 `POST /install-torch`）；插件配置 `device`
> （auto/cpu/cuda）决定**运行时用哪个设备**。CPU 版与 CUDA 版 torch 不能共存于同一个 venv
>（同名包互斥）；CUDA 版在无 GPU 时也能跑 CPU。

## 二、参数优先级

```
引擎默认值  <  插件配置（patch 行 config）  <  共享设置（面板保存的）  <  本次调用参数（工具参数 / 面板单次参数）
```

- **AI 工具调用**：自动叠加共享设置 → 面板保存的阈值/送审方式对 AI 同样生效；
- **面板「开始审计」**：把当前表单作为本次调用参数（最高层）；
- **面板「保存」**：写入共享设置层（两个壳都生效，且不用重启 DSH）。

## 三、云端复核的 Key 从哪来（不硬编码、不隐式继承）

1. `credentialRef`（推荐；插件配置或面板「凭据名」两者取其一，面板默认 `DEEPSEEK_API_KEY`）→
   `ctx.credentials.resolve(ref)`，优先级 **继承环境 > `~/.dsh/.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`**；
   解析到的值随请求走 **stdin** 下发，**不进 argv、不进子进程环境变量**，且每次操作重新解析（换 Key 下一次审计即生效）。
2. `llmApiKey`（字面值，次选）。
3. 同名环境变量（名字来自 `credentialRef`）；
4. 本地凭据回退文件 `$DSH_HOME/calibguard-credentials.json`（面板保存时若 DSH 版本不支持写凭据库，
   会自动写到这里；仅本机、权限 0600，值不落共享设置文件）；
5. `CG_GUI/gui-settings.json` 里的 `deepseek_api_key`（`useGuiSettings: true` 时生效）。

三者都没有 → 云端复核不可用、灰区转人工（安全降级）。桥接子进程**不会**去读宿主的
`DEEPSEEK_API_KEY`：它的环境已按 DSH 的 `scrubbedParentEnv` 清洗（`*KEY*` / `*PASSWORD*` /
`*SECRET*` / `*TOKEN*` 与全部 `DSH_*` 变量都不传）。

## 四、共享设置（面板 ↔ AI 打通）

| 项 | 说明 |
|---|---|
| 文件 | `$DSH_HOME/calibguard-settings.json`（默认 `~/.dsh`，**不写进仓库**；可用 `settingsPath` 覆盖） |
| 内容 | 云端复核开关、Base URL、模型名、送审内容、投递方式、截断/滑窗大小与重叠、灰区上下限、目录上限、**凭据名 `credentialRef`**、其他插件扫描选项（`pluginScanMode`/`pluginScanMaxFiles`）与自更新检查（`selfUpdateCheck`）（**不含密钥本身、不含模型侧步长**） |
| 写入 | 面板「保存」→ `PUT /api/calibguard/settings`；或让 AI 调 `calibguard_configure`（同一份设置，**不读写 API Key/凭据值**）；原子写，非法值不落盘（校验口径与 CG_GUI 一致） |
| 读取 | 面板加载时回填；AI 每次调用时由引擎合并，**改完立即生效、无需重启** |
| 重置 | 面板「重置」→ 清空为「跟随插件配置默认值」 |
| API Key | 面板「凭据名 + API Key」→ `PUT /api/calibguard/credential` → 值写入 DSH 凭据库（不落设置文件），名字记入共享设置 `credentialRef`（便于下次启动找到） |

## 五、环境变量

| 变量 | 作用 |
|---|---|
| `DSH_CALIBGUARD_PYTHON` | 指定桥接进程使用的 Python 解释器（优先于 `<engineRoot>/.venv`） |
| `DSH_CALIBGUARD_CPU_ONLY` | 设为 `1` 强制使用 CPU 版 torch（跳过 GPU 定档） |
| `DSH_CALIBGUARD_FORCE_CUDA` | 设为 `1` 强制安装 CUDA 版 torch（跳过 CUDA 版本/算力检查，风险自负） |
| `DSH_CALIBGUARD_DOWNLOAD_CONNECTIONS` | 大文件并发分段下载的连接数（默认 4；模型/引擎包下载提速） |
| `DSH_CALIBGUARD_TORCH_INDEX` | CUDA 版 torch 的安装索引（默认 `https://download.pytorch.org/whl/cu128`） |
| `DSH_CALIBGUARD_PIP_INDEX` | 指定 pip 主索引（默认依次尝试 清华 → 阿里 → 中科大 → 腾讯 → 官方） |
| `DSH_HOME` | DSH 主目录（默认 `~/.dsh`）；决定共享设置文件位置 |

## 六、宿主 HTTP 路由（浏览器面板使用）

| 方法与路径 | 作用 |
|---|---|
| `GET /api/calibguard/status` | 引擎状态 + 共享设置 + 凭据可写性 |
| `GET` / `PUT /api/calibguard/settings` | 读取 / 保存共享设置 |
| `PUT /api/calibguard/credential` | 把 API Key 写入 DSH 凭据库 |
| `POST /api/calibguard/audit` | 审计（JSON：`paths` 或 `files:[{name,base64}]` + `options`） |
| `GET /api/calibguard/report?name=<id>` | 读取 Markdown 报告 |

上传限制：单次请求体 32 MB（base64 后）、解码后 24 MB、最多 50 个文件。

