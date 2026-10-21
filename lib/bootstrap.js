/**
 * 首次运行自动准备环境（对齐 CG_GUI 的「首启自动装环境」）。
 *
 * CG_GUI 的 `launcher.py` 在首启时：检测 Python → 建 `.venv` → 装依赖 → 启动服务。
 * 本插件把同一套体验搬到宿主侧：DSH 启动后（或首次调用工具前）如果没有可用的
 * `<engineRoot>/.venv`，就在后台跑 `setup.mjs` 把「引擎 + venv + 依赖」补齐，
 * 进度写进状态里供面板显示，DSH 启动不受阻塞。
 *
 * 为什么要异步：首次安装包含 476 MB 模型分片下载 + 1–3 GB 依赖安装（十几分钟），
 * 不能卡住插件激活；工具调用在准备完成前会得到可读提示而不是超时。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SETUP_SCRIPT = join(PKG_ROOT, 'setup.mjs')
const TAIL_LINES = 20

/** 当前运行平台 venv 解释器路径（与 bridge 的解析顺序一致）。 */
export function venvPythonPath(engineRoot) {
  return process.platform === 'win32'
    ? join(engineRoot, '.venv', 'Scripts', 'python.exe')
    : join(engineRoot, '.venv', 'bin', 'python')
}

export class EnvironmentBootstrap {
  /**
   * @param {object} options
   * @param {string} options.engineRoot CG_GUI 目录
   * @param {object} [options.logger]
   * @param {boolean} [options.enabled] false 时完全不自动准备（报错让用户手动执行）
   */
  constructor({ engineRoot, logger, enabled = true }) {
    this.engineRoot = engineRoot
    this.logger = logger
    this.enabled = enabled
    this.child = null
    this.promise = null
    /** @type {'idle'|'running'|'ready'|'failed'|'disabled'} */
    this.state = 'idle'
    this.message = ''
    this.step = ''
    this.startedAt = null
    this.finishedAt = null
    this.error = null
    this.tail = []
  }

  /** venv 是否已就绪（这是插件能否拉起桥接的必要条件）。 */
  get venvReady() {
    return existsSync(venvPythonPath(this.engineRoot))
  }

  snapshot() {
    return {
      state: this.state,
      step: this.step,
      message: this.message,
      enabled: this.enabled,
      engineRoot: this.engineRoot,
      venvReady: this.venvReady,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      tail: [...this.tail],
    }
  }

  /** 开始（幂等）：已就绪直接返回，已在跑返回同一个 promise。 */
  start() {
    if (this.state === 'ready') return Promise.resolve(this.snapshot())
    if (this.promise) return this.promise
    if (!this.enabled) {
      this.state = 'disabled'
      this.message = '自动环境准备已关闭（config.autoSetup=false）'
      return Promise.resolve(this.snapshot())
    }
    if (this.venvReady) {
      this.state = 'ready'
      this.message = '环境已就绪'
      return Promise.resolve(this.snapshot())
    }

    this.state = 'running'
    this.startedAt = Date.now()
    this.message = '正在准备运行环境（首次运行会准备模型权重并安装 Python 依赖）…'
    this.logger?.info?.(`[calibguard] ${this.message}`)

    this.promise = new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [SETUP_SCRIPT, '--dest', this.engineRoot, '--skip-verify'], {
        cwd: PKG_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child

      const onLine = (line) => {
        const text = String(line).trim()
        if (!text) return
        this.tail.push(text)
        if (this.tail.length > TAIL_LINES) this.tail.shift()
        const stepMatch = /^==\s*(.+?)\s*==$/.exec(text)
        if (stepMatch) {
          this.step = stepMatch[1]
          this.message = `${this.step}…`
          this.logger?.info?.(`[calibguard] 环境准备：${this.step}`)
          return
        }
        this.message = text
        this.logger?.debug?.(`[calibguard] setup: ${text}`)
      }

      const wire = (stream) => {
        let buffer = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) onLine(line)
        })
        stream.on('end', () => { if (buffer) onLine(buffer) })
      }
      wire(child.stdout)
      wire(child.stderr)

      child.on('error', (error) => {
        this.state = 'failed'
        this.error = String(error?.message ?? error)
        this.message = `环境准备启动失败：${this.error}`
        this.finishedAt = Date.now()
        this.child = null
        this.logger?.warn?.(`[calibguard] ${this.message}`)
        resolvePromise(this.snapshot())
      })

      child.on('close', (code) => {
        this.child = null
        this.finishedAt = Date.now()
        if (code === 0 && this.venvReady) {
          this.state = 'ready'
          this.step = ''
          this.message = '环境已就绪'
          this.logger?.info?.('[calibguard] 环境准备完成 ✓')
        } else {
          this.state = 'failed'
          this.error = `setup.mjs 退出码 ${code}`
          const detail = this.tail.slice(-3).filter(Boolean).join(' ｜ ')
          this.message = `环境准备失败（${this.error}）：${detail || '详见日志'}`
          this.logger?.warn?.(`[calibguard] ${this.message}`)
        }
        resolvePromise(this.snapshot())
      })
    })
    return this.promise
  }

  /**
   * 等待就绪（有上限）。返回 snapshot；调用方据此决定报错文案。
   * @param {number} timeoutMs 0 表示只做一次即时报
   */
  async waitReady(timeoutMs = 0) {
    if (this.state === 'ready' || this.venvReady) {
      if (this.state !== 'ready') this.state = 'ready'
      return this.snapshot()
    }
    if (this.state === 'idle') this.start()
    if (timeoutMs <= 0) return this.snapshot()
    const timer = new Promise((resolvePromise) => {
      const handle = setTimeout(() => resolvePromise('timeout'), timeoutMs)
      if (typeof handle.unref === 'function') handle.unref()
    })
    await Promise.race([this.promise ?? Promise.resolve(null), timer])
    return this.snapshot()
  }

  /** 中断后台安装（插件卸载时调用；只结束我们自己的子进程）。 */
  dispose() {
    if (this.child) {
      try { this.child.kill() } catch { /* 忽略：进程可能已退出 */ }
      this.child = null
      this.logger?.info?.('[calibguard] 已中止后台环境准备')
    }
  }
}
