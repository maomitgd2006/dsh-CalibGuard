# 排错

## 一、常见现象

| 现象 | 原因 / 处理 |
|---|---|
| `找不到可用的 Python 解释器` | 设 `pythonPath`，或按 CG 的 README 用 `CG_GUI/launcher.py` 备好 `.venv` |
| `引擎目录不存在 / 找不到 calibguard 包` | `engineRoot` 必须指向 `CG_GUI`（含 `calibguard/` 与 `models/`） |
| 每份文件都 `manual_review` + `CUDA error: no kernel image` | 设备定档失效：确认 `device` 未被强制成 `cuda` |
| 灰区全部转人工、`llm.status=api_error` | 没配凭据（预期降级）→ 设 `credentialRef`（推荐）或在 DSH Models 页配置 |
| `凭据引用 X 未配置` 告警 | `credentialRef` 指向的引用在 DSH 凭据库里没有值；在 Models 页填 Key 或用 `llmApiKey` |
| **首次运行卡在"正在准备环境"** | 正常：首次自动下载引擎（467 MB）+ 装依赖（1–3 GB），约 10–20 分钟；面板顶部有进度与输出尾巴 |
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
