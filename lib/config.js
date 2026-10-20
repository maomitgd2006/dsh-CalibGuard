/**
 * 插件配置：默认值、归一化、校验，以及可选的 Schemastery Config 导出。
 *
 * 刻意保持「零硬依赖」：Schemastery 用动态 import 获取，拿不到就退化为纯 JS 校验，
 * 插件仍可加载（只是 DSH 设置页拿不到结构化 JSON Schema）。这样插件既能在
 * profile 的 node_modules 里正常安装，也能直接从仓库路径用 file:// 行加载。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 设备定档取值（与 bridge 的 --device 一致）。 */
export const DEVICE_MODES = ['auto', 'cpu', 'cuda']
/** 云端复核内容源（与引擎 LLM_CONTENT_SOURCES 一致）。 */
export const CONTENT_SOURCES = ['evidence', 'raw']
/** 云端复核投递模式（与引擎 LLM_DELIVERY_MODES 一致）。 */
export const DELIVERY_MODES = ['truncate', 'window', 'all']

/** 全部配置项的默认值（等价于「除启用外全自动」）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  engineRoot: '',
  pythonPath: '',
  device: 'auto',
  useGuiSettings: true,
  announceToModel: true,
  /** 首次运行缺少 .venv 时，是否自动下载引擎并安装依赖（对齐 CG_GUI 的首启引导）。 */
  autoSetup: true,
  maxFiles: 20,
  auditTimeoutMs: 600_000,
  idleShutdownMs: 600_000,
  reportDir: '',
  /** GUI 与 AI 共用的设置文件；留空=默认 $DSH_HOME/calibguard-settings.json */
  settingsPath: '',
  /** 模型侧全文滑窗步长（token）：null=引擎默认 256；调大减少窗口数、提速 */
  windowStride: null,
  allowThreshold: null,
  blockThreshold: null,
  llmEnabled: null,
  llmApiKey: '',
  /** DSH 凭据引用名（交给 ctx.credentials.resolve 解析）；留空=不解析。 */
  credentialRef: '',
  /** 兜底清洗用的敏感名模式；留空=用内置启发式（仅平台实现不可用时生效）。 */
  sensitiveEnvPattern: '',
  llmBaseUrl: '',
  llmModel: '',
  llmContentSource: '',
  llmDeliveryMode: '',
})

/** 引擎默认目录：<仓库根>/CG_GUI（本包与它平级）。 */
export function defaultEngineRoot() {
  return resolve(PACKAGE_ROOT, '..', 'CG_GUI')
}

function asBoolean(value, key, out) {
  if (value === undefined || value === null) return
  if (typeof value !== 'boolean') throw new TypeError(`配置项 ${key} 必须是布尔值，当前 ${typeof value}`)
  out[key] = value
}

function asString(value, key, out) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') throw new TypeError(`配置项 ${key} 必须是字符串，当前 ${typeof value}`)
  out[key] = value
}

function asPositiveInt(value, key, out, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return
  const num = Number(value)
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new RangeError(`配置项 ${key} 必须是 ${min}~${max} 之间的数字，当前 ${String(value)}`)
  }
  out[key] = Math.round(num)
}

function asThreshold(value, key, out) {
  if (value === undefined || value === null) return
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0 || num >= 1) {
    throw new RangeError(`配置项 ${key} 必须是 (0,1) 之间的概率，当前 ${String(value)}`)
  }
  out[key] = num
}

function asEnum(value, key, out, allowed) {
  if (value === undefined || value === null || value === '') return
  if (!allowed.includes(value)) {
    throw new RangeError(`配置项 ${key} 必须是 ${allowed.join(' / ')} 之一，当前 ${String(value)}`)
  }
  out[key] = value
}

function asTriStateBoolean(value, key, out) {
  if (value === undefined || value === null || value === '') return
  if (typeof value !== 'boolean') throw new TypeError(`配置项 ${key} 必须是布尔值或留空，当前 ${typeof value}`)
  out[key] = value
}

/** 可空整数（null = 跟随引擎默认）。 */
function asNullableInt(value, key, out, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return
  const num = Number(value)
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new RangeError(`配置项 ${key} 必须是 ${min}~${max} 的整数，当前 ${String(value)}`)
  }
  out[key] = num
}

/**
 * 归一化外部配置：补默认值、逐项校验，非法值抛带中文说明的错误。
 *
 * @param {unknown} raw patch 行里的 config（可能是 undefined）
 * @returns {typeof DEFAULT_CONFIG} 归一化后的配置（含派生字段 engineRootResolved）
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError('插件 config 必须是对象')
  }
  const source = raw ?? {}
  const out = { ...DEFAULT_CONFIG }

  asBoolean(source.enabled, 'enabled', out)
  asString(source.engineRoot, 'engineRoot', out)
  asString(source.pythonPath, 'pythonPath', out)
  asBoolean(source.useGuiSettings, 'useGuiSettings', out)
  asBoolean(source.announceToModel, 'announceToModel', out)
  asBoolean(source.autoSetup, 'autoSetup', out)
  asEnum(source.device, 'device', out, DEVICE_MODES)
  asPositiveInt(source.maxFiles, 'maxFiles', out, { min: 1, max: 200 })
  asPositiveInt(source.auditTimeoutMs, 'auditTimeoutMs', out, { min: 1000, max: 86_400_000 })
  asPositiveInt(source.idleShutdownMs, 'idleShutdownMs', out, { min: 0, max: 86_400_000 })
  asString(source.reportDir, 'reportDir', out)
  asString(source.settingsPath, 'settingsPath', out)
  asNullableInt(source.windowStride, 'windowStride', out, { min: 1, max: 511 })
  asThreshold(source.allowThreshold, 'allowThreshold', out)
  asThreshold(source.blockThreshold, 'blockThreshold', out)
  asTriStateBoolean(source.llmEnabled, 'llmEnabled', out)
  asString(source.llmApiKey, 'llmApiKey', out)
  asString(source.credentialRef, 'credentialRef', out)
  asString(source.sensitiveEnvPattern, 'sensitiveEnvPattern', out)
  asString(source.llmBaseUrl, 'llmBaseUrl', out)
  asString(source.llmModel, 'llmModel', out)
  asEnum(source.llmContentSource, 'llmContentSource', out, CONTENT_SOURCES)
  asEnum(source.llmDeliveryMode, 'llmDeliveryMode', out, DELIVERY_MODES)

  if (out.allowThreshold !== null && out.blockThreshold !== null
      && !(out.allowThreshold < out.blockThreshold)) {
    throw new RangeError(
      `灰区范围必须满足 0 < 下限(${out.allowThreshold}) < 上限(${out.blockThreshold}) < 1`,
    )
  }

  const engineRoot = out.engineRoot ? resolve(out.engineRoot) : defaultEngineRoot()
  if (!existsSync(engineRoot)) {
    throw new Error(
      `引擎目录不存在：${engineRoot}。请修正插件配置 engineRoot（应指向 CG_GUI 目录）。`,
    )
  }
  if (!existsSync(join(engineRoot, 'calibguard'))) {
    throw new Error(`引擎目录下找不到 calibguard 包：${engineRoot}（engineRoot 应指向 CG_GUI 目录）`)
  }

  return { ...out, engineRoot, engineRootResolved: engineRoot, packageRoot: PACKAGE_ROOT }
}

/**
 * 插件配置 → 桥接请求 options（只带用户显式设置过的项，其余交给引擎/设置文件）。
 */
export function toBridgeOptions(config) {
  const options = {
    maxFiles: config.maxFiles,
    includeEvidence: true,
  }
  if (config.reportDir) options.reportDir = resolve(config.reportDir)
  if (config.allowThreshold !== null) options.allowThreshold = config.allowThreshold
  if (config.blockThreshold !== null) options.blockThreshold = config.blockThreshold
  if (config.llmEnabled !== null) options.llmEnabled = config.llmEnabled
  // 注意：**不**在这里投影 llmApiKey —— 凭据由 engine 每次调用时解析后注入，
  // 这样既能走 ctx.credentials（支持轮换后即时生效），也不必把 Key 写进配置副本。
  if (config.llmBaseUrl) options.llmBaseUrl = config.llmBaseUrl
  if (config.llmModel) options.llmModel = config.llmModel
  if (config.llmContentSource) options.llmContentSource = config.llmContentSource
  if (config.llmDeliveryMode) options.llmDeliveryMode = config.llmDeliveryMode
  if (config.windowStride !== null) options.windowStride = config.windowStride
  return options
}

/**
 * 动态加载 Schemastery 并构建 Config；不可用时返回 undefined（插件照常工作）。
 *
 * 用动态 import 是为了让插件在没有 node_modules 的情况下也能加载：
 * DSH 侧只在有 Config 时才会做结构校验与 JSON Schema 投影，缺省即跳过硬校验。
 */
export async function loadConfigSchema() {
  let z
  try {
    z = (await import('@deepseek-ai/schemastery')).default
  } catch {
    return undefined
  }
  if (!z?.object) return undefined
  return z.object({
    enabled: z.boolean().default(true).description('是否注册 CalibGuard 工具'),
    engineRoot: z.string().default('').description('CalibGuard 引擎目录（CG_GUI），留空则自动推导为同级目录'),
    pythonPath: z.string().default('').description('Python 解释器路径，留空则用 <engineRoot>/.venv'),
    device: z.union([z.const('auto'), z.const('cpu'), z.const('cuda')]).default('auto')
      .description('设备定档：auto 会按算力双检，低算力显卡自动回落 CPU'),
    useGuiSettings: z.boolean().default(true).description('复用 CG_GUI/gui-settings.json 里的阈值与云端复核设置'),
    announceToModel: z.boolean().default(true).description('是否把使用时机写入系统提示词'),
    autoSetup: z.boolean().default(true).description('首次运行缺少 .venv 时是否自动下载引擎并安装依赖（对齐 CG_GUI 首启引导）'),
    maxFiles: z.natural().default(20).description('目录展开上限（单次审计最多这些文件）'),
    auditTimeoutMs: z.natural().default(600_000).description('单次审计超时（毫秒）'),
    idleShutdownMs: z.natural().default(600_000).description('空闲多久后回收桥接进程（0=常驻不回收）'),
    reportDir: z.string().default('').description('报告落盘目录，留空则用引擎默认 reports/'),
    settingsPath: z.string().default('')
      .description('GUI 与 AI 共用的设置文件路径；留空则用 $DSH_HOME/calibguard-settings.json'),
    windowStride: z.natural()
      .description('模型侧全文滑窗步长（token，1~511）。留空=引擎默认 256；调大减少窗口数、显著提速（代价：窗口间不再重叠，召回略降）'),
    allowThreshold: z.number().description('放行阈值（留空则用引擎/设置文件的值）'),
    blockThreshold: z.number().description('拦截阈值（留空则用引擎/设置文件的值）'),
    llmEnabled: z.boolean().description('是否启用云端 LLM 复核（留空则跟随设置文件）'),
    llmApiKey: z.string().default('').role('secret')
      .description('云端复核 API Key 字面值（不推荐；留空则用 credentialRef 或设置文件）'),
    credentialRef: z.string().role('credential-ref').default('')
      .description('DSH 凭据引用名（交给 ctx.credentials 解析，支持轮换后即时生效）；留空则不解析'),
    sensitiveEnvPattern: z.string().default('')
      .description('兜底清洗的敏感名正则；留空则用平台实现或内置启发式'),
    llmBaseUrl: z.string().default('').description('OpenAI 兼容 Base URL'),
    llmModel: z.string().default('').description('云端复核模型名'),
    llmContentSource: z.union([z.const('evidence'), z.const('raw')])
      .description('送审内容源：evidence=精炼证据 / raw=预处理后原文'),
    llmDeliveryMode: z.union([z.const('truncate'), z.const('window'), z.const('all')])
      .description('投递模式：truncate=截断 / window=滑窗 / all=一次性全部上传'),
  })
}
