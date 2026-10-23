/**
 * 工具层单测：定义形状（参数/输出 schema）、渲染输出、执行路径。
 * 用假引擎替代真实桥接，保证快速、无副作用。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

/** 造一个记录调用的假引擎。 */
function fakeEngine(overrides = {}) {
  const calls = []
  return {
    calls,
    audit: async (paths, options, runOptions) => {
      calls.push({ kind: 'audit', paths, options, runOptions })
      return overrides.audit ?? {
        summary: { total: 1, allow: 1, block: 0, suspicious: 0, manual_review: 0, error: 0 },
        elapsedMs: 12,
        truncated: false,
        maxFiles: 20,
        config: {
          allowThreshold: 0.15,
          blockThreshold: 0.85,
          llmEnabled: false,
          llmContentSource: 'evidence',
          llmDeliveryMode: 'truncate',
          llmTruncateChars: 3000,
          llmWindowChars: 3000,
          llmWindowOverlap: 500,
          windowStride: 256,
          reportDir: 'X:\\r',
        },
        results: [sampleResult()],
      }
    },
    inspect: async () => {
      calls.push({ kind: 'inspect' })
      return overrides.status ?? sampleStatus()
    },
    settingsView: () => ({ ...(overrides.settings ?? {}) }),
    saveSharedSettings: (raw) => {
      calls.push({ kind: 'saveSettings', raw })
      return overrides.savedSettings ?? { ...raw }
    },
    resetSharedSettings: () => {
      calls.push({ kind: 'resetSettings' })
      return {}
    },
  }
}

/** 一条最小可用的审计结果（字段与 bridge 的 _trim_report 对齐）。 */
function sampleResult(overrides = {}) {
  return {
    file_path: 'D:\\CG\\CG_GUI\\samples\\suspicious_demo.py',
    file_size_bytes: 407,
    file_sha256: '11d18d88f1b89fc9',
    source_type: 'text',
    archive_parts: 1,
    raw_logit: 2.8,
    calibrated_probability: 0.9312,
    gate_decision: 'block',
    final_decision: 'block',
    manual_review_required: false,
    consistency_warning: false,
    windows_evaluated: 1,
    early_stopped: false,
    llm_calls: 0,
    llm: null,
    evidence: {
      dangerous_apis: [],
      network_indicators: ['http://example.com/collect'],
      credential_access: ['.ssh', 'id_rsa'],
      obfuscation_signals: ['base64.b64decode('],
      file_operations: [],
      injection_phrases: [],
      high_entropy_strings: [],
      long_line_numbers: [],
      random_identifier_count: 0,
    },
    report_json_path: 'X:\\r\\a.json',
    report_md_path: 'X:\\r\\a.md',
    error: null,
    ...overrides,
  }
}

function sampleStatus(overrides = {}) {
  return {
    engineRoot: 'D:\\CG\\CG_GUI',
    engineVersion: '1.0.0',
    python: '3.10.8',
    torch: '2.11.0+cu128',
    cudaAvailable: true,
    device: 'cpu',
    devicePolicy: { mode: 'cpu', reason: '算力 6.1 低于 7.5' },
    modelPresent: true,
    modelBytes: 498_612_824,
    calibrationPresent: true,
    calibration: { method: 'platt', n_samples: 25049 },
    settingsSource: 'engine-defaults',
    settingsError: null,
    loaded: false,
    auditCount: 0,
    gate: { allowThreshold: 0.15, blockThreshold: 0.85, earlyStopThreshold: 0.9 },
    llm: { enabled: true, configured: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    performance: {
      windowsPerSecond: 3.56,
      lastAuditWindows: 16,
      lastAuditElapsedMs: 4500,
      windowStride: 256,
      windowBatchSize: 8,
      maxLength: 512,
    },
    reportDir: 'D:\\CG\\CG_GUI\\reports',
    ...overrides,
  }
}

const config = normalizeConfig(undefined)

test('注册三个工具，名称与必填参数正确', () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  assert.equal(tools.length, 3)
  const [audit, status] = tools
  assert.equal(audit.name, 'calibguard_audit')
  assert.equal(status.name, 'calibguard_status')
  assert.equal(audit.parameters.paths.required, true)
  assert.equal(audit.parameters.paths.type, 'array')
  assert.equal(audit.parameters.paths.items.type, 'string')
  assert.equal(audit.parameters.include_evidence.required, undefined)
  assert.deepEqual(status.parameters, {})
  assert.equal(typeof audit.execute, 'function')
  assert.equal(typeof audit.output.render, 'function')
  assert.equal(audit.timeoutMs, config.auditTimeoutMs)
  assert.equal(audit.isConcurrencySafe(), true)
})

test('输出 schema 覆盖 bridge 回传的全部字段（缺字段会被 DSH 校验拦下）', async () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  const audit = tools[0]
  const properties = audit.output.schema.properties
  assert.equal(audit.output.schema.additionalProperties, false)
  const itemSchema = properties.results.items
  assert.equal(itemSchema.additionalProperties, false)

  const value = await audit.execute({ paths: ['a.py'] }, { signal: undefined })
  for (const key of Object.keys(value)) {
    assert.ok(key in properties, `输出根字段 ${key} 未在 schema 中声明`)
  }
  for (const key of Object.keys(value.results[0])) {
    assert.ok(key in itemSchema.properties, `结果字段 ${key} 未在 schema 中声明`)
  }
  // schema 声明的必填字段必须真的存在
  for (const [key, node] of Object.entries(itemSchema.properties)) {
    if (node.required === true) {
      assert.ok(key in value.results[0], `schema 要求 ${key} 必填，但结果里没有`)
    }
  }
})

test('audit 把相对路径解析为绝对路径，只传调用级参数', async () => {
  const engine = fakeEngine()
  const tools = buildTools({ engine, config })
  await tools[0].execute({ paths: ['samples/demo.py', 'D:\\abs\\x.py'] }, {})
  const call = engine.calls[0]
  assert.equal(call.paths[0].startsWith(process.cwd()), true)
  assert.equal(call.paths[1], 'D:\\abs\\x.py')
  assert.equal(call.options.includeEvidence, true)
  // 部署配置 / GUI 共享设置由 engine 合并，工具层不再重复发送
  assert.equal('maxFiles' in call.options, false)
  assert.equal('allowThreshold' in call.options, false)
  assert.equal('llmApiKey' in call.options, false)
  assert.equal('llmBaseUrl' in call.options, false)
  assert.equal('reportDir' in call.options, false)
})

test('audit 拒绝空路径与非法项', async () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  await assert.rejects(() => tools[0].execute({ paths: [] }, {}), /paths 必须是非空数组/)
  await assert.rejects(() => tools[0].execute({ paths: ['  '] }, {}), /非法项/)
  await assert.rejects(() => tools[0].execute({ paths: [7] }, {}), /非法项/)
})

test('max_files / include_evidence 参数生效', async () => {
  const engine = fakeEngine()
  const tools = buildTools({ engine, config })
  await tools[0].execute({ paths: ['d'], max_files: 7, include_evidence: false }, {})
  assert.equal(engine.calls[0].options.maxFiles, 7)
  assert.equal(engine.calls[0].options.includeEvidence, false)
})

test('render 输出人类可读摘要（含决策标签、证据与报告路径）', async () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  const blocks = tools[0].output.render({}, {
    summary: { total: 2, allow: 1, block: 1, suspicious: 0, manual_review: 0, error: 0 },
    elapsedMs: 2500,
    truncated: true,
    maxFiles: 2,
    config: { allowThreshold: 0.15, blockThreshold: 0.85, llmEnabled: true, reportDir: 'X:\\r' },
    results: [sampleResult(), sampleResult({ final_decision: 'allow', gate_decision: 'allow', calibrated_probability: 0.02, evidence: null })],
  })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  const text = blocks[0].text
  assert.match(text, /CalibGuard 审计完成：2 个文件/)
  assert.match(text, /BLOCK 拦截/)
  assert.match(text, /ALLOW 放行/)
  assert.match(text, /证据: 网络: http:\/\/example\.com\/collect/)
  assert.match(text, /报告: X:\\r\\a\.md/)
  assert.match(text, /仅审计了前 2 个/)
})

test('render 对 LLM 复核与一致性告警有专门文案', () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  const blocks = tools[0].output.render({}, {
    summary: { total: 1, allow: 0, block: 0, suspicious: 1, manual_review: 0, error: 0 },
    elapsedMs: 100,
    truncated: false,
    maxFiles: 20,
    config: {
      allowThreshold: 0.15,
      blockThreshold: 0.85,
      llmEnabled: true,
      llmContentSource: 'raw',
      llmDeliveryMode: 'window',
      llmTruncateChars: 3000,
      llmWindowChars: 2000,
      llmWindowOverlap: 200,
      windowStride: 256,
      reportDir: '',
    },
    results: [sampleResult({
      final_decision: 'suspicious',
      consistency_warning: true,
      llm: { status: 'ok', risk: 'low', reason: '演示脚本', action: '人工确认', retries_used: 0 },
    })],
  })
  assert.match(blocks[0].text, /LLM: status=ok risk=low/)
  assert.match(blocks[0].text, /一致性告警/)
})

test('status 工具直接返回引擎快照并渲染就绪信息', async () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  const value = await tools[1].execute({}, {})
  assert.equal(value.device, 'cpu')
  const blocks = tools[1].output.render({}, value)
  assert.match(blocks[0].text, /CalibGuard 引擎状态：就绪/)
  assert.match(blocks[0].text, /定档 cpu：算力 6\.1/)
  assert.match(blocks[0].text, /未配置 API Key/)
})

test('defineTool 注入生效（用于获得 DSH 侧定义期校验）', () => {
  const seen = []
  const define = (definition) => { seen.push(definition.name); return definition }
  buildTools({ engine: fakeEngine(), config, define })
  assert.deepEqual(seen, ['calibguard_audit', 'calibguard_status', 'calibguard_configure'])
})

// ============================== 调用级参数覆盖（阈值/滑窗/截断） ==============================

test('调用级参数覆盖：阈值/送审模式/滑窗/截断都进入桥接 options', async () => {
  const engine = fakeEngine()
  const tools = buildTools({ engine, config })
  await tools[0].execute({
    paths: ['a.py'],
    allow_threshold: 0.05,
    block_threshold: 0.95,
    llm_enabled: false,
    llm_content_source: 'raw',
    llm_delivery_mode: 'window',
    truncate_chars: 1234,
    window_chars: 2048,
    window_overlap: 128,
    window_stride: 510,
  }, {})
  const options = engine.calls.find((item) => item.kind === 'audit').options
  assert.equal(options.allowThreshold, 0.05)
  assert.equal(options.blockThreshold, 0.95)
  assert.equal(options.llmEnabled, false)
  assert.equal(options.llmContentSource, 'raw')
  assert.equal(options.llmDeliveryMode, 'window')
  assert.equal(options.llmTruncateChars, 1234)
  assert.equal(options.llmWindowChars, 2048)
  assert.equal(options.llmWindowOverlap, 128)
  assert.equal(options.windowStride, 510)
})

test('调用级参数校验：非法阈值/枚举/长度被拒绝', async () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  const cases = [
    [{ allow_threshold: 0.9, block_threshold: 0.2 }, /阈值必须满足/],
    [{ allow_threshold: 1.2 }, /allow_threshold 必须是/],
    [{ block_threshold: 0 }, /block_threshold 必须是/],
    [{ llm_content_source: 'text' }, /llm_content_source 必须是/],
    [{ llm_delivery_mode: 'chunked' }, /llm_delivery_mode 必须是/],
    [{ truncate_chars: 0 }, /truncate_chars 必须是/],
    [{ window_chars: 100, window_overlap: 100 }, /window_overlap 必须小于/],
    [{ window_overlap: -1 }, /window_overlap 必须是/],
    [{ window_stride: 0 }, /window_stride 必须是/],
    [{ window_stride: 512 }, /window_stride 必须是/],
    [{ window_stride: 256.5 }, /window_stride 必须是/],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(
      () => tools[0].execute({ paths: ['a.py'], ...args }, {}),
      pattern,
      `应拒绝：${JSON.stringify(args)}`,
    )
  }
})

test('未给覆盖参数时行为与之前一致（不向桥接发送多余项）', async () => {
  const engine = fakeEngine()
  const tools = buildTools({ engine, config })
  await tools[0].execute({ paths: ['a.py'] }, {})
  const options = engine.calls.find((item) => item.kind === 'audit').options
  assert.equal('allowThreshold' in options, false)
  assert.equal('llmDeliveryMode' in options, false)
  assert.equal('llmTruncateChars' in options, false)
  assert.equal('llmWindowChars' in options, false)
})

test('render 摘要里带出本次送审口径', () => {
  const tools = buildTools({ engine: fakeEngine(), config })
  const blocks = tools[0].output.render({}, {
    summary: { total: 1, allow: 0, block: 0, suspicious: 1, manual_review: 0, error: 0 },
    elapsedMs: 100,
    truncated: false,
    maxFiles: 20,
    config: {
      allowThreshold: 0.05,
      blockThreshold: 0.95,
      llmEnabled: true,
      llmContentSource: 'raw',
      llmDeliveryMode: 'truncate',
      llmTruncateChars: 1234,
      llmWindowChars: 3000,
      llmWindowOverlap: 500,
      windowStride: 512,
      reportDir: '',
    },
    results: [sampleResult()],
  })
  assert.match(blocks[0].text, /阈值 0\.05\/0\.95/)
  assert.match(blocks[0].text, /送审 truncate\/1234字/)
  assert.match(blocks[0].text, /内容源 raw/)
  assert.match(blocks[0].text, /滑窗步长 512/)
})


test('calibguard_configure 注册且参数/输出 schema 正确', () => {
  const engine = fakeEngine()
  const tools = buildTools({ engine, config: normalizeConfig(undefined) })
  assert.deepEqual(tools.map((tool) => tool.name), ['calibguard_audit', 'calibguard_status', 'calibguard_configure'])
  const configure = tools.find((tool) => tool.name === 'calibguard_configure')
  assert.ok(configure.parameters.allow_threshold)
  assert.ok(configure.parameters.reset)
  assert.equal(configure.output.schema.properties.settings.type, 'json')
})

test('calibguard_configure 保存共享设置（合并现有值、可恢复默认）', async () => {
  const engine = fakeEngine({ settings: { llmEnabled: false, maxFiles: 10 } })
  const tools = buildTools({ engine, config: normalizeConfig(undefined) })
  const configure = tools.find((tool) => tool.name === 'calibguard_configure')
  const result = await configure.execute({ allow_threshold: 0.2, block_threshold: 0.9, max_files: 30 })
  assert.equal(result.ok, true)
  assert.deepEqual(engine.calls.at(-1).kind, 'saveSettings')
  assert.deepEqual(engine.calls.at(-1).raw, {
    llmEnabled: false,
    maxFiles: 30,
    allowThreshold: 0.2,
    blockThreshold: 0.9,
  })
  assert.ok(result.changed.some((item) => item.includes('maxFiles=30')))
  assert.ok(result.settings && result.settings.allowThreshold === 0.2)

  // 传 null = 恢复该键为默认（从共享设置里删除）
  const cleared = await configure.execute({ max_files: null })
  assert.equal(engine.calls.at(-1).raw.maxFiles, undefined)
  assert.equal(cleared.settings.maxFiles, undefined)
})

test('calibguard_configure 拒绝读取/写入 API Key', async () => {
  const engine = fakeEngine()
  const tools = buildTools({ engine, config: normalizeConfig(undefined) })
  const configure = tools.find((tool) => tool.name === 'calibguard_configure')
  await assert.rejects(() => configure.execute({ llm_api_key: 'sk-secret' }), /不读写 API Key/)
  await assert.rejects(() => configure.execute({ apiKey: 'sk-secret' }), /不读写 API Key/)
  // 没有任何写入发生
  assert.equal(engine.calls.some((call) => call.kind === 'saveSettings'), false)
})

test('calibguard_configure reset 清空共享设置', async () => {
  const engine = fakeEngine({ settings: { allowThreshold: 0.1 } })
  const tools = buildTools({ engine, config: normalizeConfig(undefined) })
  const configure = tools.find((tool) => tool.name === 'calibguard_configure')
  const result = await configure.execute({ reset: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.changed, ['reset'])
  assert.deepEqual(engine.calls.at(-1), { kind: 'resetSettings' })
  assert.equal(Object.keys(result.settings).length, 0)
})

test('calibguard_configure 输出永远不含 API Key（防泄漏兜底）', async () => {
  // 即使底层设置意外混入键值，sanitize 也会剔除
  const engine = fakeEngine({ settings: { llmEnabled: true, llmApiKey: 'sk-should-not-leak' } })
  const tools = buildTools({ engine, config: normalizeConfig(undefined) })
  const configure = tools.find((tool) => tool.name === 'calibguard_configure')
  const result = await configure.execute({ llm_enabled: true })
  const text = JSON.stringify(result)
  assert.equal(text.includes('sk-should-not-leak'), false)
  assert.equal(text.includes('llmApiKey'), false)
})
