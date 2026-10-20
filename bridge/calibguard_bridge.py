#!/usr/bin/env python
"""DSH ↔ CalibGuard 桥接进程。

职责：让 DSH 插件以「子进程 + 行式 JSON 协议」的方式复用 **未改动的** CalibGuard 引擎
（`CG_GUI/calibguard`），从而避免在 Node 侧重写任何审计逻辑（沿用引擎铁律：
逐字复用 load_config + AuditPipeline）。

两种运行模式：
  --serve   常驻模式：stdin 每行一条 JSON 请求 → stdout 一行 JSON 响应；
            模型只在首个 audit 请求时加载一次，其后复用（等价 GUI 壳的流水线单例）。
  --once    一次性模式：读一条请求、写一条响应后退出（测试与手工排查用）。

协议（stdout 只写 JSON 行，任何日志/警告一律走 stderr，保证 stdout 可逐行解析）：
  请求  {"id": "<任意>", "op": "status"}
  请求  {"id": "<任意>", "op": "audit", "paths": ["..."], "options": {...}}
  响应  {"id": "<原样回填>", "ok": true,  "result": {...}}
  响应  {"id": "<原样回填>", "ok": false, "error": {"type": "...", "message": "..."}}

options（全部可选，缺省即用引擎/设置文件的值）：
  allowThreshold / blockThreshold / earlyStopThreshold   门控与早停阈值
  llmEnabled                                             是否启用云端 LLM 复核
  llmApiKey / llmBaseUrl / llmModel                      云端复核参数（Key 只走本进程内存）
  llmContentSource / llmDeliveryMode / llmTruncateChars / llmWindowChars / llmWindowOverlap
  reportDir                                              报告落盘目录
  maxFiles                                               目录展开上限（默认 20，封顶 200）
  includeEvidence                                        是否回传证据明细（默认 true）

配置来源优先级：引擎默认值 < CG_GUI/gui-settings.json（若存在，与 GUI 壳共享同一份设置）
                              < 请求 options。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback

# ============================== 全局状态 ==============================

_STATE = {
    "engine_root": None,
    "pipeline": None,
    "pipeline_key": None,      # 影响模型/校准参数的身份键；变化才重建流水线
    "settings": {},            # 来自 gui-settings.json 的 GUI 设置（可能为空）
    "settings_source": "engine-defaults",
    "settings_error": None,
    "loaded_at": None,
    "audit_count": 0,
    "device_policy": None,     # 见 _resolve_device_policy()
    "performance": None,       # 最近一次审计的实测吞吐：{windows, elapsedMs, windowsPerSecond}
}

# cu128 轮子包含的最低算力（sm_75）。低于此值的显卡（如 GTX 10 系 sm_61）在 GPU 上
# 没有可用 kernel，运行必然报 "CUDA error: no kernel image is available"，
# 而引擎会把它降级成「每份文件都转人工 + 报错」——看起来像成功，其实毫无判别力。
# 该阈值与 CG_GUI/launcher.py 的 CUDA_MIN_COMPUTE_CAP 保持一致。
CUDA_MIN_COMPUTE_CAP = (7, 5)

# 引擎 AppConfig 字段 ← GUI 设置键（与 audit_service._CFG_FIELDS 同构）
_SETTINGS_TO_CFG = {
    "llm_enabled": "llm_enabled",
    "deepseek_api_key": "llm_api_key",
    "llm_base_url": "llm_base_url",
    "llm_model": "llm_model",
    "allow_threshold": "allow_threshold",
    "block_threshold": "block_threshold",
    "llm_content_source": "llm_content_source",
    "llm_delivery_mode": "llm_delivery_mode",
    "llm_truncate_chars": "llm_truncate_chars",
    "llm_window_chars": "llm_window_chars",
    "llm_window_overlap": "llm_window_overlap",
}

# 请求 options 键 → AppConfig 字段（其中一部分可热改，见 _HOT_OPTION_FIELDS）
_OPTION_TO_CFG = {
    "allowThreshold": "allow_threshold",
    "blockThreshold": "block_threshold",
    "earlyStopThreshold": "early_stop_threshold",
    "llmEnabled": "llm_enabled",
    "llmApiKey": "llm_api_key",
    "llmBaseUrl": "llm_base_url",
    "llmModel": "llm_model",
    "llmContentSource": "llm_content_source",
    "llmDeliveryMode": "llm_delivery_mode",
    "llmTruncateChars": "llm_truncate_chars",
    "llmWindowChars": "llm_window_chars",
    "llmWindowOverlap": "llm_window_overlap",
    # 模型侧全文滑窗步长（影响窗口数 = 推理耗时）：256 默认；512 约减半但无重叠
    "windowStride": "window_stride",
}

# 影响模型权重/校准参数的身份键：任一变化必须重建流水线（重新加载模型）
_PIPELINE_IDENTITY_OPTIONS = ("modelPath", "calibrationParamsPath", "maxLength",
                              "windowStride", "windowBatchSize")

_DEFAULT_MAX_FILES = 20
_HARD_MAX_FILES = 200


def _default_engine_root() -> str:
    """默认引擎目录：<DSH_CG 的父目录>/CG_GUI（两个子项目在仓库里平级）。"""
    dsh_cg = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(os.path.dirname(dsh_cg), "CG_GUI")


def _log(message: str) -> None:
    """诊断日志一律写 stderr，绝不污染 stdout 的 JSON 行。"""
    print(f"[calibguard-bridge] {message}", file=sys.stderr, flush=True)


# ============================== 设备定档（必须在 import torch 之前完成） ==============================

def _nvidia_smi_gpu() -> tuple:
    """返回 (显卡名, 算力元组或 None)；无独显/命令缺失/解析失败都返回 (None, None)。"""
    if shutil.which("nvidia-smi") is None:
        return None, None
    try:
        proc = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        _log(f"nvidia-smi 探测失败：{type(exc).__name__}: {exc}")
        return None, None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None, None
    line = proc.stdout.strip().splitlines()[0]
    parts = [item.strip() for item in line.split(",")]
    name = parts[0] or None
    cap = None
    if len(parts) > 1 and parts[1]:
        try:
            major, minor = parts[1].split(".")
            cap = (int(major), int(minor))
        except ValueError:
            cap = None
    return name, cap


def _cuda_canary() -> tuple:
    """在**子进程**里做一次最小 CUDA 内核自检（子进程失败不污染本进程 CUDA 状态）。

    仅当 nvidia-smi 给不出算力时才需要；返回 (是否可用, 说明)。
    """
    code = ("import torch;"
            "x=torch.ones(8,device='cuda');"
            "print('CANARY_OK', float(x.sum().item()))")
    try:
        proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=300)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"canary 子进程失败：{type(exc).__name__}: {exc}"
    if "CANARY_OK" in (proc.stdout or ""):
        return True, "canary 通过"
    tail = ((proc.stderr or proc.stdout or "").strip().splitlines() or [""])[-1]
    return False, f"canary 失败：{tail[:160]}"


def _resolve_device_policy(requested: str) -> dict:
    """定档本进程用 GPU 还是 CPU，并在需要时强制 CPU。

    手段：置 CUDA_VISIBLE_DEVICES=-1，让 `torch.cuda.is_available()` 返回 False，
    引擎（CodeBERTClassifier 内部自己挑设备）就会自然落到 CPU —— **不需要改引擎一行代码**。
    必须在任何 CUDA 调用之前执行：CUDA 设备数在首次 CUDA 调用后即被缓存。

    注意：实测 torch 2.11.0+cu128 下 `CUDA_VISIBLE_DEVICES=""`（空串）会被当作「未设置」，
    is_available 仍为 True；只有 `-1` 才能真正隐藏设备。这里用 -1。
    """
    previous = os.environ.get("CUDA_VISIBLE_DEVICES")
    policy = {"requested": requested, "mode": "cpu", "gpuName": None,
              "computeCap": None, "reason": ""}

    if requested == "cpu":
        policy["reason"] = "显式指定 CPU"
    elif requested == "cuda":
        policy["mode"] = "cuda"
        policy["reason"] = "显式指定 CUDA（不做算力校验，风险自负）"
    else:                                            # auto：与 GUI 启动器同款双检
        name, cap = _nvidia_smi_gpu()
        policy["gpuName"], policy["computeCap"] = name, cap
        if name is None:
            policy["reason"] = "未检测到 NVIDIA 显卡（或 nvidia-smi 不可用）"
        elif cap is None:
            ok, detail = _cuda_canary()
            policy["mode"] = "cuda" if ok else "cpu"
            policy["canary"] = detail
            policy["reason"] = f"算力未知，改用内核自检：{detail}"
        elif cap >= CUDA_MIN_COMPUTE_CAP:
            policy["mode"] = "cuda"
            policy["reason"] = f"算力 {cap[0]}.{cap[1]} ≥ {CUDA_MIN_COMPUTE_CAP[0]}.{CUDA_MIN_COMPUTE_CAP[1]}"
        else:
            policy["reason"] = (f"算力 {cap[0]}.{cap[1]} 低于 cu128 轮子最低要求 "
                               f"{CUDA_MIN_COMPUTE_CAP[0]}.{CUDA_MIN_COMPUTE_CAP[1]}"
                               f"（{name}）：GPU 上无可用 kernel，强制 CPU")

    if policy["mode"] == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
        policy["env"] = "CUDA_VISIBLE_DEVICES=-1"
    elif previous is not None:                        # 复原用户原有取值，不做静默改写
        os.environ["CUDA_VISIBLE_DEVICES"] = previous
        policy["env"] = f"CUDA_VISIBLE_DEVICES={previous}"
    else:
        policy["env"] = "CUDA_VISIBLE_DEVICES 未设置"
    _STATE["device_policy"] = policy
    _log(f"设备定档：{policy['mode']}（{policy['reason']}）")
    return policy


# ============================== 引导：把引擎挂上 sys.path ==============================

def _bootstrap(engine_root: str) -> None:
    """把 engine_root 插入 sys.path 并 chdir 过去（引擎的相对路径按项目根解析）。"""
    engine_root = os.path.abspath(engine_root)
    if not os.path.isdir(engine_root):
        raise RuntimeError(f"引擎目录不存在: {engine_root}")
    if not os.path.isdir(os.path.join(engine_root, "calibguard")):
        raise RuntimeError(f"引擎目录下找不到 calibguard 包: {engine_root}")
    if engine_root not in sys.path:
        sys.path.insert(0, engine_root)
    os.chdir(engine_root)
    _STATE["engine_root"] = engine_root


def _load_gui_settings() -> dict:
    """读取 GUI 壳的 gui-settings.json（复用 audit_service 的校验逻辑）。

    文件不存在时返回空 dict（= 完全采用引擎默认值，不引入第二套默认值）；
    读取失败不致命：记下原因后退化为引擎默认值（宁可少配置，不可不出审计）。
    """
    try:
        import audit_service  # 位于 engine_root，只依赖 calibguard + 标准库
        if not os.path.isfile(audit_service.SETTINGS_PATH):
            _STATE["settings_source"] = "engine-defaults"
            _log("未发现 gui-settings.json，按引擎默认值运行")
            return {}
        audit_service.load_settings()
        _STATE["settings_source"] = "gui-settings.json"
        return dict(audit_service.get_settings())
    except Exception as exc:  # noqa: BLE001 - 设置文件缺失/损坏都不应阻断审计
        _STATE["settings_error"] = f"{type(exc).__name__}: {exc}"
        _STATE["settings_source"] = "engine-defaults"
        _log(f"未加载 gui-settings.json（按引擎默认值运行）：{_STATE['settings_error']}")
        return {}


# ============================== 流水线构建 ==============================

def _apply_options_to_cfg(cfg, options: dict) -> None:
    """把请求 options 覆盖到 AppConfig（缺失键不动）。"""
    for key, field in _OPTION_TO_CFG.items():
        if key in options and options[key] is not None:
            setattr(cfg, field, options[key])
    if options.get("modelPath"):
        cfg.model_path = str(options["modelPath"])
    if options.get("calibrationParamsPath") is not None:
        cfg.calibration_params_path = str(options["calibrationParamsPath"])
    if options.get("reportDir"):
        cfg.report_output_dir = str(options["reportDir"])


def _build_cfg(options: dict):
    """组装 AppConfig：引擎默认值 < gui-settings.json < 请求 options。"""
    from calibguard.config import load_config, validate_config

    cfg = load_config(None)                       # 不传 yaml：GUI 侧同款，铁律 7
    settings = _STATE["settings"]
    for key, field in _SETTINGS_TO_CFG.items():
        if key in settings:
            setattr(cfg, field, settings[key])
    _apply_options_to_cfg(cfg, options)
    error = validate_config(cfg)
    if error:
        raise ValueError(f"配置非法：{error}")
    return cfg


def _pipeline_identity(options: dict) -> tuple:
    """流水线身份键：只有这些选项变化才需要重新加载模型。"""
    return tuple(str(options.get(key, "")) for key in _PIPELINE_IDENTITY_OPTIONS)


# 影响云端复核客户端构造的字段：任一变化就重建 pipeline.llm（与 GUI 壳
# audit_service._apply_settings_locked 的「只重建 LLM 客户端、不重载模型」同款做法）。
_LLM_SIGNATURE_FIELDS = (
    "llm_api_key", "llm_base_url", "llm_model", "llm_temperature",
    "llm_max_tokens", "llm_timeout", "evidence_max_chars",
)


def _llm_signature(cfg) -> tuple:
    return tuple(getattr(cfg, field, None) for field in _LLM_SIGNATURE_FIELDS)


def _sync_llm_client(pipeline) -> None:
    """LLM 相关配置变化时热重建复核客户端（Key 轮换即时生效，不重载模型）。"""
    signature = _llm_signature(pipeline.cfg)
    if _STATE.get("llm_signature") == signature:
        return
    from calibguard.llm_analyzer import LLMAnalyzer

    cfg = pipeline.cfg
    pipeline.llm = LLMAnalyzer(
        api_key=cfg.llm_api_key, base_url=cfg.llm_base_url, model=cfg.llm_model,
        temperature=cfg.llm_temperature, max_tokens=cfg.llm_max_tokens,
        timeout=cfg.llm_timeout, evidence_max_chars=cfg.evidence_max_chars)
    _STATE["llm_signature"] = signature


def _get_pipeline(options: dict):
    """流水线单例：模型只加载一次；身份键变化时重建，其余选项热改。"""
    from calibguard.pipeline import AuditPipeline

    identity = _pipeline_identity(options)
    pipeline = _STATE["pipeline"]
    if pipeline is not None and identity == _STATE["pipeline_key"]:
        _apply_options_to_cfg(pipeline.cfg, options)      # 阈值/LLM 参数热改
        error = _validate(pipeline.cfg)
        if error:
            raise ValueError(f"配置非法：{error}")
        _sync_llm_client(pipeline)
        return pipeline

    cfg = _build_cfg(options)
    started = time.time()
    pipeline = AuditPipeline(cfg)
    _STATE["pipeline"] = pipeline
    _STATE["pipeline_key"] = identity
    _STATE["llm_signature"] = _llm_signature(cfg)
    _STATE["loaded_at"] = time.time()
    _log(f"引擎流水线就绪（{time.time() - started:.1f}s，device={pipeline.classifier.device}）")
    return pipeline


def _validate(cfg):
    from calibguard.config import validate_config
    return validate_config(cfg)


# ============================== op: status ==============================

def _op_status(options: dict | None = None) -> dict:
    """引擎可用性快照。不加载模型（除非此前已被 audit 加载过）。

    options 与 audit 同构：因此「本次请求下发的凭据是否生效」能被如实反映
    （configured 为 True 表示云端复核可用，而不只是引擎默认配置）。
    """
    options = options or {}
    root = _STATE["engine_root"]
    model_path = os.path.join(root, "models", "codebert_finetuned")
    model_file = os.path.join(model_path, "model.safetensors")
    calib_file = os.path.join(root, "models", "calibration_params.json")

    calib = None
    if os.path.isfile(calib_file):
        try:
            with open(calib_file, "r", encoding="utf-8") as handle:
                calib = json.load(handle)
        except Exception as exc:  # noqa: BLE001
            calib = {"error": f"{type(exc).__name__}: {exc}"}

    device = "cpu"
    torch_version = None
    cuda_available = False
    try:
        import torch
        torch_version = torch.__version__
        cuda_available = bool(torch.cuda.is_available())
        device = "cuda" if cuda_available else "cpu"
    except Exception as exc:  # noqa: BLE001 - torch 缺失时仍要能自报状态
        torch_version = f"unavailable: {type(exc).__name__}"

    pipeline = _STATE["pipeline"]
    cfg = pipeline.cfg if pipeline is not None else _build_cfg(options)
    policy = _STATE["device_policy"] or {}
    return {
        "engineRoot": root,
        "engineVersion": _engine_version(),
        "python": sys.version.split()[0],
        "torch": torch_version,
        "cudaAvailable": cuda_available,
        "device": getattr(getattr(pipeline, "classifier", None), "device", device),
        "devicePolicy": policy,
        "modelDir": model_path,
        "modelPresent": os.path.isfile(model_file),
        "modelBytes": os.path.getsize(model_file) if os.path.isfile(model_file) else 0,
        "calibration": calib,
        "calibrationPresent": os.path.isfile(calib_file),
        "settingsSource": _STATE["settings_source"],
        "settingsError": _STATE["settings_error"],
        "loaded": pipeline is not None,
        "loadedAt": _STATE["loaded_at"],
        "auditCount": _STATE["audit_count"],
        "gate": {
            "allowThreshold": cfg.allow_threshold,
            "blockThreshold": cfg.block_threshold,
            "earlyStopThreshold": cfg.early_stop_threshold,
        },
        "llm": {
            "enabled": bool(cfg.llm_enabled),
            "configured": bool(getattr(cfg, "llm_api_key", "")),
            "baseUrl": cfg.llm_base_url,
            "model": cfg.llm_model,
            "contentSource": cfg.llm_content_source,
            "deliveryMode": cfg.llm_delivery_mode,
            "truncateChars": int(cfg.llm_truncate_chars),
            "windowChars": int(cfg.llm_window_chars),
            "windowOverlap": int(cfg.llm_window_overlap),
        },
        # 推理成本相关：窗口步长与最近一次实测吞吐（面板据此预估大文件耗时）
        "performance": _STATE["performance"] or {
            "windowsPerSecond": None,
            "lastAuditWindows": None,
            "lastAuditElapsedMs": None,
            "windowStride": int(cfg.window_stride),
            "windowBatchSize": int(cfg.window_batch_size),
            "maxLength": int(cfg.max_length),
        },
        "reportDir": os.path.abspath(cfg.report_output_dir),
    }


def _engine_version() -> str:
    try:
        from calibguard import __version__
        return str(__version__)
    except Exception:  # noqa: BLE001
        return "unknown"


# ============================== op: audit ==============================

def _expand_paths(pipeline, paths: list, max_files: int) -> tuple:
    """把入参路径展开为待审计文件列表；(文件列表, 截断标记)。

    语义与面板标签「目录文件上限」严格一致：
      - **显式给出的文件**（含面板上传的文件）：全部审计，不受上限影响；
      - **目录**：递归展开，所有目录合计最多 `max_files` 个文件，超出即截断并标记
        （truncated=True，前端/工具会明确提示"仅审计了前 N 个"）。

    这样"我自己选中的 30 个文件"不会因为默认上限 20 被悄悄砍掉——上限只用来
    防止误传一个大目录（node_modules、素材包）导致审计时间失控。
    """
    explicit: list = []
    directories: list = []
    for path in paths:
        if os.path.isfile(path):
            explicit.append(path)
        elif os.path.isdir(path):
            directories.append(path)
        else:
            raise FileNotFoundError(f"路径不存在: {path}")

    collected: list = []
    truncated = False
    for directory in directories:
        if len(collected) >= max_files:
            truncated = True
            break
        for found in pipeline._collect_files(directory):   # 引擎同款递归收集（按路径排序、跳过输出目录）
            if len(collected) >= max_files:
                truncated = True
                break
            collected.append(found)
    return explicit + collected, truncated


def _trim_report(report: dict, include_evidence: bool) -> dict:
    """报告瘦身：去掉报告编号类噪声，保留决策所需全部字段。"""
    trimmed = {
        "file_path": report.get("file_path"),
        "file_size_bytes": report.get("file_size_bytes"),
        "file_sha256": (report.get("file_sha256") or "")[:16],
        "source_type": report.get("source_type"),
        "archive_parts": report.get("archive_parts"),
        "raw_logit": report.get("raw_logit"),
        "calibrated_probability": report.get("calibrated_probability"),
        "gate_decision": report.get("gate_decision"),
        "final_decision": report.get("final_decision"),
        "manual_review_required": report.get("manual_review_required"),
        "consistency_warning": report.get("consistency_warning"),
        "windows_evaluated": report.get("windows_evaluated"),
        "early_stopped": report.get("early_stopped"),
        "llm": report.get("llm"),
        "llm_calls": report.get("llm_calls"),
        "error": report.get("error"),
        "report_json_path": report.get("report_json_path"),
        "report_md_path": report.get("report_md_path"),
    }
    if include_evidence:
        trimmed["evidence"] = report.get("evidence")
    return trimmed


def _op_audit(paths: list, options: dict) -> dict:
    """审计一批路径：逐文件调用引擎，汇总四档决策计数。"""
    if not isinstance(paths, list) or not paths:
        raise ValueError("paths 必须是非空数组")

    max_files = int(options.get("maxFiles") or _DEFAULT_MAX_FILES)
    max_files = max(1, min(max_files, _HARD_MAX_FILES))
    include_evidence = bool(options.get("includeEvidence", True))

    pipeline = _get_pipeline(options)
    files, truncated = _expand_paths(pipeline, [str(p) for p in paths], max_files)

    started = time.time()
    results = []
    for path in files:
        results.append(_trim_report(pipeline.audit_file(path), include_evidence))
    elapsed_ms = int((time.time() - started) * 1000)
    _STATE["audit_count"] += len(files)

    summary = {"total": len(results), "allow": 0, "block": 0,
               "suspicious": 0, "manual_review": 0, "error": 0}
    for item in results:
        if item.get("error"):
            summary["error"] += 1
        decision = item.get("final_decision")
        if decision in summary:
            summary[decision] += 1

    # 实测吞吐：窗口数 / 有效推理耗时（用于面板预估大文件耗时）
    total_windows = sum(int(item.get("windows_evaluated") or 0) for item in results)
    if total_windows > 0 and elapsed_ms > 0:
        _STATE["performance"] = {
            "windowsPerSecond": round(total_windows / (elapsed_ms / 1000.0), 2),
            "lastAuditWindows": total_windows,
            "lastAuditElapsedMs": elapsed_ms,
            "windowStride": int(pipeline.cfg.window_stride),
            "windowBatchSize": int(pipeline.cfg.window_batch_size),
            "maxLength": int(pipeline.cfg.max_length),
        }

    return {
        "summary": summary,
        "elapsedMs": elapsed_ms,
        "truncated": truncated,
        "maxFiles": max_files,
        "config": {
            "allowThreshold": pipeline.cfg.allow_threshold,
            "blockThreshold": pipeline.cfg.block_threshold,
            "llmEnabled": bool(pipeline.cfg.llm_enabled),
            "llmContentSource": pipeline.cfg.llm_content_source,
            "llmDeliveryMode": pipeline.cfg.llm_delivery_mode,
            "llmTruncateChars": pipeline.cfg.llm_truncate_chars,
            "llmWindowChars": pipeline.cfg.llm_window_chars,
            "llmWindowOverlap": pipeline.cfg.llm_window_overlap,
            "windowStride": int(pipeline.cfg.window_stride),
            "reportDir": os.path.abspath(pipeline.cfg.report_output_dir),
        },
        "results": results,
    }


# ============================== 请求分发 ==============================

def _handle(request: dict) -> dict:
    """分发一条请求，返回响应对象（异常一律转结构化错误）。"""
    request_id = request.get("id")
    try:
        op = request.get("op")
        if op == "status":
            options = request.get("options") or {}
            if not isinstance(options, dict):
                raise ValueError("options 必须是 JSON 对象")
            return {"id": request_id, "ok": True, "result": _op_status(options)}
        if op == "audit":
            options = request.get("options") or {}
            if not isinstance(options, dict):
                raise ValueError("options 必须是 JSON 对象")
            return {"id": request_id, "ok": True,
                    "result": _op_audit(request.get("paths") or [], options)}
        if op == "ping":
            return {"id": request_id, "ok": True, "result": {"pong": True}}
        raise ValueError(f"未知 op: {op!r}（支持 status / audit / ping）")
    except Exception as exc:  # noqa: BLE001 - 桥接层必须把错误变成数据，而不是崩溃
        _log(f"请求失败：{type(exc).__name__}: {exc}")
        _log(traceback.format_exc())
        return {"id": request_id, "ok": False,
                "error": {"type": type(exc).__name__, "message": str(exc)}}


def _emit(payload: dict) -> None:
    """写一行 JSON 响应到 stdout（ensure_ascii=False 保证中文可读）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(prog="calibguard_bridge.py",
                                     description="DSH ↔ CalibGuard 引擎桥接进程")
    parser.add_argument("--engine-root", default=_default_engine_root(),
                        help="CalibGuard 引擎所在目录（默认推导为同级 CG_GUI）")
    parser.add_argument("--serve", action="store_true", help="常驻模式（行式 JSON 协议）")
    parser.add_argument("--once", action="store_true", help="读一条请求后退出")
    parser.add_argument("--no-settings", action="store_true",
                        help="忽略 gui-settings.json，只用引擎默认值")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto",
                        help="设备定档：auto=按算力双检（默认，低算力显卡强制 CPU）/ cpu / cuda")
    parser.add_argument("--selftest", action="store_true",
                        help="不读 stdin，直接输出 status 后退出（部署自检用）")
    args = parser.parse_args()

    # 设备定档必须最先执行：置空 CUDA_VISIBLE_DEVICES 只有在首次 CUDA 调用前才有效
    _resolve_device_policy(args.device)

    try:
        _bootstrap(args.engine_root)
    except Exception as exc:  # noqa: BLE001
        _emit({"id": None, "ok": False,
               "error": {"type": type(exc).__name__, "message": str(exc)}})
        return 2

    if not args.no_settings:
        _STATE["settings"] = _load_gui_settings()

    if args.selftest:
        _emit(_handle({"id": "selftest", "op": "status"}))
        return 0

    if args.once:
        line = sys.stdin.readline()
        if not line.strip():
            _emit({"id": None, "ok": False,
                   "error": {"type": "ValueError", "message": "stdin 无请求"}})
            return 2
        _emit(_handle(json.loads(line)))
        return 0

    if not args.serve:
        parser.error("必须指定 --serve / --once / --selftest 之一")

    _log(f"常驻模式启动（engine_root={_STATE['engine_root']}）")
    for line in sys.stdin:                       # 行式协议：一行一个请求
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            _emit({"id": None, "ok": False,
                   "error": {"type": "ValueError", "message": f"请求不是合法 JSON: {exc}"}})
            continue
        if isinstance(request, dict) and request.get("op") == "shutdown":
            _emit({"id": request.get("id"), "ok": True, "result": {"bye": True}})
            break
        _emit(_handle(request))
    _log("常驻模式退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
