/**
 * 本插件自更新检查（**只提示，不静默升级**）。
 *
 * - 定时/启动时查询 npm registry 上 `dsh-calibguard` 的最新版本，与当前版本比较；
 * - 发现新版本时只置「可用」标记并写日志，由面板弹窗提示用户；绝不自动替换插件；
 * - 用户可以「跳过此版本」或「以后不再询问」（持久化）；升级动作本身需要 DSH 重新安装/更新插件，
 *   所以弹窗里给出桌面端步骤、CLI 命令和发布页链接；
 * - 检查频率：off / startup（每次启动一次）/ daily / weekly；
 * - 状态文件：`$DSH_HOME/calibguard-self-update.json`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './settings.js'

export const SELF_UPDATE_OPTIONS = ['off', 'startup', 'daily', 'weekly']

const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = {
  startup: Number.MAX_SAFE_INTEGER, // 每次进程只检查一次，由 start() 触发
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
}
const POLL_MS = 6 * 60 * 60 * 1000
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/dsh-calibguard/latest'
const NPM_PAGE_URL = 'https://www.npmjs.com/package/dsh-calibguard'
const RELEASES_URL = 'https://github.com/maomitgd2006/dsh-CalibGuard/releases/latest'

/** 简单 semver 比较：a>b 返回 1，相等 0，a<b 返回 -1（非法版本按 0 处理）。 */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((num) => (Number.isFinite(num) ? num : 0))
  const left = parse(a)
  const right = parse(b)
  const len = Math.max(left.length, right.length)
  for (let index = 0; index < len; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export class SelfUpdateChecker {
  constructor({ logger, config, settingsStore, home, currentVersion, fetchImpl } = {}) {
    this.logger = logger
    this.config = config
    this.settingsStore = settingsStore
    this.baseDir = home ?? dshHome()
    this.stateFile = join(this.baseDir, 'calibguard-self-update.json')
    this.currentVersion = String(currentVersion ?? '0.0.0')
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.timer = null
    this.busy = false
    this.state = this.#loadState()
  }

  #loadState() {
    const raw = readJson(this.stateFile)
    if (!raw || typeof raw !== 'object') {
      return {
        lastCheckAt: null, latestVersion: null, lastError: null,
        skippedVersion: null, neverAsk: false,
      }
    }
    return {
      lastCheckAt: Number(raw.lastCheckAt) || null,
      latestVersion: raw.latestVersion ? String(raw.latestVersion) : null,
      lastError: raw.lastError ? String(raw.lastError) : null,
      skippedVersion: raw.skippedVersion ? String(raw.skippedVersion) : null,
      neverAsk: raw.neverAsk === true,
    }
  }

  #saveState() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.logger?.warn?.(`[calibguard] 保存自更新状态失败：${error?.message ?? error}`)
    }
  }

  /** 生效的检查频率：共享设置（面板/AI）> 插件配置 > 默认 startup。 */
  options() {
    const settings = this.settingsStore?.get?.() ?? {}
    const raw = String(settings.selfUpdateCheck ?? this.config?.selfUpdateCheck ?? 'startup').toLowerCase()
    return { mode: SELF_UPDATE_OPTIONS.includes(raw) ? raw : 'startup' }
  }

  /** 是否到检查时间（startup 模式每个进程只查一次）。 */
  due() {
    const { mode } = this.options()
    if (mode === 'off') return false
    if (!this.state.lastCheckAt) return true
    return Date.now() - this.state.lastCheckAt >= CHECK_INTERVAL_MS[mode]
  }

  /** 启动：startup 模式立即查一次；daily/weekly 到期才查；之后每 6 小时看一次是否到期。 */
  start() {
    if (this.timer || this.options().mode === 'off') return
    this.checkNow().catch(() => {})
    this.timer = setInterval(() => {
      if (this.due()) this.checkNow().catch(() => {})
    }, POLL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 立即检查（面板「立即检测」/ 启动时都走这里）。 */
  async checkNow() {
    if (this.busy) return this.snapshot()
    if (typeof this.fetchImpl !== 'function') {
      this.state.lastError = '当前运行环境没有 fetch，无法检查 npm 版本'
      return this.snapshot()
    }
    this.busy = true
    this.state.lastError = null
    try {
      const response = await this.fetchImpl(REGISTRY_LATEST_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`npm registry 返回 HTTP ${response.status}`)
      const latest = String((await response.json())?.version ?? '').trim()
      if (!latest) throw new Error('npm registry 没有返回版本号')
      this.state.latestVersion = latest
      this.state.lastCheckAt = Date.now()
      if (compareVersions(latest, this.currentVersion) > 0) {
        this.logger?.info?.(`[calibguard] 发现新版本 v${latest}（当前 v${this.currentVersion}）；`
          + '不会自动升级，请在面板「关于/更新」里确认。')
      }
    } catch (error) {
      this.state.lastError = String(error?.message ?? error)
      this.logger?.debug?.(`[calibguard] 检查新版本失败：${this.state.lastError}`)
    } finally {
      this.busy = false
      this.#saveState()
    }
    return this.snapshot()
  }

  /** 用户选择：跳过该版本（scope=version）或以后不再询问（scope=forever）。 */
  dismiss(scope = 'version') {
    if (scope === 'forever') {
      this.state.neverAsk = true
    } else {
      this.state.skippedVersion = this.state.latestVersion
    }
    this.#saveState()
    return this.snapshot()
  }

  /** 面板展示用：更新信息 + 升级方式（不执行任何升级）。 */
  snapshot() {
    const latest = this.state.latestVersion
    const available = Boolean(latest)
      && compareVersions(latest, this.currentVersion) > 0
      && !this.state.neverAsk
      && this.state.skippedVersion !== latest
    return {
      options: this.options(),
      currentVersion: this.currentVersion,
      latestVersion: latest,
      available,
      checkedAt: this.state.lastCheckAt,
      lastError: this.state.lastError,
      skippedVersion: this.state.skippedVersion,
      neverAsk: this.state.neverAsk,
      stateFile: this.stateFile,
      upgrade: {
        desktop: '设置 → 添加插件 → 输入 dsh-calibguard → 重启 DSH（会装到 latest）',
        command: 'dsh plugin --profile <profile> add dsh-calibguard@latest',
        npmUrl: NPM_PAGE_URL,
        releasesUrl: RELEASES_URL,
      },
    }
  }
}
