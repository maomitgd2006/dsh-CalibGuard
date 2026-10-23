/**
 * 其他 DSH 插件扫描（CalibGuard × DSH）。
 *
 * 目标：用户安装/更新**别的 DSH 插件**时，自动用 CalibGuard 扫一遍它们的文件并给出提醒；
 * 也支持按周期（每周/每月/每季度/每半年）巡检，或完全关闭。
 *
 * - 只扫 profile `dsh.profile.bundles` 里列出的插件（= 用户实际装上的插件）；
 * - **永远跳过自己**（dsh-calibguard 自带模型/词表，自身就是高敏感大包，扫了没意义）；
 * - 默认跳过 DSH 核心包（`@deepseek-ai/*`），避免把官方基础包误报成风险；
 * - 已删除的插件直接忽略；新装/升级的插件按 package.json 的 version + mtime 识别；
 * - 扫描走已有的引擎（engine.audit），每个插件最多扫 `pluginScanMaxFiles` 个文件；
 * - 结果写 `$DSH_HOME/calibguard-plugin-scan.json` 供面板展示，风险项同时写宿主日志。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './settings.js'

export const SCAN_INTERVAL_OPTIONS = ['off', 'weekly', 'monthly', 'quarterly', 'halfyearly']

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const INTERVAL_MS = {
  weekly: WEEK_MS,
  monthly: 30 * WEEK_MS / 4,
  quarterly: 90 * WEEK_MS / 4,
  halfyearly: 180 * WEEK_MS / 4,
}
const VERDICT_ORDER = ['block', 'manual_review', 'suspicious', 'allow', 'error']
const SELF_NAMES = new Set(['dsh-calibguard'])
const CORE_SCOPES = ['@deepseek-ai/']
const STATE_VERSION = 1

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 插件身份键：名字@版本 + package.json mtime（升级/重装都会被识别为"变化"）。 */
export function pluginKey(plugin) {
  let mtime = 0
  try {
    mtime = Math.round(statSync(join(plugin.dir, 'package.json')).mtimeMs)
  } catch {
    /* 读不到 mtime 时只用版本 */
  }
  return `${plugin.name}@${plugin.version}#${mtime}`
}

/**
 * 列出各 profile 里已安装的「别的 DSH 插件」。
 * @param {{home?: string}} [options] home 默认 `$DSH_HOME`（`~/.dsh`），测试时可注入临时目录
 * @returns {Array<{profile:string,name:string,version:string,dir:string}>}
 */
export function listInstalledPlugins({ home } = {}) {
  const base = home ?? dshHome()
  const profilesDir = join(base, 'profiles')
  if (!existsSync(profilesDir)) return []
  const out = []
  const seen = new Set()
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profileDir = join(profilesDir, entry.name)
    const profilePkg = readJson(join(profileDir, 'package.json'))
    const bundles = profilePkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) continue
    for (const raw of bundles) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const name = raw.trim()
      if (SELF_NAMES.has(name)) continue
      if (CORE_SCOPES.some((prefix) => name.startsWith(prefix))) continue
      const dir = join(profileDir, 'node_modules', name)
      if (!existsSync(join(dir, 'package.json'))) continue
      const dedupeKey = `${entry.name}:${name}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const meta = readJson(join(dir, 'package.json')) ?? {}
      out.push({ profile: entry.name, name, version: String(meta.version ?? ''), dir })
    }
  }
  return out.sort((a, b) => `${a.profile}:${a.name}`.localeCompare(`${b.profile}:${b.name}`))
}

function summarizeAudit(name, version, result) {
  const summary = result?.summary ?? {}
  const items = Array.isArray(result?.results) ? result.results : []
  const pick = (verdict) => items
    .filter((item) => item.final_decision === verdict)
    .slice(0, 3)
    .map((item) => item.file_path)
  let worst = 'allow'
  if (Number(summary.block) > 0) worst = 'block'
  else if (Number(summary.manual_review) > 0) worst = 'manual_review'
  else if (Number(summary.suspicious) > 0) worst = 'suspicious'
  return {
    name,
    version,
    total: Number(summary.total ?? 0),
    block: Number(summary.block ?? 0),
    manual_review: Number(summary.manual_review ?? 0),
    suspicious: Number(summary.suspicious ?? 0),
    allow: Number(summary.allow ?? 0),
    error: Number(summary.error ?? 0),
    worst,
    blockedFiles: pick('block'),
    manualFiles: pick('manual_review'),
    elapsedMs: result?.elapsedMs ?? null,
  }
}

export class PluginScanManager {
  constructor({ engine, logger, config, settingsStore, home } = {}) {
    this.engine = engine
    this.logger = logger
    this.config = config
    this.settingsStore = settingsStore
    this.baseDir = home ?? dshHome()
    this.stateFile = join(this.baseDir, 'calibguard-plugin-scan.json')
    this.timer = null
    this.busy = false
    this.lastError = null
    this.state = this.#loadState()
  }

  #loadState() {
    const raw = readJson(this.stateFile)
    if (!raw || typeof raw !== 'object') {
      return { version: STATE_VERSION, known: null, lastScanAt: null, lastMode: null, results: [], pluginsScanned: 0 }
    }
    return {
      version: STATE_VERSION,
      known: Array.isArray(raw.known) ? raw.known : null,
      lastScanAt: Number(raw.lastScanAt) || null,
      lastMode: raw.lastMode ?? null,
      results: Array.isArray(raw.results) ? raw.results : [],
      pluginsScanned: Number(raw.pluginsScanned) || 0,
    }
  }

  #saveState() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.logger?.warn?.(`[calibguard] 保存插件扫描状态失败：${error?.message ?? error}`)
    }
  }

  /** 生效的扫描选项：共享设置（面板/AI）> 插件配置 > 内置默认。 */
  options() {
    const settings = this.settingsStore?.get?.() ?? {}
    const interval = String(settings.pluginScanInterval ?? this.config?.pluginScanInterval ?? 'monthly').toLowerCase()
    const onUpdate = settings.scanPluginsOnUpdate ?? this.config?.scanPluginsOnUpdate ?? true
    const maxFiles = Number(settings.pluginScanMaxFiles ?? this.config?.pluginScanMaxFiles ?? 100)
    return {
      onUpdate: onUpdate !== false,
      interval: SCAN_INTERVAL_OPTIONS.includes(interval) ? interval : 'monthly',
      maxFiles: Number.isFinite(maxFiles) ? Math.max(1, Math.min(500, Math.round(maxFiles))) : 100,
    }
  }

  /** 开始轮询（每分钟检查一次：插件列表是否变化 / 是否到周期）。 */
  start() {
    if (this.timer) return
    const tick = () => {
      this.tick().catch((error) => this.logger?.warn?.(`[calibguard] 插件扫描检查失败：${error?.message ?? error}`))
    }
    this.timer = setInterval(tick, 60_000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    tick()
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  nextDueAt() {
    const opts = this.options()
    if (opts.interval === 'off' || !this.state.lastScanAt) return null
    return this.state.lastScanAt + INTERVAL_MS[opts.interval]
  }

  due() {
    const next = this.nextDueAt()
    return next !== null && Date.now() >= next
  }

  /** 每分钟检查一次：发现新装/升级的插件（onUpdate）或到周期（periodic）就扫。 */
  async tick() {
    if (this.busy) return
    const opts = this.options()
    if (!opts.onUpdate && opts.interval === 'off') return
    const plugins = listInstalledPlugins({ home: this.baseDir })
    const keys = plugins.map((plugin) => pluginKey(plugin))
    if (!Array.isArray(this.state.known)) {
      // 第一次启动只记录基线，不打扰用户（之后新装/升级才扫）
      this.state.known = keys
      this.#saveState()
      this.logger?.info?.(`[calibguard] 插件扫描已就绪（记录 ${plugins.length} 个其他插件；之后安装/更新会自动扫描）`)
      return
    }
    let scanned = false
    if (opts.onUpdate) {
      const added = plugins.filter((plugin) => !this.state.known.includes(pluginKey(plugin)))
      if (added.length > 0) {
        scanned = true
        await this.scanPlugins(added, 'update', opts)
      }
    }
    if (!scanned && this.due()) {
      await this.scanPlugins(plugins, 'periodic', opts)
    }
    this.state.known = listInstalledPlugins({ home: this.baseDir }).map((plugin) => pluginKey(plugin))
    this.#saveState()
  }

  /** 手动/工具触发：mode=all 全量；changed 只扫新装/升级的。 */
  async scanNow(mode = 'all') {
    if (this.busy) throw new Error('已有插件扫描在进行中，请稍后再试')
    const opts = this.options()
    const plugins = listInstalledPlugins({ home: this.baseDir })
    const targets = mode === 'changed' && Array.isArray(this.state.known)
      ? plugins.filter((plugin) => !this.state.known.includes(pluginKey(plugin)))
      : plugins
    return this.scanPlugins(targets, mode, opts)
  }

  async scanPlugins(plugins, mode, opts = this.options()) {
    if (this.busy) throw new Error('已有插件扫描在进行中，请稍后再试')
    if (!this.engine?.bootstrap?.venvReady) {
      this.lastError = '引擎环境尚未就绪，本次跳过插件扫描（等首次环境准备完成后再试）'
      this.logger?.warn?.(`[calibguard] ${this.lastError}`)
      return this.snapshot()
    }
    this.busy = true
    this.lastError = null
    const results = []
    this.logger?.info?.(`[calibguard] 开始扫描其他 DSH 插件（${mode}，${plugins.length} 个，每个最多 ${opts.maxFiles} 个文件）…`)
    try {
      for (const plugin of plugins) {
        try {
          const result = await this.engine.audit([plugin.dir], {
            maxFiles: opts.maxFiles,
            includeEvidence: false,
          })
          results.push(summarizeAudit(plugin.name, plugin.version, result))
        } catch (error) {
          results.push({
            name: plugin.name,
            version: plugin.version,
            total: 0,
            block: 0,
            manual_review: 0,
            suspicious: 0,
            allow: 0,
            error: 1,
            worst: 'error',
            blockedFiles: [],
            manualFiles: [],
            errorMessage: String(error?.message ?? error),
          })
        }
      }
      results.sort((a, b) => (VERDICT_ORDER.indexOf(a.worst) - VERDICT_ORDER.indexOf(b.worst))
        || a.name.localeCompare(b.name))
      this.state.results = results
      this.state.lastScanAt = Date.now()
      this.state.lastMode = mode
      this.state.pluginsScanned = results.length
      const risky = results.filter((item) => item.worst === 'block' || item.worst === 'manual_review')
      for (const item of risky) {
        const label = item.worst === 'block' ? '拦截' : '转人工'
        this.logger?.warn?.(`[calibguard] 插件提醒：${item.name}@${item.version} → ${label}`
          + `（block=${item.block}, manual=${item.manual_review}）；可在 CalibGuard 面板「其他插件扫描」查看`)
      }
      this.logger?.info?.(`[calibguard] 插件扫描完成：${results.length} 个，`
        + `block=${results.reduce((sum, item) => sum + item.block, 0)}，`
        + `manual=${results.reduce((sum, item) => sum + item.manual_review, 0)}`)
    } finally {
      this.busy = false
      this.#saveState()
    }
    return this.snapshot()
  }

  snapshot() {
    const opts = this.options()
    return {
      enabled: opts.onUpdate || opts.interval !== 'off',
      options: opts,
      running: this.busy,
      lastScanAt: this.state.lastScanAt,
      lastMode: this.state.lastMode,
      nextDueAt: this.nextDueAt(),
      results: this.state.results,
      pluginsCount: this.state.pluginsScanned,
      error: this.lastError,
      stateFile: this.stateFile,
    }
  }
}
