# 排错

## 一、常见现象

| 现象 | 原因 / 处理 |
|---|---|
| `找不到可用的 Python 解释器` | 设 `pythonPath`，或按 CG 的 README 用 `CG_GUI/launcher.py` 备好 `.venv` |
| `引擎目录不存在 / 找不到 calibguard 包` | `engineRoot` 必须指向 `CG_GUI`（含 `calibguard/` 与 `models/`） |
| 每份文件都 `manual_review` + `CUDA error: no kernel image` | 设备定档失效：确认 `device` 未被强制成 `cuda` |
| 灰区全部转人工、`llm.status=api_error` | 没配凭据（预期降级）→ 设 `credentialRef`（推荐）或在 DSH Models 页配置 |
| `凭据引用 X 未配置` 告警 | `credentialRef` 指向的引用在 DSH 凭据库里没有值；在 Models 页填 Key 或用 `llmApiKey` |
| **提示"当前环境不支持写入 DSH 凭据库"** | ≥0.3.6 会自动回退到 `~/.dsh/calibguard-credentials.json`（0600，仅本机），面板会显示存储位置；清空即删该文件或到 DSH Models 页重新配置 |
| **面板保存 API Key 报「需要 credentialRef」** | 升级到 ≥0.3.3：面板「凭据名」直接填（如 `DEEPSEEK_API_KEY`）并保存，会记进共享设置；旧版本只能把 `credentialRef` 写进插件配置 |
| **审计结果在哪里 / 怎么清空** | 引擎 `reports/` 目录（默认 `<engineRoot>/reports`）：每次审计生成 JSON + Markdown；面板结果区显示路径并有「清空结果」，工具返回 `report_md_path` / `report_json_path` |
| **每次审计都提示"首次会加载模型"** | 0.3.3 起仅在模型未加载时提示；加载后不再出现，顶部状态显示「模型 已加载」 |
| **装了新插件没有收到扫描提醒** | 默认在插件列表变化后 1 分钟内检测并扫描；确认面板「其他 DSH 插件扫描」里"更新时自动扫描"未关闭，且引擎环境已就绪（首次装环境期间会跳过）。也可点「立即扫描全部」。结果在 `$DSH_HOME/calibguard-plugin-scan.json` |
| **不想扫描其他插件** | 面板底部「高级 / 其他设置」折叠区把频率设为「不扫描」；或在插件配置里设 `pluginScanMode: off` |
| **总提示 CalibGuard 有新版本 / 想关掉** | 顶部提示是「只提示不静默升级」；点「以后不再询问」即永久关闭，或「跳过此版本」只忽略当前版本；折叠区可改检查频率（`off`/`startup`/`daily`/`weekly`），也可点「立即检测」 |
| **有 NVIDIA 显卡但引擎显示 CPU** | 看面板「推理设备」的原因：算力 **≥7.5** 且显示 CPU → 装的是 CPU 版 torch，运行 `node setup.mjs --reinstall-torch`（约 2.5 GB）；算力 **<7.5**（如 GTX 1060 5GB / 6.1）→ **强制 CPU 是正常行为**，CPU 版 torch 已是最优，0.5.1 起面板不再提示重装（只会显示一行设备说明）。|
| **已经装了 CPU 版 torch，想换成 GPU 版** | 升级到 ≥0.3.5：面板顶部点「一键重装 GPU 版 torch（约 2.5 GB）」（先卸载再装，完成自动重启桥接）；或命令行 `node "<插件目录>/setup.mjs" --reinstall-torch --force-cuda` |
| **想强制装 GPU / CPU 版 torch** | 安装时加 `--force-cuda` / `--cpu`（可配合 `--reinstall-torch` 覆盖已装版本）；CPU 版与 CUDA 版不能共存于同一 venv，CUDA 版在无 GPU 时会自动回落 CPU |
| **首次安装特别慢 / 提示某个源不可用** | 模型默认 4 路并发分段下载（`DSH_CALIBGUARD_DOWNLOAD_CONNECTIONS` 可调），GitHub 失败自动换 gh-proxy/ghfast/ghproxy 镜像；pip 自动在 清华/阿里/中科大/腾讯/官方 之间回退。实在慢可手动下载 `calibguard-model-1.0.0.zip` 放到缓存目录（见下一条） |
| **模型下载失败 / 想离线** | 手动下载 `calibguard-model-1.0.0.zip`（Release `model-v1.0.0`），解压出 `model.safetensors` 放到 `~/.dsh/calibguard-tools/model-cache/model.safetensors`（或 `<engineRoot>/models/codebert_finetuned/`），重跑安装即会校验 SHA 并跳过下载 |
| **首次运行卡在"正在准备环境"** | 正常：首次下载模型（约 442 MB，自动镜像回退）+ 装依赖（1–3 GB），约 10–20 分钟；面板顶部有进度与输出尾巴。若长时间无进度，可看 `~/.dsh/calibguard-tools/model-cache` 是否在增长 |
| 环境准备失败 | 面板会显示失败原因与最后几行输出；在本插件目录跑 `node setup.mjs` 看完整输出后重试（也支持 `--from` 离线包） |
| **本机没有 Python** | 会自动用 uv 下载便携 Python 3.10.8（约 30 MB，缓存 `~/.dsh/calibguard-tools`）；若这一步失败会自动给出 python.org 下载链接，也可用 `--python` 指定解释器 |
| 大文件审计几十秒 | 正常：耗时 ≈ 窗口数 ÷ CPU 吞吐，见 [performance.md](performance.md) |
| **侧边栏没有 CalibGuard 图标** | 客户端 bundle 在**宿主启动时**扫描：改完 `dsh.client`/`lib/client.js` 必须**重启 DSH**；并确认 `package.json` 的 `name` 与 bundle `id` 一致 |
| **面板空白 / 拖拽后报错** | 先看宿主日志里 `[calibguard]` 开头的 warning；路由是否注册可试 `GET /api/calibguard/status` |
| 面板提示 **`not found`** 或 `Unexpected token ... is not valid JSON` | 接口未命中：多为**宿主未重启**导致路由没注册。插件用 `ctx.inject(['webServer'])` 等服务就绪再注册，重启即好；面板会把非 JSON 响应翻译成可读错误 |
| 面板提示 **401 / 403** | 浏览器会话未通过宿主鉴权：刷新页面/重新登录 |
| 面板改了参数但 AI 调用没变 | 需点「保存」写入共享设置；只改表单不保存 = 仅影响面板这一次 |
| 拖文件提示超限 | 单次上传上限 50 个文件（请求体 32 MB / 解码后 24 MB）；大目录请改用「粘贴宿主机路径」 |
| 结果提示「仅审计了前 N 个」 | 目录展开超过 `maxFiles`（默认 20）：调大上限或分批/给子目录 |
| 正规第三方库被判 BLOCK | 已知误报倾向：压缩库充满 `eval`/base64/长字符串，训练语料偏 Python 生态。可调高 `blockThreshold` 让它落入灰区交云端复核，或人工确认 |
| 想临时关掉 UI | 从 `package.json` 删除 `dsh.client` 段（或删插件行）后重启；只关工具用 `config.enabled: false` |

## 二、面板报错怎么读

| 提示 | 含义 |
|---|---|
| `接口未注册：插件路由没挂上，通常需要重启 DSH；HTTP 404 … "not found"` | 路由缺失（宿主启动时未注册成功）→ 重启 DSH |
| `鉴权失败：请在 Harness 里保持已登录` | 会话失效 → 刷新/重新登录 |
| `接口返回非 JSON（HTTP 500）` | 宿主侧异常 → 看日志里 `[calibguard]` 的报错 |
| `接口返回的 JSON 无法解析` | 响应体损坏（通常是代理/中间层）→ 重试或看日志 |
| `预计 N 个滑窗，约 X 秒` | 不是错误：大文件耗时预估，见 [performance.md](performance.md) |

## 三、自检命令

```powershell
node scripts/bridge-selftest.mjs                  # 引擎状态（不含模型推理）
node scripts/bridge-selftest.mjs <路径...>         # 状态 + 真审计
node --test                                       # 全量测试（缺引擎环境时自动 skip）
```

自检脚本会打印：引擎版本、Python/torch、设备定档理由、模型/校准是否存在、门控阈值、
云端复核是否配好、凭据来源、滑窗与实测吞吐。
