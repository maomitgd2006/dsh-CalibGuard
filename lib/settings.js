/**
 * 共享设置存储：**GUI 面板保存的参数，AI 工具调用也会使用**。
 *
 * 这就是"二合一"的关键：同一份设置，两个调用壳共用。
 *   - 面板（GUI 壳）：读/写这份设置；
 *   - 工具（AI 壳）：每次调用时把这份设置作为基础参数，调用级参数仍可临时覆盖。
 *
 * 存哪里：`$DSH_HOME/calibguard-settings.json`（默认 `~/.dsh/`），不写进仓库。
 * 写入用「临时文件 + rename」保证原子性；文件损坏时按空设置处理并告警，绝不阻断审计。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { validateAuditOptions } from './tools.js'

/**
 * 设置文件允许出现的键（与桥接 options 同名，camelCase）。
 *
 * 刻意**不含** `windowStride`：模型侧滑窗步长不属于「GUI 可编辑设置」
 *（CG_GUI 也没有这个项），只保留「工具参数 window_stride / 插件配置 windowStride」两个入口。
 * 这样面板的设置面与 CG_GUI 保持一致，不会多出一个难懂的概念。
 */
export const SETTINGS_KEYS = [
  'allowThreshold',
  'blockThreshold',
  'llmEnabled',
  'llmContentSource',
  'llmDeliveryMode',
  'llmBaseUrl',
  'llmModel',
  'llmTruncateChars',
  'llmWindowChars',
  'llmWindowOverlap',
  'maxFiles',
  // 凭据名（保存位置的名字，不是密钥本身）。只在本插件 Node 侧使用，不会下发给桥接进程。
  'credentialRef',
]

/** DSH home：优先环境变量，其次 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 默认设置文件路径。 */
export function defaultSettingsPath() {
  return join(dshHome(), 'calibguard-settings.json')
}

/** 只保留白名单键；非对象返回空对象。 */
export function pickSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const picked = {}
  for (const key of SETTINGS_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null) picked[key] = raw[key]
  }
  return picked
}

/**
 * 校验一份设置（白名单 + 与工具参数同一套规则）。
 *
 * @param {unknown} raw
 * @returns {object} 校验后的设置（可能为空对象 = 全部跟随插件配置/引擎默认）
 * @throws {Error} 非法值
 */
export function validateSettings(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('设置必须是 JSON 对象')
  }
  const picked = pickSettings(raw ?? {})
  if (picked.credentialRef !== undefined) {
    if (typeof picked.credentialRef !== 'string'
      || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(picked.credentialRef)) {
      throw new Error('credentialRef 必须是合法凭据名（字母/数字/下划线，且以字母或下划线开头，如 DEEPSEEK_API_KEY）')
    }
  }
  validateAuditOptions(picked)
  return picked
}

export class SettingsStore {
  /**
   * @param {object} [options]
   * @param {string} [options.file] 设置文件路径（默认 `$DSH_HOME/calibguard-settings.json`）
   * @param {object} [options.logger]
   */
  constructor({ file, logger } = {}) {
    this.file = file ? resolve(file) : defaultSettingsPath()
    this.logger = logger
    this.current = {}
    this.loadError = null
    this.load()
  }

  /** 启动时读一次；损坏/缺失都降级为空设置。 */
  load() {
    this.current = {}
    this.loadError = null
    if (!existsSync(this.file)) return this.current
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      this.current = validateSettings(raw)
    } catch (error) {
      this.loadError = String(error?.message ?? error)
      this.logger?.warn?.(`[calibguard] 共享设置读取失败（按空设置处理）：${this.loadError}`)
      this.current = {}
    }
    return this.current
  }

  /** 当前生效设置（副本）。 */
  get() {
    return { ...this.current }
  }

  /** 保存（全量替换）。返回保存后的设置；非法值抛错且不落盘。 */
  save(raw) {
    const next = validateSettings(raw)
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    try {
      renameSync(temp, this.file)
    } catch (error) {
      try { unlinkSync(temp) } catch { /* 清理失败不影响主流程 */ }
      throw error
    }
    this.current = next
    this.loadError = null
    this.logger?.info?.(`[calibguard] 共享设置已保存：${this.file}`)
    return this.get()
  }

  /** 清空为「全部跟随插件配置」。 */
  reset() {
    return this.save({})
  }

  /** 诊断信息（不含敏感值；设置本身不含凭据）。 */
  diagnostics() {
    return { file: this.file, settings: this.get(), loadError: this.loadError }
  }
}
