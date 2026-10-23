/**
 * CalibGuard 的宿主 HTTP 路由 —— 给浏览器面板（lib/client.js）用。
 *
 * 三条路由（前缀 /api/calibguard）：
 *   GET  /status  → 引擎就绪快照（同 calibguard_status）
 *   POST /audit   → 审计；body 支持 { paths?|files?, options? }
 *                   files = [{ name, base64 }]（浏览器拖拽上传，落临时目录后审计，结束即删）
 *   GET  /report  → ?name=<report_id> 读回 Markdown 报告
 *
 * 设计取舍：
 *   - 不解析 multipart：浏览器把 File 读成 base64 放进 JSON（有体积上限），宿主侧零依赖；
 *   - 上传文件只写系统临时目录、审计完立即删除，不污染仓库；
 *   - 审计仍走同一个常驻桥接进程与同一份引擎配置（不复制任何审计逻辑）；
 *   - options 与工具参数共用 `validateAuditOptions`，两处行为一致。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { validateAuditOptions } from './tools.js'

/** 路由前缀（客户端面板与此保持一致）。 */
export const ROUTE_PREFIX = '/api/calibguard'

/** 请求体上限（base64 后约 +33%）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** 单次上传解码后的总字节上限。 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024
/** 单次上传的文件数上限。 */
const MAX_UPLOAD_FILES = 50
/** 报告 id 的合法形状（引擎用 uuid4().hex，截断/小写都接受）。 */
const REPORT_ID_PATTERN = /^[a-f0-9]{6,64}$/i

/** 文件名净化：只取 basename，替换 Windows 非法字符，防目录穿越。 */
function safeFileName(name) {
  const base = basename(String(name ?? '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim()
  return cleaned || 'upload.bin'
}

/** 写一条 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读请求体（带上限；超限抛错）。 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${Math.round(limit / 1024 / 1024)}MB`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 注册路由需要的信息。
 *
 * @param {object} options
 * @param {import('./engine.js').CalibGuardEngine} options.engine
 * @param {object} options.config 归一化插件配置
 * @param {object} [options.logger]
 * @param {object} options
 * @param {import('./engine.js').CalibGuardEngine} options.engine
 * @param {object} options.config 归一化插件配置
 * @param {object} [options.logger]
 * @param {import('./settings.js').SettingsStore} [options.settingsStore] GUI 与 AI 共用的设置
 * @returns {{routes: Array<{kind:'exact', path:string, handler:Function}>, state: object}}
 */
export function createCalibGuardRoutes({ engine, config, logger, settingsStore, pluginScanner }) {
  /** 最近一次审计的有效报告目录（用于 /report 校验范围）。 */
  const state = { lastReportDir: null }

  /** 只保留请求里出现的调用级参数（基础配置与共享设置由 engine 合并）。 */
  function requestOptions(raw) {
    const options = {}
    if (raw && typeof raw === 'object') {
      for (const key of ['allowThreshold', 'blockThreshold', 'llmEnabled', 'llmContentSource',
        'llmDeliveryMode', 'llmTruncateChars', 'llmWindowChars', 'llmWindowOverlap',
        'maxFiles', 'includeEvidence', 'windowStride']) {
        if (raw[key] !== undefined && raw[key] !== null) options[key] = raw[key]
      }
    }
    if (options.includeEvidence === undefined) options.includeEvidence = true
    validateAuditOptions(options)
    return options
  }

  /** GET /settings —— 读取 GUI 与 AI 共用的设置。 */
  async function handleGetSettings(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '仅支持 GET' })
    const info = settingsStore?.diagnostics?.() ?? { file: null, settings: {}, loadError: null }
    sendJson(res, 200, { ok: true, ...info })
  }

  /** PUT /settings —— 保存设置（全量替换；非法值 400 且不落盘）。 */
  async function handlePutSettings(req, res) {
    if (req.method !== 'PUT' && req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 PUT' })
    if (!settingsStore) return sendJson(res, 503, { error: '共享设置未启用（settingsStore 不可用）' })
    try {
      const body = await readBody(req, 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        return sendJson(res, 400, { error: '请求体必须是合法 JSON' })
      }
      const raw = payload && typeof payload === 'object' && payload.settings !== undefined
        ? payload.settings
        : payload
      const saved = settingsStore.save(raw)
      sendJson(res, 200, { ok: true, saved, file: settingsStore.file })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  /** 面板提示用：`node <setupScript> --reinstall-torch` 的绝对路径。 */
  const setupScript = join(config.packageRoot ?? '', 'setup.mjs')

  /** GET /status */
  async function handleStatus(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '仅支持 GET' })
    try {
      const environment = engine.environment?.() ?? null
      // 首次运行自动准备环境期间：返回进度（面板据此展示"准备中"），而不是报错
      if (environment && !environment.venvReady && environment.state !== 'ready') {
        const diagnostics = engine.diagnostics()
        return sendJson(res, 200, {
          ok: true,
          environment,
          status: null,
          credential: diagnostics.credential,
          credentialRef: diagnostics.credentialRef ?? null,
          credentialWritable: Boolean(diagnostics.credentialWritable),
          credentialStorage: diagnostics.credentialStorage ?? null,
          setupScript,
          torchJob: typeof engine.torchJobSnapshot === 'function' ? engine.torchJobSnapshot() : null,
          gpuTorch: typeof engine.gpuTorchStatus === 'function' ? engine.gpuTorchStatus() : null,
          pluginScan: typeof pluginScanner?.snapshot === 'function' ? pluginScanner.snapshot() : null,
          settings: engine.settings(),
          settingsFile: settingsStore?.file ?? null,
        })
      }
      const status = await engine.inspect()
      const diagnostics = engine.diagnostics()
      sendJson(res, 200, {
        ok: true,
        status,
        environment: environment ?? undefined,
        credential: diagnostics.credential,
        credentialRef: diagnostics.credentialRef ?? null,
        credentialWritable: Boolean(diagnostics.credentialWritable),
        credentialStorage: diagnostics.credentialStorage ?? null,
        setupScript,
        torchJob: typeof engine.torchJobSnapshot === 'function' ? engine.torchJobSnapshot() : null,
        gpuTorch: typeof engine.gpuTorchStatus === 'function' ? engine.gpuTorchStatus() : null,
        pluginScan: typeof pluginScanner?.snapshot === 'function' ? pluginScanner.snapshot() : null,
        settings: engine.settings(),
        settingsFile: settingsStore?.file ?? null,
      })
    } catch (error) {
      const environment = engine.environment?.() ?? null
      if (environment) {
        // 环境准备中/失败：把进度回给面板，避免用户只看到一句 500
        const diagnostics = engine.diagnostics()
        return sendJson(res, 200, {
          ok: true,
          environment,
          status: null,
          error: String(error?.message ?? error),
          credential: diagnostics.credential,
          credentialRef: diagnostics.credentialRef ?? null,
          credentialWritable: Boolean(diagnostics.credentialWritable),
          credentialStorage: diagnostics.credentialStorage ?? null,
          setupScript,
          torchJob: typeof engine.torchJobSnapshot === 'function' ? engine.torchJobSnapshot() : null,
          gpuTorch: typeof engine.gpuTorchStatus === 'function' ? engine.gpuTorchStatus() : null,
          pluginScan: typeof pluginScanner?.snapshot === 'function' ? pluginScanner.snapshot() : null,
          settings: engine.settings(),
          settingsFile: settingsStore?.file ?? null,
        })
      }
      logger?.warn?.(`[calibguard] UI status 失败：${error?.message ?? error}`)
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /** PUT /credential —— 面板「API Key → 保存」写进 DSH 凭据库（不落共享设置文件）。 */
  async function handleCredential(req, res) {
    if (req.method !== 'PUT' && req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 PUT' })
    try {
      const body = await readBody(req, 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        return sendJson(res, 400, { error: '请求体必须是合法 JSON' })
      }
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey : ''
      if (!apiKey.trim()) return sendJson(res, 400, { error: 'apiKey 不能为空' })
      // 凭据名可以由面板填写（不写死在代码里）；留空则用插件配置里的 credentialRef
      const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
      if (typeof engine.setCredential !== 'function') {
        return sendJson(res, 503, { error: '当前插件版本不支持写入凭据' })
      }
      const result = await engine.setCredential(apiKey, name || undefined)
      const ref = result && result.ref ? result.ref : null
      sendJson(res, 200, {
        ok: true,
        ...result,
        credentialRef: ref,
        credentialStorage: result && result.storage ? result.storage : null,
        settings: engine.settings(),
      })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  /** POST /install-torch —— 面板「重装 GPU/CPU 版 torch」。启动后台任务，进度走 /status 的 torchJob。 */
  async function handleInstallTorch(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' })
    try {
      const body = await readBody(req, 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        return sendJson(res, 400, { error: '请求体必须是合法 JSON' })
      }
      const mode = typeof payload?.mode === 'string' ? payload.mode : 'auto'
      if (typeof engine.installTorch !== 'function') {
        return sendJson(res, 503, { error: '当前插件版本不支持重装 torch' })
      }
      engine.installTorch(mode).catch((error) => {
        logger?.warn?.(`[calibguard] 重装 torch 失败：${error?.message ?? error}`)
      })
      sendJson(res, 200, { ok: true, started: true, mode })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  /** POST /scan-plugins —— 立即扫描其他 DSH 插件（mode=all|changed）。 */
  async function handleScanPlugins(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' })
    if (!pluginScanner || typeof pluginScanner.scanNow !== 'function') {
      return sendJson(res, 503, { error: '当前插件版本未启用其他插件扫描' })
    }
    try {
      const body = await readBody(req, 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        return sendJson(res, 400, { error: '请求体必须是合法 JSON' })
      }
      const mode = payload?.mode === 'changed' ? 'changed' : 'all'
      pluginScanner.scanNow(mode).catch((error) => {
        logger?.warn?.(`[calibguard] 扫描其他插件失败：${error?.message ?? error}`)
      })
      sendJson(res, 200, { ok: true, started: true, mode })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  /** POST /audit */
  async function handleAudit(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' })
    let tempDir
    try {
      const body = await readBody(req)
      let request
      try {
        request = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        return sendJson(res, 400, { error: '请求体必须是合法 JSON' })
      }
      const options = requestOptions(request.options)

      const paths = []
      if (Array.isArray(request.paths)) {
        for (const item of request.paths) {
          if (typeof item !== 'string' || item.trim() === '') {
            return sendJson(res, 400, { error: 'paths 里存在非法项' })
          }
          paths.push(item.trim())
        }
      }

      const files = Array.isArray(request.files) ? request.files : []
      if (files.length > MAX_UPLOAD_FILES) {
        return sendJson(res, 400, { error: `一次最多上传 ${MAX_UPLOAD_FILES} 个文件` })
      }
      if (files.length > 0) {
        let total = 0
        tempDir = mkdtempSync(join(tmpdir(), 'calibguard-ui-'))
        for (const file of files) {
          if (typeof file?.base64 !== 'string') {
            return sendJson(res, 400, { error: 'files[i].base64 必须是字符串' })
          }
          const buffer = Buffer.from(file.base64, 'base64')
          total += buffer.length
          if (total > MAX_UPLOAD_BYTES) {
            return sendJson(res, 400,
              { error: `上传总大小超过上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB` })
          }
          const target = join(tempDir, safeFileName(file.name))
          writeFileSync(target, buffer)
          paths.push(target)
        }
      }

      if (paths.length === 0) {
        return sendJson(res, 400, { error: '请拖入文件，或提供至少一个 paths 项' })
      }

      const result = await engine.audit(paths, options)
      if (result?.config?.reportDir) state.lastReportDir = result.config.reportDir
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      logger?.warn?.(`[calibguard] UI audit 失败：${error?.message ?? error}`)
      sendJson(res, 400, { error: String(error?.message ?? error) })
    } finally {
      if (tempDir) {
        try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结果 */ }
      }
    }
  }

  /** GET /report?name=<id> */
  async function handleReport(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '仅支持 GET' })
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const name = url.searchParams.get('name') ?? ''
      if (!REPORT_ID_PATTERN.test(name)) return sendJson(res, 400, { error: 'name 必须是报告 id（十六进制）' })
      const reportDir = state.lastReportDir
        || config.reportDir
        || join(config.engineRoot, 'reports')
      const file = join(reportDir, `${name}.md`)
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return sendJson(res, 404, { error: `报告不存在：${name}` })
      }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  return {
    state,
    routes: [
      { kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: handleStatus },
      { kind: 'exact', path: `${ROUTE_PREFIX}/install-torch`, handler: handleInstallTorch },
      { kind: 'exact', path: `${ROUTE_PREFIX}/scan-plugins`, handler: handleScanPlugins },
      { kind: 'exact', path: `${ROUTE_PREFIX}/audit`, handler: handleAudit },
      { kind: 'exact', path: `${ROUTE_PREFIX}/report`, handler: handleReport },
      { kind: 'exact', path: `${ROUTE_PREFIX}/settings`, handler: async (req, res) => {
        if (req.method === 'GET') return handleGetSettings(req, res)
        return handlePutSettings(req, res)
      } },
      { kind: 'exact', path: `${ROUTE_PREFIX}/credential`, handler: handleCredential },
    ],
  }
}
