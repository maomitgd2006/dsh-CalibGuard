/**
 * 面向模型的两个工具：calibguard_audit 与 calibguard_status。
 *
 * 只依赖 `defineTool`（可注入，缺省退化为恒等函数），因此本文件能在没有 DSH
 * node_modules 的环境里直接跑单测。工具返回的值会被 DSH 按 output.schema 严格校验，
 * 所以这里的 schema 与 bridge 的 _trim_report 字段一一对应（多字段=校验失败，缺字段=校验失败）。
 */
import { isAbsolute, resolve } from 'node:path'

/** 单文件审计结果的 schema（字段与 bridge/calibguard_bridge.py::_trim_report 对齐）。 */
const RESULT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file_path: { type: 'string', required: true, description: '被审计文件的绝对路径' },
    file_size_bytes: { type: 'integer', required: true },
    file_sha256: { type: 'string', required: true, description: '文件 SHA256 前 16 位' },
    source_type: { type: 'string', required: true, description: 'text | archive | binary' },
    archive_parts: { type: 'integer', required: true, description: '压缩包内部文件数，非压缩包为 1' },
    raw_logit: { type: 'number', required: true, description: 'CodeBERT 原始 logit（max 聚合）' },
    calibrated_probability: { type: 'number', required: true, description: 'Platt 校准后的恶意概率' },
    gate_decision: { type: 'string', required: true, description: 'allow | block | llm_review' },
    final_decision: { type: 'string', required: true, description: 'allow | suspicious | block | manual_review' },
    manual_review_required: { type: 'boolean', required: true },
    consistency_warning: { type: 'boolean', required: true },
    windows_evaluated: { type: 'integer', required: true, description: '实际推理的滑窗数' },
    early_stopped: { type: 'boolean', required: true },
    llm_calls: { type: 'integer', required: true },
    llm: { type: 'json', description: '云端复核结果（status/risk/reason/action/retries_used），未提交时为 null' },
    evidence: { type: 'json', description: '结构化证据明细（八类信号）' },
    report_json_path: { type: 'string', required: true },
    report_md_path: { type: 'string', required: true },
    error: { type: 'json', description: '处理异常文本；正常时为 null' },
  },
}

/** 审计工具的完整输出 schema。 */
const AUDIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        total: { type: 'integer', required: true },
        allow: { type: 'integer', required: true },
        block: { type: 'integer', required: true },
        suspicious: { type: 'integer', required: true },
        manual_review: { type: 'integer', required: true },
        error: { type: 'integer', required: true },
      },
    },
    elapsedMs: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true, description: '是否因 maxFiles 上限截断了文件列表' },
    maxFiles: { type: 'integer', required: true },
    config: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        allowThreshold: { type: 'number', required: true },
        blockThreshold: { type: 'number', required: true },
        llmEnabled: { type: 'boolean', required: true },
        llmContentSource: { type: 'string', required: true, description: 'evidence | raw' },
        llmDeliveryMode: { type: 'string', required: true, description: 'truncate | window | all' },
        llmTruncateChars: { type: 'integer', required: true },
        llmWindowChars: { type: 'integer', required: true },
        llmWindowOverlap: { type: 'integer', required: true },
        windowStride: { type: 'integer', required: true },
        reportDir: { type: 'string', required: true },
      },
    },
    results: { type: 'array', required: true, items: RESULT_ITEM_SCHEMA },
  },
}

/** 引擎状态输出 schema（字段必须与 bridge 的 _op_status 完全一致：多一个少一个都会被 DSH 拒收）。 */
const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    engineRoot: { type: 'string', required: true },
    engineVersion: { type: 'string', required: true },
    python: { type: 'string', required: true },
    torch: { type: 'string', required: true },
    cudaAvailable: { type: 'boolean', required: true },
    device: { type: 'string', required: true, description: '实际推理设备：cpu | cuda' },
    devicePolicy: { type: 'json', description: '设备定档依据（算力双检结果）' },
    modelDir: { type: 'string', required: true },
    modelPresent: { type: 'boolean', required: true },
    modelBytes: { type: 'integer', required: true },
    calibrationPresent: { type: 'boolean', required: true },
    calibration: { type: 'json' },
    settingsSource: { type: 'string', required: true, description: 'engine-defaults | gui-settings.json' },
    settingsError: { type: 'json' },
    loaded: { type: 'boolean', required: true, description: '桥接进程内模型是否已加载' },
    loadedAt: { type: 'json', description: '模型加载完成的时间戳（epoch 秒），未加载为 null' },
    auditCount: { type: 'integer', required: true },
    gate: { type: 'json', required: true },
    llm: { type: 'json', required: true },
    performance: { type: 'json', required: true, description: '实测吞吐与滑窗参数（预估大文件耗时用）' },
    reportDir: { type: 'string', required: true },
  },
}

/** 云端复核内容源与投递模式（与引擎封闭集合一致）。 */
const CONTENT_SOURCES = ['evidence', 'raw']
const DELIVERY_MODES = ['truncate', 'window', 'all']

/**
 * 校验调用级 options（工具参数与 UI HTTP 路由共用同一份规则）。
 *
 * 只做「单项合法性 + 成对关系」校验；跨来源合并后的最终配置仍由引擎侧
 * `validate_config` 兜底（例如只覆盖了 allow 而 block 来自插件配置时）。
 *
 * @param {object} options 桥接 options
 */
export function validateAuditOptions(options) {
  const { allowThreshold, blockThreshold } = options
  for (const [key, value] of [['allow_threshold', allowThreshold], ['block_threshold', blockThreshold]]) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`${key} 必须是 (0,1) 之间的数字，当前 ${String(value)}`)
    }
  }
  if (allowThreshold !== undefined && blockThreshold !== undefined && !(allowThreshold < blockThreshold)) {
    throw new Error(`阈值必须满足 0 < allow_threshold(${allowThreshold}) < block_threshold(${blockThreshold}) < 1`)
  }
  if (options.llmEnabled !== undefined && typeof options.llmEnabled !== 'boolean') {
    throw new Error(`llm_enabled 必须是布尔值，当前 ${typeof options.llmEnabled}`)
  }
  if (options.llmContentSource !== undefined && !CONTENT_SOURCES.includes(options.llmContentSource)) {
    throw new Error(`llm_content_source 必须是 ${CONTENT_SOURCES.join(' / ')} 之一`)
  }
  if (options.llmDeliveryMode !== undefined && !DELIVERY_MODES.includes(options.llmDeliveryMode)) {
    throw new Error(`llm_delivery_mode 必须是 ${DELIVERY_MODES.join(' / ')} 之一`)
  }
  for (const [key, value] of [['truncate_chars', options.llmTruncateChars],
    ['window_chars', options.llmWindowChars]]) {
    if (value === undefined) continue
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} 必须是 ≥1 的整数，当前 ${String(value)}`)
  }
  if (options.llmWindowOverlap !== undefined) {
    const overlap = options.llmWindowOverlap
    if (!Number.isInteger(overlap) || overlap < 0) {
      throw new Error(`window_overlap 必须是 ≥0 的整数，当前 ${String(overlap)}`)
    }
    if (options.llmWindowChars !== undefined && !(overlap < options.llmWindowChars)) {
      throw new Error(`window_overlap 必须小于 window_chars（当前 ${overlap} ≥ ${options.llmWindowChars}）`)
    }
  }
  if (options.windowStride !== undefined) {
    const stride = options.windowStride
    if (!Number.isInteger(stride) || stride < 1 || stride > 511) {
      throw new Error(`window_stride 必须是 1~511 的整数，当前 ${String(stride)}`)
    }
  }
  for (const [key, value] of [['llmBaseUrl', options.llmBaseUrl], ['llmModel', options.llmModel]]) {
    if (value === undefined) continue
    if (typeof value !== 'string') throw new Error(`${key} 必须是字符串，当前 ${typeof value}`)
  }
  if (options.llmEnabled === true) {
    // 与 CG_GUI 的前端校验一致：启用云端复核时端点与模型名不能为空
    if (options.llmBaseUrl !== undefined && options.llmBaseUrl.trim() === '') {
      throw new Error('启用云端复核时 Base URL 不能为空')
    }
    if (options.llmModel !== undefined && options.llmModel.trim() === '') {
      throw new Error('启用云端复核时模型名称不能为空')
    }
  }
}

/** 决策的人类可读标签与排序权重（越靠前越需要关注）。 */
const DECISION_LABEL = {
  block: 'BLOCK 拦截',
  manual_review: 'MANUAL 转人工',
  suspicious: 'SUSPICIOUS 可疑',
  allow: 'ALLOW 放行',
}
const DECISION_ORDER = ['block', 'manual_review', 'suspicious', 'allow']

/** 把证据 dict 压成一行摘要（只保留非空类别）。 */
function evidenceLine(evidence) {
  if (!evidence || typeof evidence !== 'object') return ''
  const groups = [
    ['危险API', evidence.dangerous_apis],
    ['网络', evidence.network_indicators],
    ['凭据', evidence.credential_access],
    ['混淆', evidence.obfuscation_signals],
    ['文件操作', evidence.file_operations],
    ['注入话术', evidence.injection_phrases],
    ['高熵串', evidence.high_entropy_strings],
  ]
  const parts = []
  for (const [label, values] of groups) {
    if (Array.isArray(values) && values.length > 0) parts.push(`${label}: ${values.slice(0, 4).join(' , ')}`)
  }
  if (Array.isArray(evidence.long_line_numbers) && evidence.long_line_numbers.length > 0) {
    parts.push(`超长行: ${evidence.long_line_numbers.join(',')}`)
  }
  if (evidence.random_identifier_count > 0) parts.push(`随机标识符: ${evidence.random_identifier_count}`)
  return parts.join(' | ')
}

/** 渲染单个文件一行（含可选证据/LLM 说明）。 */
function renderResult(item, { verbose }) {
  const probability = Number(item.calibrated_probability ?? 0).toFixed(4)
  const label = DECISION_LABEL[item.final_decision] ?? String(item.final_decision)
  const head = `[${label}] ${item.file_path}  p=${probability}  gate=${item.gate_decision}`
  const meta = `source=${item.source_type} size=${item.file_size_bytes}B windows=${item.windows_evaluated}`
    + `${item.early_stopped ? ' (early-stop)' : ''} sha256=${item.file_sha256}…`
  const lines = [`${head}\n    ${meta}`]
  if (item.llm && item.llm.status && item.llm.status !== 'disabled') {
    const llm = item.llm
    lines.push(`    LLM: status=${llm.status} risk=${llm.risk ?? '-'} reason=${llm.reason ?? '-'}`
      + `${llm.action ? ` action=${llm.action}` : ''}`)
  } else if (item.llm && item.llm.status === 'disabled') {
    lines.push('    LLM: 云端复核已关闭，灰区按本地 0.5 切分')
  }
  if (item.consistency_warning) lines.push('    ⚠ 一致性告警：本地概率高但 LLM 判 low')
  if (verbose) {
    const evidence = evidenceLine(item.evidence)
    if (evidence) lines.push(`    证据: ${evidence}`)
  }
  if (item.error) lines.push(`    ⚠ 处理异常: ${String(item.error).split('\n')[0]}`)
  if (item.report_md_path) lines.push(`    报告: ${item.report_md_path}`)
  return lines.join('\n')
}

/** 渲染审计结果全文（模型与 UI 共用）。 */
function renderAudit(args, value) {
  const { summary } = value
  const head = `CalibGuard 审计完成：${summary.total} 个文件 ｜ 拦截 ${summary.block} · 转人工 `
    + `${summary.manual_review} · 可疑 ${summary.suspicious} · 放行 ${summary.allow}`
    + `${summary.error ? ` · 异常 ${summary.error}` : ''}`
    + ` ｜ 用时 ${(value.elapsedMs / 1000).toFixed(1)}s ｜ 阈值 ${value.config.allowThreshold}/`
    + `${value.config.blockThreshold} ｜ 云端复核 ${value.config.llmEnabled ? '开' : '关'}`
    + `${value.config.llmEnabled ? `（送审 ${value.config.llmDeliveryMode}`
      + `${value.config.llmDeliveryMode === 'truncate' ? `/${value.config.llmTruncateChars}字` : ''
      }${value.config.llmDeliveryMode === 'window'
        ? `/${value.config.llmWindowChars}字+${value.config.llmWindowOverlap}重叠` : ''}`
      + `，内容源 ${value.config.llmContentSource}）` : ''}`
    + ` ｜ 滑窗步长 ${value.config.windowStride}`
  const sections = [head]
  // 大文件/多窗口时把实测吞吐一并告知，便于理解耗时
  if (summary.total > 0 && value.elapsedMs > 2000) {
    const speed = summary.total > 0 ? (value.elapsedMs / 1000) : 0
    sections.push(`（本次用时 ${speed.toFixed(1)}s；模型在 ${value.config.windowStride === 512 ? '非重叠' : '重叠'}滑窗下逐窗口推理，`
      + `大文件耗时随文本长度线性增长。可调 window_stride 或减少送审量来提速。）`)
  }
  if (value.truncated) {
    sections.push(`（注意：文件数超过 maxFiles=${value.maxFiles}，仅审计了前 ${summary.total} 个）`)
  }
  const sorted = [...value.results].sort((a, b) => {
    const orderA = DECISION_ORDER.indexOf(a.final_decision)
    const orderB = DECISION_ORDER.indexOf(b.final_decision)
    return (orderA < 0 ? 99 : orderA) - (orderB < 0 ? 99 : orderB)
  })
  for (const item of sorted) {
    sections.push(renderResult(item, { verbose: item.final_decision !== 'allow' }))
  }
  if (value.config.reportDir) sections.push(`报告目录：${value.config.reportDir}`)
  return [{ type: 'text', text: sections.join('\n\n') }]
}

/** 渲染引擎状态。 */
function renderStatus(_args, value) {
  const policy = value.devicePolicy ?? {}
  const llm = value.llm ?? {}
  const lines = [
    `CalibGuard 引擎状态：${value.modelPresent ? '就绪' : '缺模型权重'}`,
    `- 引擎：${value.engineRoot}（v${value.engineVersion}，Python ${value.python}，torch ${value.torch}）`,
    `- 推理设备：${value.device}${policy.mode ? `（定档 ${policy.mode}：${policy.reason}）` : ''}`,
    `- 模型权重：${value.modelPresent ? `${(value.modelBytes / 1048576).toFixed(1)} MB` : '缺失'}`,
    `- 校准参数：${value.calibrationPresent ? `已就绪（${value.calibration?.method ?? 'platt'}，`
      + `${value.calibration?.n_samples ?? '?'} 条拟合）` : '缺失'}`,
    `- 门控阈值：放行 < ${value.gate?.allowThreshold} ｜ 拦截 > ${value.gate?.blockThreshold}`,
    `- 云端复核：${llm.enabled === false ? '关闭' : '启用'}`
      + `${llm.configured ? `（${llm.model}${llm.baseUrl ? ` @ ${llm.baseUrl}` : ''}）` : '，但未配置 API Key（灰区将转人工）'}`,
    `- 设置来源：${value.settingsSource}${value.settingsError ? `（读取异常：${value.settingsError}）` : ''}`,
    `- 滑窗参数：${value.performance?.maxLength ?? '?'} token 窗 / 步长 ${value.performance?.windowStride ?? '?'}`
      + `${value.performance?.windowsPerSecond
        ? ` ｜ 实测 ${value.performance.windowsPerSecond} 窗口/秒（上次 ${value.performance.lastAuditWindows} 窗口 / ${value.performance.lastAuditElapsedMs} ms）`
        : ' ｜ 尚无实测吞吐（先跑一次审计）'}`,
    `- 模型已加载：${value.loaded ? '是' : '否（首次审计时加载）'} ｜ 累计审计 ${value.auditCount} 个文件`,
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 构造两个工具定义。
 *
 * @param {object} options
 * @param {import('./engine.js').CalibGuardEngine} options.engine
 * @param {object} options.config 归一化配置
 * @param {(definition: object) => object} [options.define] defineTool（缺省恒等）
 * @param {(path: string) => string} [options.resolvePath] 相对路径解析器
 * @returns {object[]} ToolDefinition[]
 */
export function buildTools({ engine, config, define = (definition) => definition, resolvePath }) {
  const toAbsolute = resolvePath ?? ((path) => (isAbsolute(path) ? path : resolve(process.cwd(), path)))

  const audit = define({
    name: 'calibguard_audit',
    description:
      'Audit local files or directories with CalibGuard before you trust, run, install, or ship them. '
      + 'CalibGuard runs a locally fine-tuned CodeBERT gate with Platt calibration (no file content ever '
      + 'leaves the machine for the local decision) and only escalates the gray zone to a cloud LLM review '
      + 'when that is enabled. '
      + 'Returns one verdict per file: allow / suspicious / block / manual_review, plus the calibrated '
      + 'malicious probability, the structured evidence (dangerous APIs, network indicators, credential '
      + 'paths, obfuscation, file operations, prompt-injection phrases, high-entropy strings) and the paths '
      + 'of the written JSON + Markdown reports. '
      + 'Use it when the user asks whether a script or package is safe, before executing freshly downloaded '
      + 'or generated code, when reviewing a dependency or archive, or when auditing a directory of samples. '
      + 'Treat `block` as "do not run without human review", `manual_review` as "inconclusive — ask the user", '
      + 'and `allow` as "the local model found no meaningful signal" (not a guarantee). '
      + 'The first call loads the model and can take tens of seconds on CPU; later calls are fast.',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description: 'Files or directories to audit. Relative paths resolve against the session working directory.',
        items: { type: 'string' },
      },
      include_evidence: {
        type: 'boolean',
        description: 'Return the structured evidence block per file (default true).',
      },
      max_files: {
        type: 'integer',
        description: `Cap on how many files to audit when a directory is given (default ${config.maxFiles}, maximum 200).`,
      },
      allow_threshold: {
        type: 'number',
        description: '本次调用的放行阈值（0~1）。覆盖插件配置；越小越保守（更多文件进入灰区）。',
      },
      block_threshold: {
        type: 'number',
        description: '本次调用的拦截阈值（0~1）。必须大于 allow_threshold，且小于 1。',
      },
      llm_enabled: {
        type: 'boolean',
        description: '本次调用是否启用云端 LLM 复核（false 时灰区按本地模型 0.5 切分）。',
      },
      llm_content_source: {
        type: 'string',
        enum: ['evidence', 'raw'],
        description: '送审内容源：evidence=精炼证据（默认）/ raw=预处理后的文件原文。',
      },
      llm_delivery_mode: {
        type: 'string',
        enum: ['truncate', 'window', 'all'],
        description: '投递模式：truncate=截断前 N 字符（默认）/ window=滑窗分片取最严重 / all=一次性全部上传。',
      },
      truncate_chars: {
        type: 'integer',
        description: 'truncate 模式的字符上限（≥1；仅 llm_delivery_mode=truncate 时有意义）。',
      },
      window_chars: {
        type: 'integer',
        description: 'window 模式的单窗字符数（≥1；仅 llm_delivery_mode=window 时有意义）。',
      },
      window_overlap: {
        type: 'integer',
        description: 'window 模式的相邻窗重叠字符数（0 ≤ overlap < window_chars）。',
      },
      window_stride: {
        type: 'integer',
        description: '模型侧全文滑窗步长（token，1~511）。默认 256；大文件可设 510（窗口几乎不重叠，窗口数约减半、显著提速；代价：跨窗口边界的长逻辑可能被切开）。',
      },
    },
    timeoutMs: config.auditTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: AUDIT_OUTPUT_SCHEMA,
      render: renderAudit,
    },
    async execute(args, exec) {
      const rawPaths = args.paths
      if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
        throw new Error('paths 必须是非空数组：请给出要审计的文件或目录')
      }
      const paths = rawPaths.map((item) => {
        if (typeof item !== 'string' || item.trim() === '') {
          throw new Error(`paths 里出现非法项：${JSON.stringify(item)}`)
        }
        return toAbsolute(item.trim())
      })
      // 只传「调用级」参数：部署配置与 GUI 共享设置由 engine 在 #prepare 里合并，
      // 优先级依次为 插件配置 < GUI 共享设置 < 本次调用参数。
      const options = { includeEvidence: args.include_evidence !== false }
      if (args.max_files !== undefined) options.maxFiles = args.max_files

      // 调用级覆盖（模型可以按场景临时改阈值/送审方式，不改任何持久配置）
      const overrides = {
        allowThreshold: args.allow_threshold,
        blockThreshold: args.block_threshold,
        llmEnabled: args.llm_enabled,
        llmContentSource: args.llm_content_source,
        llmDeliveryMode: args.llm_delivery_mode,
        llmTruncateChars: args.truncate_chars,
        llmWindowChars: args.window_chars,
        llmWindowOverlap: args.window_overlap,
        windowStride: args.window_stride,
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined && value !== null) options[key] = value
      }
      validateAuditOptions(options)
      return engine.audit(paths, options, { signal: exec?.signal })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `CalibGuard 审计 ${Array.isArray(args.paths) ? args.paths.length : 0} 个路径`,
      kind: 'read',
      rawInput: { paths: args.paths },
    }),
  })

  const status = define({
    name: 'calibguard_status',
    description:
      'Report CalibGuard engine readiness: Python interpreter, torch/torch CUDA availability, the device '
      + 'tiering decision (low-compute GPUs are forced to CPU because the CUDA wheels ship no kernels for '
      + 'them), whether the fine-tuned CodeBERT weights and Platt calibration parameters are present, the '
      + 'active gate thresholds, and whether the cloud LLM review is configured. '
      + 'Call this first when an audit fails or before relying on CalibGuard in a new workspace.',
    parameters: {},
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: renderStatus,
    },
    async execute(_args, exec) {
      return engine.inspect({ signal: exec?.signal })
    },
    presentCall: () => ({ card: 'generic', title: 'CalibGuard 引擎状态', kind: 'read' }),
  })

  return [audit, status]
}

export { AUDIT_OUTPUT_SCHEMA, STATUS_OUTPUT_SCHEMA, renderAudit, renderStatus, evidenceLine }
