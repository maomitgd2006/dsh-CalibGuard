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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SETUP_SCRIPT = join(PKG_ROOT, 'setup.mjs')
const TAIL_LINES = 20

/** setup.mjs 成功装完依赖后写的标记文件；存在且未过期才算「依赖就绪」。 */
export const DEPS_MARKER = '.deps-ok.json'

/** 依赖标记路径。 */
export function depsMarkerPath(engineRoot) {
  return join(engineRoot, DEPS_MARKER)
}

/**
 * 依赖是否装全：venv 里的 python 存在 + setup.mjs 写下的依赖标记有效。
 *
 * 只检查 venv 是否存在是不够的：上次安装被中断（关掉 DSH / 关机）时会留下
 * 一个只有部分包的 venv；之后重启如果只看 python.exe 存在就当作就绪，
 * 桥接进程会在导入 torch / sklearn / openai 时崩掉（No module named 'sklearn'）。
 */
export function depsMarkerValid(engineRoot) {
  const markerPath = depsMarkerPath(engineRoot)
  if (!existsSync(markerPath)) return false
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (!marker || marker.ok !== true || typeof marker.verifiedAt !== 'number') return false
    // requirements 更新过（插件升级）→ 旧标记失效，需要重新校验依赖
    const requirements = join(engineRoot, 'requirements-gui.txt')
    if (existsSync(requirements) && statSync(requirements).mtimeMs > marker.verifiedAt) return false
    return true
  } catch {
    return false
  }
}

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

  /** venv 的 python 是否存在（必要条件，但不足以说明依赖装全）。 */
  get venvReady() {
    return existsSync(venvPythonPath(this.engineRoot))
  }

  /** 依赖是否装全（venv + setup.mjs 的 .deps-ok.json 标记都有效）。 */
  get depsReady() {
    return this.venvReady && depsMarkerValid(this.engineRoot)
  }

  snapshot() {
    return {
      state: this.state,
      step: this.step,
      message: this.message,
      enabled: this.enabled,
      engineRoot: this.engineRoot,
      venvReady: this.venvReady,
      depsReady: this.depsReady,
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
    if (this.depsReady) {
      this.state = 'ready'
      this.message = '环境已就绪'
      return Promise.resolve(this.snapshot())
    }

    // 有 venv 但依赖没装全（上次安装被中断的典型情况）：自动补装，不当作就绪
    const needsRepair = this.venvReady
    this.state = 'running'
    this.startedAt = Date.now()
    this.message = needsRepair
      ? '检测到虚拟环境不完整（上次安装可能被中断），正在自动补装缺失依赖…'
      : '正在准备运行环境（首次运行会准备模型权重并安装 Python 依赖）…'
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
        if (code === 0 && this.depsReady) {
          this.state = 'ready'
          this.step = ''
          this.message = '环境已就绪'
          this.logger?.info?.('[calibguard] 环境准备完成 ✓')
        } else if (code === 0) {
          this.state = 'failed'
          this.error = '依赖校验未通过（缺少 .deps-ok.json 标记）'
          this.message = '安装脚本结束了，但依赖仍未装全；请手动运行 node setup.mjs 查看输出'
          this.logger?.warn?.(`[calibguard] ${this.message}`)
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
    if (this.depsReady) {
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
