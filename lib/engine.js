/**
 * CalibGuard 引擎桥接：以「常驻子进程 + 行式 JSON 协议」复用未改动的 Python 引擎。
 *
 * 设计要点（与 CG_GUI/audit_service.py 的取舍保持一致）：
 *   - 模型只加载一次：桥接进程常驻，首次 audit 时加载 CodeBERT，其后复用；
 *   - 单飞：引擎侧只有一个流水线实例，本类用一条 promise 链把请求串行化；
 *   - 空闲回收：超过 idleShutdownMs 没有请求就停掉子进程，避免长期占用数百 MB 内存；
 *   - 崩溃自愈：子进程异常退出时拒绝在途请求、记录 stderr 尾巴，并在下次调用时重启；
 *   - 不使用任何第三方依赖（DSH 包全部按可选取用），使插件可以从任意路径加载。
 *
 * 凭据（**零硬编码**）：
 *   - 子进程环境经 `buildChildEnv()` 清洗：`*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*`
 *     与 `DSH_*` 一律不传，与 DSH 自己的 `scrubbedParentEnv()` 同源（能导入就直接用它的）；
 *   - 云端复核 Key 的唯一来源是配置：`llmApiKey`（字面值）或 `credentialRef`
 *     （交给 `ctx.credentials.resolve()` 解析，优先级 env > 凭据库 > .env，随 DSH 策略演进）；
 *   - 解析结果**每次操作重新解析**（凭据轮换即时生效），并只通过 subprocess 的 stdin
 *     私有管道随请求下发 —— 不进 argv（进程列表可见）、不进子进程环境变量。
 *
 * 关于进程存活：**故意不对子进程做 unref**。unref 会让「等待桥接响应」的调用方失去事件源，
 * 出现「unsettled top-level await」而提前退出（实测）。桥接的回收靠三条路径保证：
 * ①插件 fiber 卸载时 scoped(dispose) 会停桥接；②空闲回收计时器；③宿主硬退出时
 * stdin 管道关闭 → 桥接读到 EOF 自行退出，不留孤儿进程。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildChildEnv } from './env.js'
import { toBridgeOptions } from './config.js'
import { EnvironmentBootstrap, venvPythonPath } from './bootstrap.js'

/** 桥接脚本相对本文件的位置（spawn 需要真实路径，不能直接把 URL 对象交给子进程）。 */
const BRIDGE_SCRIPT = fileURLToPath(new URL('../bridge/calibguard_bridge.py', import.meta.url))

/** 单次 status 请求的默认超时（毫秒）：只做文件探测与 torch 导入，很快。 */
const STATUS_TIMEOUT_MS = 60_000

/** 首次运行时，工具调用最多等环境准备多久（毫秒）；超时即返回可读提示，后台继续装。 */
const ENV_WAIT_MS = 60_000

/** stderr 环形缓冲行数：崩溃时把最后几行回给调用方，便于定位。 */
const STDERR_TAIL_LINES = 20

export class CalibGuardEngine {
  /**
   * @param {object} options
   * @param {object} options.config       已归一化的插件配置（见 config.js）
   * @param {object} [options.logger]     形如 ctx.logger 的对象（可选，缺省静默）
   * @param {object} [options.credentials] DSH 的 ctx.credentials 服务（可选；缺省退回同名环境变量）
   * @param {object} [options.settingsStore] 共享设置（GUI 保存、工具共用；见 settings.js）
   */
  constructor({ config, logger, credentials, settingsStore }) {
    this.config = config
    this.logger = logger
    this.credentials = credentials
    this.settingsStore = settingsStore
    /** 插件配置投影出的基础参数（部署默认值）。 */
    this.baseOptions = toBridgeOptions(config)
    this.child = null
    this.pending = new Map()
    this.stderrTail = []
    this.nextId = 1
    /** @type {Promise<unknown>} 串行化链：保证同时只有一条请求在飞。 */
    this.chain = Promise.resolve()
    this.idleTimer = null
    this.stopping = false
    this.startedAt = null
    this.restarts = 0
    this.lastExit = null
    this.statusCache = null
    /** 最近一次凭据解析结果（只用于诊断，不缓存值给下次复用）。 */
    this.lastCredential = { source: 'none', configured: false }
    /**
     * 首次运行自动准备环境（对齐 CG_GUI 的 launcher 首启装环境）：
     * 缺 `<engineRoot>/.venv` 时在后台跑 setup.mjs（内置引擎 + npm 模型分片 → 建 venv → 装依赖）。
     */
    this.bootstrap = new EnvironmentBootstrap({
      engineRoot: config.engineRootResolved ?? config.engineRoot,
      logger,
      enabled: config.autoSetup !== false,
    })
  }

  /** 环境快照（面板/工具可读）。 */
  environment() {
    return this.bootstrap.snapshot()
  }

  /** 后台预热：不阻塞插件激活；失败只记日志。 */
  warmup() {
    if (this.bootstrap.venvReady) {
      this.logger?.debug?.('[calibguard] 环境已就绪（venv 存在），跳过自动准备')
      return
    }
    this.logger?.info?.('[calibguard] 首次运行：后台自动准备引擎与 Python 依赖（进度可在面板状态里看到）')
    this.bootstrap.start().catch((error) => {
      this.logger?.warn?.(`[calibguard] 自动准备环境失败：${error?.message ?? error}`)
    })
  }

  /**
   * 确保运行环境可用；不可用时抛出**可读**错误（而不是让 spawn 报 ENOENT）。
   * @param {number} waitMs 最多等多久（首次准备期间调用方等待上限）
   */
  async ensureEnvironment(waitMs = ENV_WAIT_MS) {
    const state = await this.bootstrap.waitReady(waitMs)
    if (state.state === 'ready' || this.bootstrap.venvReady) return state
    if (state.state === 'disabled' || !this.bootstrap.enabled) {
      throw new Error('引擎环境未就绪，且已关闭自动准备（config.autoSetup=false）。'
        + '请手动运行 `node setup.mjs` 后重试。')
    }
    const detail = state.state === 'failed'
      ? `：${state.error ?? state.message}`
      : `：${state.step || state.message}`
    throw new Error(`首次运行需要准备引擎与依赖（正在后台进行，步骤${detail}）。`
      + '安装完成后重试即可；进度可在 CalibGuard 面板状态或宿主日志的 [calibguard] 行查看。')
  }

  /** 当前共享设置（GUI 保存的那份）。 */
  settings() {
    return this.settingsStore?.get?.() ?? {}
  }

  // ============================== 凭据解析 ==============================

  /**
   * 解析云端复核使用的 Key。**每次操作都重新解析**，因此凭据轮换无需重启进程。
   *
   * 顺序：
   *   1. `config.llmApiKey`（配置里的字面值，最低推荐度）；
   *   2. `config.credentialRef` → `ctx.credentials.resolve(ref)`（DSH 的分层解析：
   *      继承环境 > 凭据库 > .env 文件，具体层由来源 `source` 报告）；
   *   3. 若凭据服务不可用，则按同名环境变量读取（名字来自配置，不是硬编码）。
   *
   * @returns {Promise<{key: string|undefined, source: string}>}
   */
  async resolveCredential() {
    const config = this.config
    if (typeof config.llmApiKey === 'string' && config.llmApiKey) {
      this.lastCredential = { source: 'config.llmApiKey', configured: true }
      return { key: config.llmApiKey, source: this.lastCredential.source }
    }

    const ref = config.credentialRef
    if (!ref) {
      this.lastCredential = { source: 'none', configured: false }
      return { key: undefined, source: 'none' }
    }

    if (this.credentials?.resolve) {
      try {
        const resolved = await this.credentials.resolve(ref)
        if (resolved?.value) {
          this.lastCredential = { source: `credentials:${resolved.source ?? 'unknown'}`, configured: true }
          return { key: resolved.value, source: this.lastCredential.source }
        }
        this.logger?.warn?.(`[calibguard] 凭据引用 ${ref} 未配置（credentialRef），云端复核将不可用`)
        this.lastCredential = { source: 'credentials:missing', configured: false }
        return { key: undefined, source: this.lastCredential.source }
      } catch (error) {
        this.logger?.warn?.(`[calibguard] 解析凭据 ${ref} 失败：${error?.message ?? error}`)
      }
    }

    // 凭据服务不可用时的显式回退：按配置给出的名字读同名环境变量
    const fromEnv = process.env[ref]
    if (fromEnv) {
      this.lastCredential = { source: `env:${ref}`, configured: true }
      return { key: fromEnv, source: this.lastCredential.source }
    }
    this.lastCredential = { source: 'unavailable', configured: false }
    return { key: undefined, source: 'unavailable' }
  }

  /**
   * 把云端复核 Key 写入 DSH 凭据库（面板「API Key → 保存」走这里）。
   *
   * 只在配置了 `credentialRef` 且 `ctx.credentials` 提供 `set` 时可用；
   * 否则明确报错并给出替代做法 —— 不把明文 Key 写进共享设置文件。
   *
   * @param {string} value API Key
   * @returns {Promise<{ref: string, saved: boolean}>}
   */
  async setCredential(value) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error('API Key 不能为空')
    const ref = this.config.credentialRef
    if (!ref) {
      throw new Error('未配置 credentialRef：请在插件配置里指定凭据名（如 DEEPSEEK_API_KEY），'
        + '或改用 DSH 的 Models 页配置 Key')
    }
    if (typeof this.credentials?.set !== 'function') {
      throw new Error('当前环境不支持写入凭据库：请在 DSH Models 页配置，或用插件配置 llmApiKey')
    }
    await this.credentials.set(ref, value.trim())
    this.lastCredential = { source: 'credentials:set', configured: true }
    this.logger?.info?.(`[calibguard] 已写入凭据引用 ${ref}（值不落日志）`)
    return { ref, saved: true }
  }

  /**
   * 组装一次调用真正下发给桥接的 options。
   *
   * 优先级（后者覆盖前者）：
   *   引擎/插件配置（部署默认） < **共享设置**（GUI 保存的那份） < 调用级参数
   * 最后再注入凭据（llmApiKey）。
   */
  async #prepare(options) {
    const merged = { ...this.baseOptions, ...this.settings(), ...options }
    if (!merged.llmApiKey) {
      const { key } = await this.resolveCredential()
      if (key) merged.llmApiKey = key
    }
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key]
    }
    return merged
  }

  // ============================== Python 解释器解析 ==============================

  /**
   * 解析用于运行桥接脚本的 Python 解释器。
   *
   * 顺序：显式配置 → 环境变量 → 引擎目录下的 .venv（GUI 壳装好的那套，含 torch）
   *      → PATH 上的 python。找不到时抛出带修复指引的错误。
   */
  resolvePython() {
    const candidates = []
    if (this.config.pythonPath) candidates.push({ path: this.config.pythonPath, why: 'config.pythonPath' })
    if (process.env.DSH_CALIBGUARD_PYTHON) {
      candidates.push({ path: process.env.DSH_CALIBGUARD_PYTHON, why: 'DSH_CALIBGUARD_PYTHON' })
    }
    const venv = process.platform === 'win32'
      ? join(this.config.engineRoot, '.venv', 'Scripts', 'python.exe')
      : join(this.config.engineRoot, '.venv', 'bin', 'python')
    candidates.push({ path: venv, why: `${this.config.engineRoot} 下的 .venv` })
    for (const name of ['python3', 'python']) {
      candidates.push({ path: name, why: `PATH 上的 ${name}` })
    }

    for (const candidate of candidates) {
      if (candidate.path === 'python' || candidate.path === 'python3') return candidate.path
      if (existsSync(candidate.path)) return candidate.path
    }
    throw new Error(
      `找不到可用的 Python 解释器。请设置插件配置 pythonPath，或先按 CG_GUI/README.txt 用 launcher.py `
      + `准备 ${join(this.config.engineRoot, '.venv')}（需要 torch/transformers/scikit-learn/openai/PyYAML）。`,
    )
  }

  // ============================== 进程生命周期 ==============================

  /** 启动常驻桥接进程（已启动则直接返回）。子进程环境经过凭据清洗。 */
  async start() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child

    const python = this.resolvePython()
    const args = [
      '-u',                                    // 无缓冲：行式协议要求及时 flush
      BRIDGE_SCRIPT,
      '--serve',
      '--engine-root', this.config.engineRoot,
      '--device', this.config.device,
    ]
    if (!this.config.useGuiSettings) args.push('--no-settings')

    // 关键：清洗父环境后交给子进程。凭据不在这里，而是随请求走 stdin。
    const env = await buildChildEnv({
      pattern: this.config.sensitiveEnvPattern || undefined,
      explicit: { PYTHONIOENCODING: 'utf-8' },
    })

    this.logger?.debug?.(`[calibguard] 启动桥接：${python} ${args.join(' ')}`)
    const child = spawn(python, args, {
      cwd: this.config.engineRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.startedAt = Date.now()
    this.stopping = false

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) this.#onLine(line)
        index = buffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const raw of String(chunk).split('\n')) {
        const line = raw.trim()
        if (!line) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
        this.logger?.debug?.(`[calibguard/python] ${line}`)
      }
    })

    child.on('error', (error) => this.#onExit(null, error))
    child.on('exit', (code, signal) => this.#onExit(code, null, signal))

    this.#touchIdle()
    return child
  }

  /** 处理子进程退出：拒绝在途请求，标记可重启。 */
  #onExit(code, error, signal) {
    const wasStopping = this.stopping
    this.child = null
    this.lastExit = { code, signal, error: error ? String(error.message ?? error) : null, at: Date.now() }
    const tail = this.stderrTail.join(' | ')
    const detail = error
      ? `桥接进程启动失败：${error.message ?? error}`
      : `桥接进程退出（code=${code}${signal ? `, signal=${signal}` : ''}）`
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(tail ? `${detail}；stderr: ${tail}` : detail))
    }
    this.pending.clear()
    if (!wasStopping) this.logger?.warn?.(`[calibguard] ${detail}`)
  }

  /** 解析一行响应，唤醒对应请求。 */
  #onLine(line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      this.logger?.debug?.(`[calibguard] 忽略非 JSON 输出：${line.slice(0, 200)}`)
      return
    }
    const entry = this.pending.get(payload.id)
    if (!entry) {
      this.logger?.debug?.(`[calibguard] 收到未知 id 的响应：${String(payload.id)}`)
      return
    }
    this.pending.delete(payload.id)
    clearTimeout(entry.timer)
    if (payload.ok) entry.resolve(payload.result)
    else {
      const error = new Error(payload.error?.message ?? '桥接返回未知错误')
      error.name = payload.error?.type ?? 'CalibGuardBridgeError'
      entry.reject(error)
    }
  }

  /**
   * 发一条请求并等待响应（自动串行化、自动启动、自动超时）。
   *
   * @param {string} op   桥接 op（status / audit / ping）
   * @param {object} payload 请求体（id 由本类注入）
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   */
  request(op, payload = {}, { timeoutMs, signal } = {}) {
    const run = () => this.#send(op, payload, { timeoutMs, signal })
    const next = this.chain.then(run, run)
    // 链本身不因单次失败而断掉
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  async #send(op, payload, { timeoutMs, signal }) {
    if (signal?.aborted) throw new Error('调用已被取消')
    const child = await this.start()
    const id = `cg-${this.nextId++}`
    const effectiveTimeout = timeoutMs
      ?? (op === 'audit' ? this.config.auditTimeoutMs : STATUS_TIMEOUT_MS)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(
          `CalibGuard 桥接超时（${Math.round(effectiveTimeout / 1000)}s，op=${op}）。`
          + `首次审计需加载模型，可用 config.auditTimeoutMs 放宽上限。`,
        ))
      }, effectiveTimeout)
      if (typeof timer.unref === 'function') timer.unref()

      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('调用已被取消'))
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener?.('abort', onAbort); resolve(value) },
        reject: (error) => { signal?.removeEventListener?.('abort', onAbort); reject(error) },
        timer,
      })

      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`向桥接进程写入失败：${error?.message ?? error}`))
      }
      this.#touchIdle()
    })
  }

  /** 重置空闲回收计时器。 */
  #touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.config.idleShutdownMs) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.stop('空闲回收').catch(() => {})
    }, this.config.idleShutdownMs)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  // ============================== 业务接口 ==============================

  /** op=status：引擎/模型/校准/设备/LLM 可用性快照。 */
  async inspect({ signal } = {}) {
    await this.ensureEnvironment()
    const options = await this.#prepare({})
    const result = await this.request('status', { options }, { timeoutMs: STATUS_TIMEOUT_MS, signal })
    this.statusCache = { ...result, at: Date.now() }
    return result
  }

  /** op=audit：审计若干文件或目录。 */
  async audit(paths, options = {}, { signal } = {}) {
    await this.ensureEnvironment()
    const merged = await this.#prepare(options)
    const result = await this.request('audit', { paths, options: merged }, {
      timeoutMs: this.config.auditTimeoutMs,
      signal,
    })
    this.statusCache = null
    return result
  }

  /** 主动停机（插件卸载或空闲回收）。 */
  async stop(reason = 'dispose') {
    // 卸载时若仍在后台装环境，先中止（否则 DSH 退出后仍会挂着 node setup.mjs）
    this.bootstrap?.dispose?.()
    if (!this.child) return
    this.stopping = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    const child = this.child
    try {
      child.stdin.write(`${JSON.stringify({ id: 'shutdown', op: 'shutdown' })}\n`)
    } catch { /* 管道可能已关闭，忽略 */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        resolve()
      }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    this.logger?.debug?.(`[calibguard] 桥接已停止（${reason}）`)
  }

  /** 运行状态（供 status 工具与诊断使用）。 */
  diagnostics() {
    return {
      running: Boolean(this.child),
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      pendingRequests: this.pending.size,
      lastExit: this.lastExit,
      credential: { ...this.lastCredential },
      credentialRef: this.config.credentialRef || null,
      credentialWritable: typeof this.credentials?.set === 'function',
      environment: this.bootstrap.snapshot(),
      settings: this.settings(),
      stderrTail: [...this.stderrTail],
    }
  }
}
