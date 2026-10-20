/**
 * 端到端集成测试：真的拉起 Python 桥接、真的加载 CodeBERT、真的审计样本文件。
 *
 * 覆盖本次实现中最关键的一处修复：**低算力显卡必须回落 CPU**。
 * 开发测试机是 GTX 1060（算力 6.1 < cu128 轮子要求的 7.5），若不做定档，
 * 引擎会挑中 CUDA 并在每个文件上抛 "no kernel image is available"，
 * 而引擎的安全降级会把它伪装成「每份文件都转人工」——看似成功，实则零判别力。
 * 因此这里显式断言：结果里不得出现 CUDA 内核错误。
 *
 * 依赖：`<engineRoot>/.venv`（torch + transformers + scikit-learn + openai + PyYAML）。
 * 缺失时整体跳过（skip），不算失败。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { CalibGuardEngine } from '../lib/engine.js'
import { buildTools } from '../lib/tools.js'

const config = normalizeConfig(undefined)
const pythonPath = process.platform === 'win32'
  ? join(config.engineRoot, '.venv', 'Scripts', 'python.exe')
  : join(config.engineRoot, '.venv', 'bin', 'python')
const ready = existsSync(pythonPath) && existsSync(join(config.engineRoot, 'models', 'codebert_finetuned'))
const skip = ready ? false : `缺少引擎环境（${pythonPath} 或模型权重），跳过端到端测试`

const reportDir = mkdtempSync(join(tmpdir(), 'calibguard-dsh-test-'))
/** 测试期间保持安静（桥接自身日志由 TMP 报告与断言覆盖）。 */
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {} }
const engine = new CalibGuardEngine({
  config: { ...config, reportDir, idleShutdownMs: 0 },
  logger: silentLogger,
})

after(async () => {
  await engine.stop('test teardown')
  rmSync(reportDir, { recursive: true, force: true })
})

test('status：引擎就绪，设备定档与显卡算力自洽', { skip }, async () => {
  const status = await engine.inspect()
  assert.equal(status.engineRoot, config.engineRoot)
  assert.equal(status.modelPresent, true)
  assert.equal(status.calibrationPresent, true)
  assert.equal(status.engineVersion, '1.0.0')
  assert.ok(['cpu', 'cuda'].includes(status.device))

  const policy = status.devicePolicy
  assert.ok(policy && typeof policy.reason === 'string')
  const computeCap = policy.computeCap
  if (Array.isArray(computeCap)) {
    const supported = computeCap[0] > 7 || (computeCap[0] === 7 && computeCap[1] >= 5)
    assert.equal(
      status.device,
      supported ? status.device : 'cpu',
      `算力 ${computeCap.join('.')} 不满足 cu128 要求时必须回落 CPU，实际 ${status.device}`,
    )
    if (!supported) assert.equal(policy.mode, 'cpu')
  }
})

test('凭据经请求下发到桥接：配置凭据后 status 报 configured', { skip }, async () => {
  // 凭据不走子进程环境变量/argv，而是随请求 options 走 stdin；
  // 这条用例证明该通路真的把 Key 送进了引擎配置。
  const keyed = new CalibGuardEngine({
    config: { ...config, reportDir, llmApiKey: 'sk-test-placeholder-not-a-real-key' },
    logger: silentLogger,
  })
  try {
    const status = await keyed.inspect()
    assert.equal(status.llm.configured, true, 'Key 应随请求送达桥接并被引擎配置采纳')
    assert.equal(keyed.diagnostics().credential.source, 'config.llmApiKey')
  } finally {
    await keyed.stop('test teardown')
  }
  // 未配置凭据的引擎（共享 engine）不应凭空出现 Key
  const plain = await engine.inspect()
  assert.equal(plain.llm.configured, false, '未配置凭据时不应继承宿主环境里的 Key')
})

test('共享设置参与合并：GUI 保存的阈值对工具调用生效，调用级参数仍可覆盖', { skip }, async () => {
  const settingsStore = { get: () => ({ allowThreshold: 0.02, blockThreshold: 0.98 }) }
  const shared = new CalibGuardEngine({
    config: { ...config, reportDir, idleShutdownMs: 0 },
    logger: silentLogger,
    settingsStore,
  })
  try {
    const status = await shared.inspect()
    assert.equal(status.gate.allowThreshold, 0.02, '共享设置应覆盖插件配置默认值')
    assert.equal(status.gate.blockThreshold, 0.98)

    const result = await shared.audit(
      [join(config.engineRoot, 'samples', 'benign_tool.py')],
      { allowThreshold: 0.4 },
      {},
    )
    assert.equal(result.config.allowThreshold, 0.4, '调用级参数应覆盖共享设置')
    assert.equal(result.config.blockThreshold, 0.98, '未覆盖的项仍用共享设置')
  } finally {
    await shared.stop('test teardown')
  }
})

test('status：真实返回字段与 STATUS_OUTPUT_SCHEMA 严格对齐', { skip }, async () => {
  // DSH 用 additionalProperties:false 严格校验工具返回值：schema 少一个字段就会被拒收
  //（本插件第一次上线时正是漏了 modelDir / loadedAt 两个字段而被拦下）。
  const tools = buildTools({ engine, config: { ...config, reportDir } })
  const statusTool = tools[1]
  const value = await statusTool.execute({}, {})
  const declared = statusTool.output.schema.properties

  for (const key of Object.keys(value)) {
    assert.ok(key in declared, `status 返回了 schema 未声明的字段：${key}`)
  }
  for (const [key, node] of Object.entries(declared)) {
    if (node.required === true) {
      assert.ok(key in value, `schema 声明 ${key} 必填，但 status 没返回`)
    }
  }
  assert.equal(statusTool.output.schema.additionalProperties, false)
})

test('audit：样本目录审计成功，且不出现 CUDA 内核错误', { skip }, async () => {
  const samples = join(config.engineRoot, 'samples')
  const result = await engine.audit([samples], {
    maxFiles: 3,
    includeEvidence: true,
    reportDir,
  })

  assert.equal(result.summary.total, 3)
  assert.equal(result.results.length, 3)
  assert.equal(result.config.reportDir, reportDir)

  for (const item of result.results) {
    assert.ok(['allow', 'suspicious', 'block', 'manual_review'].includes(item.final_decision))
    assert.ok(item.calibrated_probability >= 0 && item.calibrated_probability <= 1)
    assert.equal(
      /no kernel image|cudaErrorNoKernelImageForDevice/i.test(String(item.error ?? '')),
      false,
      `出现了 CUDA 内核错误（设备定档失效）：${item.error}`,
    )
    assert.equal(item.error, null, `样本文件不应产生处理异常：${item.error}`)
    assert.equal(existsSync(item.report_md_path), true, '报告 Markdown 应已落盘')
    assert.equal(existsSync(item.report_json_path), true, '报告 JSON 应已落盘')
  }

  const byName = new Map(result.results.map((item) => [item.file_path.split(/[\\/]/).pop(), item]))
  const benign = byName.get('benign_tool.py')
  const suspicious = byName.get('suspicious_demo.py')
  assert.ok(benign && suspicious, '样本文件应被全部审计到')
  assert.ok(
    benign.calibrated_probability < suspicious.calibrated_probability,
    `良性样本概率应低于可疑样本：${benign.calibrated_probability} vs ${suspicious.calibrated_probability}`,
  )
  assert.equal(benign.final_decision, 'allow', `良性样本应放行，实际 ${benign.final_decision}`)
  assert.notEqual(suspicious.final_decision, 'allow', '含危险信号的样本不应被放行')

  const evidence = suspicious.evidence
  assert.ok(evidence.network_indicators.includes('http://example.com/collect'))
  assert.ok(evidence.credential_access.includes('id_rsa'))
})

test('audit：目录展开上限生效并标记 truncated', { skip }, async () => {
  const result = await engine.audit([join(config.engineRoot, 'calibguard')], {
    maxFiles: 2,
    includeEvidence: false,
  })
  assert.equal(result.summary.total, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.results[0].evidence, undefined, 'includeEvidence=false 时不应回传证据')
})

test('audit：不存在的路径报结构化错误', { skip }, async () => {
  await assert.rejects(
    () => engine.audit([join(config.engineRoot, '__no_such_file__.py')], { maxFiles: 1 }),
    /路径不存在/,
  )
})

test('DSH 官方校验器：两个工具的真实返回值都能通过 output.schema', { skip }, async () => {
  // 这是「上线时被 DSH 拒收」那类问题的唯一可靠防线：
  // 用 DSH 自己的 defineTool 投影 schema，再用 DSH 自己的 validateJsonSchemaValue 校验真实返回值。
  const dsh = await import('@deepseek-ai/dsh-tools').catch(() => null)
  if (!dsh) return   // 没装 DSH 包时跳过（link-dsh.mjs 未跑）

  const tools = buildTools({ engine, config: { ...config, reportDir }, define: dsh.defineTool })
  const [auditTool, statusTool] = tools

  const auditValue = await auditTool.execute({ paths: [join(config.engineRoot, 'samples', 'benign_tool.py')] }, {})
  const auditViolations = dsh.validateJsonSchemaValue(auditTool.output.schema, auditValue, 'value')
  assert.deepEqual(auditViolations, [], `audit 返回值被 DSH 拒收：${auditViolations.join('; ')}`)

  const statusValue = await statusTool.execute({}, {})
  const statusViolations = dsh.validateJsonSchemaValue(statusTool.output.schema, statusValue, 'value')
  assert.deepEqual(statusViolations, [], `status 返回值被 DSH 拒收：${statusViolations.join('; ')}`)

  // 参数表在 defineTool 之后已经是投影好的 JSON Schema（DSH 注册期即用它发给模型）
  const auditParameters = auditTool.parameters
  assert.equal(auditParameters.type, 'object')
  assert.deepEqual(auditParameters.required, ['paths'])
  assert.equal(auditParameters.properties.paths.type, 'array')
  assert.equal(auditParameters.properties.paths.items.type, 'string')
  const statusParameters = statusTool.parameters
  assert.equal(statusParameters.type, 'object')
  // 无必填参数时投影结果会省略 required（而不是给空数组）
  assert.deepEqual(statusParameters.required ?? [], [])
  assert.deepEqual(Object.keys(statusParameters.properties), [])
})

test('工具层经真实引擎跑通：calibguard_audit → 文本摘要 + 报告', { skip }, async () => {
  const tools = buildTools({ engine, config: { ...config, reportDir } })
  const auditTool = tools[0]
  const value = await auditTool.execute(
    { paths: [join(config.engineRoot, 'samples', 'suspicious_demo.py')] },
    {},
  )
  assert.equal(value.summary.total, 1)
  const blocks = auditTool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /CalibGuard 审计完成：1 个文件/)
  const reportPath = value.results[0].report_json_path
  const parsed = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(parsed.file_path, value.results[0].file_path)
})
