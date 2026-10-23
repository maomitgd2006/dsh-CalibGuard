/**
 * 插件层单测：以假 ctx 验证 apply() 的注册行为（工具 / 服务 / 提示词 / 卸载清理）。
 * 不启动桥接子进程，纯注册路径；真实端到端见 bridge.test.mjs。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, Config, inject, name } from '../lib/index.js'

/** schemastery 只在装了 node_modules（或跑了 scripts/link-dsh.mjs）时才可解析。 */
const schemasteryAvailable = await import('@deepseek-ai/schemastery')
  .then(() => true)
  .catch(() => false)

/** 造一个记录注册行为的假 cordis ctx（含 effect 作用域，与真 cordis 语义一致）。 */
function fakeContext({ withSystemPrompt = true, credentials } = {}) {
  const registered = []
  const provided = []
  const sections = []
  const effects = []
  const listeners = new Map()
  const warnings = []
  const ctx = {
    logger: {
      info: () => {},
      debug: () => {},
      warn: (message) => warnings.push(String(message)),
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    provide(serviceName, value) {
      provided.push({ serviceName, value })
    },
    /** 与 cordis 的 Fiber.effect 同语义：立即执行，收集返回的 disposer。 */
    effect(execute, label) {
      const disposer = execute()
      effects.push({ disposer, label })
      return () => { const index = effects.findIndex((item) => item.disposer === disposer); if (index >= 0) effects.splice(index, 1) }
    },
    get(serviceName) {
      if (serviceName === 'systemPrompt' && withSystemPrompt) {
        return {
          getSectionOrder: (constant) => (constant === 'TOOL_BASH' ? 1000 : 0),
          section(section) {
            sections.push(section)
            return () => { sections.length = 0 }
          },
        }
      }
      if (serviceName === 'credentials') return credentials
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
  }
  return { ctx, registered, provided, sections, effects, listeners, warnings }
}

test('导出形状符合 cordis 插件约定', () => {
  assert.equal(name, 'calibguard')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  if (schemasteryAvailable) {
    assert.notEqual(Config, undefined, 'schemastery 可解析时应导出 Config')
    assert.equal(typeof Config?.['~standard']?.validate, 'function', 'Config 必须是 StandardSchemaV1')
  } else {
    assert.equal(Config, undefined, '拿不到 schemastery 时应退化为「无 Config」而不是报错')
  }
})

test('apply 注册三个工具并暴露 calibguard 服务', () => {
  const { ctx, registered, provided, sections } = fakeContext()
  apply(ctx, { announceToModel: true })
  assert.deepEqual(registered.map((item) => item.name).sort(), ['calibguard_audit', 'calibguard_configure', 'calibguard_status'])
  assert.equal(provided.length, 1)
  assert.equal(provided[0].serviceName, 'calibguard')
  for (const method of ['inspect', 'audit', 'bridgeOptions', 'diagnostics', 'dispose']) {
    assert.equal(typeof provided[0].value[method], 'function', `服务缺少方法 ${method}`)
  }
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'calibguard')
  assert.match(sections[0].text, /calibguard_audit/)
  assert.equal(sections[0].order, 1001)
})

test('服务暴露的 bridgeOptions 与配置一致', () => {
  const { ctx, provided } = fakeContext()
  apply(ctx, { maxFiles: 4 })
  const options = provided[0].value.bridgeOptions()
  assert.equal(options.maxFiles, 4)
  assert.equal(options.includeEvidence, true)
})

test('announceToModel=false 时不注册提示词片段', () => {
  const { ctx, sections, registered } = fakeContext()
  apply(ctx, { announceToModel: false })
  assert.equal(sections.length, 0)
  assert.equal(registered.length, 3)
})

test('缺少 systemPrompt 服务时只警告，不影响工具注册', () => {
  const { ctx, registered, warnings } = fakeContext({ withSystemPrompt: false })
  apply(ctx, { announceToModel: true })
  assert.equal(registered.length, 3)
  assert.equal(warnings.length, 0)
})

test('enabled=false 时什么都不注册', () => {
  const { ctx, registered, provided, sections } = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(registered.length, 0)
  assert.equal(provided.length, 0)
  assert.equal(sections.length, 0)
})

test('非法配置在 apply 阶段抛出（不会带病注册）', () => {
  const { ctx, registered } = fakeContext()
  assert.throws(() => apply(ctx, { device: 'tpu' }), /device 必须是/)
  assert.equal(registered.length, 0)
})

test('effect 作用域覆盖全部清理：工具撤销 + 桥接停机', async () => {
  const { ctx, registered, effects } = fakeContext()
  apply(ctx, {})
  // 三个工具的撤销 disposer + 提示词片段 disposer + 停桥接 disposer
  assert.equal(effects.length, 5)
  assert.deepEqual(
    effects.map((item) => item.label).sort(),
    [
      'calibguard:prompt-section',
      'calibguard:stop-bridge',
      'calibguard:unregister(calibguard_audit)',
      'calibguard:unregister(calibguard_configure)',
      'calibguard:unregister(calibguard_status)',
    ],
  )
  // 模拟 fiber 卸载：逆序执行 disposer
  for (const item of [...effects].reverse()) await item.disposer()
  assert.equal(registered.length, 0, 'fiber 卸载后工具应被撤销')
})

test('credentialRef 经 ctx.credentials 解析，且每次调用重新解析（不缓存）', async () => {
  let resolved = 0
  const credentials = {
    async resolve(ref) {
      resolved += 1
      assert.equal(ref, 'MY_TEST_REF', '应把配置里的引用名原样交给凭据服务')
      return { value: 'secret-from-store', source: 'file' }
    },
  }
  const { ctx, provided } = fakeContext({ credentials })
  apply(ctx, { credentialRef: 'MY_TEST_REF' })

  const service = provided.find((item) => item.serviceName === 'calibguard').value
  const first = await service.resolveCredential()
  assert.deepEqual(first, { key: 'secret-from-store', source: 'credentials:file' })
  const second = await service.resolveCredential()
  assert.deepEqual(second, { key: 'secret-from-store', source: 'credentials:file' })
  assert.equal(resolved, 2, '凭据必须每次操作重新解析，才能让轮换即时生效')
})

test('凭据服务缺席时按配置给出的名字读同名环境变量（仍然不硬编码）', async () => {
  const name = `CALIBGUARD_TEST_REF_${Date.now()}`
  process.env[name] = 'secret-from-env'
  try {
    const { ctx, provided } = fakeContext()
    apply(ctx, { credentialRef: name })
    const service = provided.find((item) => item.serviceName === 'calibguard').value
    const resolved = await service.resolveCredential()
    assert.equal(resolved.key, 'secret-from-env')
    assert.equal(resolved.source, `env:${name}`)
  } finally {
    delete process.env[name]
  }
})

test('未配置任何凭据时解析结果为空（不猜、不回退到宿主 Key）', async () => {
  const { ctx, provided } = fakeContext()
  apply(ctx, {})
  const service = provided.find((item) => item.serviceName === 'calibguard').value
  const resolved = await service.resolveCredential()
  assert.deepEqual(resolved, { key: undefined, source: 'none' })
})

test('llmApiKey 字面值优先于 credentialRef', async () => {
  let resolved = 0
  const credentials = { async resolve() { resolved += 1; return { value: 'x', source: 'file' } } }
  const { ctx, provided } = fakeContext({ credentials })
  apply(ctx, { credentialRef: 'REF', llmApiKey: 'literal-key' })
  const service = provided.find((item) => item.serviceName === 'calibguard').value
  const result = await service.resolveCredential()
  assert.deepEqual(result, { key: 'literal-key', source: 'config.llmApiKey' })
  assert.equal(resolved, 0, '有字面值时不应再调用凭据服务')
})

test('凭据引用未配置时给出告警并返回空（降级而非报错）', async () => {
  const credentials = { async resolve() { return undefined } }
  const { ctx, provided, warnings } = fakeContext({ credentials })
  apply(ctx, { credentialRef: 'MISSING_REF' })
  const service = provided.find((item) => item.serviceName === 'calibguard').value
  const result = await service.resolveCredential()
  assert.equal(result.key, undefined)
  assert.equal(result.source, 'credentials:missing')
  assert.equal(warnings.some((line) => line.includes('MISSING_REF')), true)
})
