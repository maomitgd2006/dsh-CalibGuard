# engine/ —— 内置引擎核心（复制自 CG_GUI）

本目录是 [CalibGuard 主仓库 P-436/CalibGuard](https://github.com/P-436/CalibGuard) 的 `CG_GUI/` 里运行审计所需的**核心文件副本**，
让 `dsh-calibguard` 安装后不必再从 GitHub 下载 CG 发行包：

| 内容 | 说明 |
|---|---|
| `calibguard/` | 审计引擎 Python 包（未修改、原样复制） |
| `audit_service.py` | 桥接进程读取 GUI 设置时复用它的校验逻辑 |
| `requirements-gui.txt` | 依赖清单（安装到 `.venv`） |
| `models/calibration_params.json` | Platt 校准参数 |
| `models/codebert_finetuned/*` | 模型配置与分词器文件（**不含** `model.safetensors`） |

**模型权重（475 MB）不在本仓库的 Git 里**：它作为本仓库的 Release 资产分发
（`model-v1.0.0` 里的 `calibguard-model-1.0.0.zip`），首次运行时由 `setup.mjs` 下载、按 SHA-256
校验后释放为 `models/codebert_finetuned/model.safetensors`；已下载的会缓存在
`~/.dsh/calibguard-tools/model-cache`。

## 与 CG_GUI 同步

引擎代码更新时，把对应文件从 CG 的 `CG_GUI/` 重新复制过来即可（保持原样、不要改逻辑）：

```powershell
# 在 CG 仓库根目录下执行（把 DSH_CG 换成你本地插件仓库目录）
Copy-Item CG_GUI\calibguard\*.py <插件仓库>\engine\calibguard\ -Force
Copy-Item CG_GUI\audit_service.py, CG_GUI\requirements-gui.txt <插件仓库>\engine\ -Force
Copy-Item CG_GUI\models\calibration_params.json <插件仓库>\engine\models\ -Force
Copy-Item CG_GUI\models\codebert_finetuned\*.json, CG_GUI\models\codebert_finetuned\merges.txt, `
          CG_GUI\models\codebert_finetuned\vocab.json <插件仓库>\engine\models\codebert_finetuned\ -Force
```

如果模型权重本身变化，需要：① 重新压缩成 `calibguard-model-<版本>.zip` 发到本仓库 Release
（如 `model-v1.0.0`）；② 更新 `setup.mjs` 里的 `MODEL_URL` 与 `MODEL_SHA256`。
