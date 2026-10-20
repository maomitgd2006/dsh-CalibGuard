/**
 * 宿主 UI 路由单测：用假 req/res 与假 engine 验证三条路由的行为。
 *
 * 重点覆盖：请求体校验、base64 上传落临时目录并在结束后删除、options 合并与校验、
 * 报告读取的路径限制（防目录穿越）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Readable } from 'node:stream'

import { normalizeConfig } from '../lib/config.js'
import { ROUTE_PREFIX, createCalibGuardRoutes } from '../lib/routes.js'
import { SettingsStore } from '../lib/settings.js'

const config = normalizeConfig(undefined)

/** 造一个记录调用的假 engine。 */
function fakeEngine(overrides = {}) {
  const calls = []
  return {
    calls,
    settings() { return overrides.settings ?? {} },
    async inspect() {
      calls.push({ kind: 'inspect' })
      return overrides.status ?? {
        engineRoot: config.engineRoot,
        device: 'cpu',
        gate: { allowThreshold: 0.15, blockThreshold: 0.85 },
        llm: { enabled: true, configured: true },
      }
    },
    async audit(paths, options) {
      calls.push({ kind: 'audit', paths, options })
      return overrides.audit ?? {
        summary: { total: paths.length, allow: paths.length, block: 0, suspicious: 0, manual_review: 0, error: 0 },
        elapsedMs: 1,
        truncated: false,
        maxFiles: options.maxFiles,
        config: {
          allowThreshold: options.allowThreshold ?? 0.15,
          blockThreshold: options.blockThreshold ?? 0.85,
          llmEnabled: true,
          llmContentSource: 'evidence',
          llmDeliveryMode: 'truncate',
          llmTruncateChars: 3000,
          llmWindowChars: 3000,
          llmWindowOverlap: 500,
          reportDir: overrides.reportDir ?? 'C:\\no-such-report-dir',
        },
        results: [],
      }
    },
    async setCredential(value) {
      calls.push({ kind: 'setCredential', value })
      if (overrides.credentialError) throw new Error(overrides.credentialError)
      return { ref: 'TEST_REF', saved: true }
    },
    diagnostics() {
      return {
        credential: { source: 'credentials:env', configured: true },
        credentialRef: overrides.credentialRef ?? 'TEST_REF',
        credentialWritable: overrides.credentialWritable ?? true,
      }
    },
  }
}

/** 造一个假 res，收集状态码与响应体。 */
function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(chunk) { this.body = chunk === undefined ? this.body : String(chunk) },
  }
}

/** 造一个假 req（Readable 流 + method/url）。 */
function fakeRequest({ method = 'GET', url = '/', body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  stream.method = method
  stream.url = url
  return stream
}

function routeOf(routes, suffix) {
  const route = routes.find((item) => item.path === `${ROUTE_PREFIX}/${suffix}`)
  assert.ok(route, `缺少路由 ${suffix}`)
  return route
}

/** 跑一个 handler 并返回响应（等 handler 的 promise，若返回的话）。 */
async function invoke(handler, req) {
  const res = fakeResponse()
  await handler(req, res)
  return { res, json: res.headers?.['content-type']?.includes('json') ? JSON.parse(res.body) : undefined }
}

test('GET /status 返回引擎快照与凭据来源', async () => {
  const engine = fakeEngine()
  const { routes } = createCalibGuardRoutes({ engine, config })
  const { res, json } = await invoke(routeOf(routes, 'status').handler, fakeRequest())
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.status.device, 'cpu')
  assert.equal(json.credential.configured, true)
})

test('非 GET 访问 /status 返回 405', async () => {
  const { routes } = createCalibGuardRoutes({ engine: fakeEngine(), config })
  const { res } = await invoke(routeOf(routes, 'status').handler, fakeRequest({ method: 'POST' }))
  assert.equal(res.statusCode, 405)
})

test('POST /audit：paths + options 透传，阈值被采纳', async () => {
  const engine = fakeEngine()
  const { routes } = createCalibGuardRoutes({ engine, config })
  const body = JSON.stringify({
    paths: ['D:\\a.py'],
    options: { allowThreshold: 0.05, blockThreshold: 0.95, llmDeliveryMode: 'window', llmWindowChars: 2000, llmWindowOverlap: 200 },
  })
  const { res, json } = await invoke(routeOf(routes, 'audit').handler, fakeRequest({ method: 'POST', body }))
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  const call = engine.calls.find((item) => item.kind === 'audit')
  assert.deepEqual(call.paths, ['D:\\a.py'])
  assert.equal(call.options.allowThreshold, 0.05)
  assert.equal(call.options.blockThreshold, 0.95)
  assert.equal(call.options.llmDeliveryMode, 'window')
  assert.equal(call.options.llmWindowChars, 2000)
  assert.equal(call.options.llmWindowOverlap, 200)
  assert.equal(call.options.includeEvidence, true)
})

test('POST /audit：base64 文件落临时目录，审计结束后目录被删除', async () => {
  let seenPath = null
  const engine = fakeEngine()
  const originalAudit = engine.audit
  engine.audit = async (paths, options) => {
    seenPath = paths[0]
    assert.equal(existsSync(seenPath), true, '审计期间临时文件应存在')
    return originalAudit(paths, options)
  }
  const { routes } = createCalibGuardRoutes({ engine, config })
  const body = JSON.stringify({
    files: [{ name: '../../evil name.py', base64: Buffer.from('print(1)\n').toString('base64') }],
  })
  const { res, json } = await invoke(routeOf(routes, 'audit').handler, fakeRequest({ method: 'POST', body }))
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.ok(seenPath, 'engine.audit 应被调用')
  assert.equal(String(seenPath).includes('..'), false, '文件名中的路径穿越必须被去掉')
  assert.match(seenPath, /evil name\.py$/, 'basename 应保留（空格是合法文件名字符），但目录部分必须去掉')
  assert.equal(existsSync(seenPath), false, '审计结束后临时文件应被删除')
})

test('POST /audit：非法 options 返回 400（阈值倒置/越界）', async () => {
  const { routes } = createCalibGuardRoutes({ engine: fakeEngine(), config })
  const cases = [
    { options: { allowThreshold: 0.9, blockThreshold: 0.2 } },
    { options: { allowThreshold: 1.5 } },
    { options: { llmDeliveryMode: 'chunked' } },
    { options: { llmTruncateChars: 0 } },
    { options: { llmWindowChars: 100, llmWindowOverlap: 100 } },
  ]
  for (const payload of cases) {
    const { res } = await invoke(routeOf(routes, 'audit').handler,
      fakeRequest({ method: 'POST', body: JSON.stringify(payload) }))
    assert.equal(res.statusCode, 400, `应拒绝：${JSON.stringify(payload)}`)
  }
})

test('POST /audit：空请求与非法 JSON 都返回 400', async () => {
  const { routes } = createCalibGuardRoutes({ engine: fakeEngine(), config })
  const empty = await invoke(routeOf(routes, 'audit').handler, fakeRequest({ method: 'POST', body: '{}' }))
  assert.equal(empty.res.statusCode, 400)
  const broken = await invoke(routeOf(routes, 'audit').handler, fakeRequest({ method: 'POST', body: '{oops' }))
  assert.equal(broken.res.statusCode, 400)
})

test('GET /report：非法 name 返回 400，缺失报告返回 404', async () => {
  const { routes } = createCalibGuardRoutes({ engine: fakeEngine(), config })
  const handler = routeOf(routes, 'report').handler
  const bad = await invoke(handler, fakeRequest({ url: '/api/calibguard/report?name=..%2F..%2Fetc%2Fpasswd' }))
  assert.equal(bad.res.statusCode, 400, '防目录穿越')
  const missing = await invoke(handler, fakeRequest({ url: '/api/calibguard/report?name=deadbeef' }))
  assert.equal(missing.res.statusCode, 404)
})

test('GET/PUT /settings：GUI 保存的共享设置可读回，非法值 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calibguard-routes-settings-'))
  const settingsStore = new SettingsStore({ file: join(dir, 'settings.json') })
  try {
    const { routes } = createCalibGuardRoutes({ engine: fakeEngine(), config, settingsStore })
    const handler = routeOf(routes, 'settings').handler

    const initial = await invoke(handler, fakeRequest())
    assert.equal(initial.res.statusCode, 200)
    assert.deepEqual(initial.json.settings, {})
    assert.match(String(initial.json.file), /settings\.json$/)

    const put = await invoke(handler, fakeRequest({
      method: 'PUT',
      body: JSON.stringify({
        allowThreshold: 0.05,
        blockThreshold: 0.95,
        llmDeliveryMode: 'window',
        llmBaseUrl: 'https://example.invalid',
        llmModel: 'demo-model',
      }),
    }))
    assert.equal(put.res.statusCode, 200)
    assert.deepEqual(put.json.saved, {
      allowThreshold: 0.05,
      blockThreshold: 0.95,
      llmDeliveryMode: 'window',
      llmBaseUrl: 'https://example.invalid',
      llmModel: 'demo-model',
    })

    const reloaded = await invoke(handler, fakeRequest())
    assert.deepEqual(reloaded.json.settings, put.json.saved)

    const bad = await invoke(handler, fakeRequest({ method: 'PUT', body: JSON.stringify({ allowThreshold: 2 }) }))
    assert.equal(bad.res.statusCode, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status 响应里带出共享设置（面板回填用）', async () => {
  const settingsStore = { file: 'X:\\settings.json', diagnostics: () => ({ file: 'X:\\settings.json', settings: {}, loadError: null }) }
  const engine = fakeEngine({ settings: { allowThreshold: 0.02 } })
  const { routes } = createCalibGuardRoutes({ engine, config, settingsStore })
  const { json } = await invoke(routeOf(routes, 'status').handler, fakeRequest())
  assert.deepEqual(json.settings, { allowThreshold: 0.02 })
  assert.equal(json.settingsFile, 'X:\\settings.json')
  assert.equal(json.credentialRef, 'TEST_REF')
  assert.equal(json.credentialWritable, true)
})

test('PUT /credential：写入 DSH 凭据库（不落共享设置文件）', async () => {
  const engine = fakeEngine()
  const { routes } = createCalibGuardRoutes({ engine, config })
  const handler = routeOf(routes, 'credential').handler
  const ok = await invoke(handler, fakeRequest({
    method: 'PUT',
    body: JSON.stringify({ apiKey: 'sk-test-value' }),
  }))
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.saved, true)
  const call = engine.calls.find((item) => item.kind === 'setCredential')
  assert.equal(call.value, 'sk-test-value')

  const empty = await invoke(handler, fakeRequest({ method: 'PUT', body: JSON.stringify({ apiKey: '  ' }) }))
  assert.equal(empty.res.statusCode, 400)
  const wrongMethod = await invoke(handler, fakeRequest({ method: 'GET' }))
  assert.equal(wrongMethod.res.statusCode, 405)
})

test('PUT /credential：凭据库不可写时返回 400 与可读原因', async () => {
  const engine = fakeEngine({ credentialError: '当前环境不支持写入凭据库：请在 DSH Models 页配置' })
  const { routes } = createCalibGuardRoutes({ engine, config })
  const { res, json } = await invoke(routeOf(routes, 'credential').handler,
    fakeRequest({ method: 'PUT', body: JSON.stringify({ apiKey: 'sk-x' }) }))
  assert.equal(res.statusCode, 400)
  assert.match(json.error, /Models 页/)
})
