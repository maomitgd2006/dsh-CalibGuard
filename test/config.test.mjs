/**
 * 配置层单测：默认值、覆盖、非法值拒绝、桥接 options 投影。
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import {
  DEFAULT_CONFIG,
  defaultEngineRoot,
  normalizeConfig,
  toBridgeOptions,
} from '../lib/config.js'

test('空配置 → 全部默认值，且引擎目录自动推导为同级 CG_GUI', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.engineRoot, defaultEngineRoot())
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(config.device, 'auto')
  assert.equal(config.maxFiles, 20)
  assert.equal(config.auditTimeoutMs, 600_000)
  assert.equal(config.allowThreshold, null)
  assert.equal(config.llmEnabled, null)
  assert.equal(config.packageRoot.endsWith('DSH_CG'), true)
})

test('显式配置覆盖默认值，并解析为绝对路径', () => {
  const config = normalizeConfig({
    enabled: false,
    device: 'cpu',
    maxFiles: 5,
    allowThreshold: 0.2,
    blockThreshold: 0.8,
    llmEnabled: false,
    llmApiKey: 'sk-test',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.device, 'cpu')
  assert.equal(config.maxFiles, 5)
  assert.equal(config.allowThreshold, 0.2)
  assert.equal(config.blockThreshold, 0.8)
  assert.equal(config.llmEnabled, false)
  assert.equal(config.llmApiKey, 'sk-test')
})

test('非法枚举被拒绝并给出中文说明', () => {
  assert.throws(() => normalizeConfig({ device: 'tpu' }), /device 必须是/)
  assert.throws(() => normalizeConfig({ llmContentSource: 'rawtext' }), /llmContentSource 必须是/)
  assert.throws(() => normalizeConfig({ llmDeliveryMode: 'chunked' }), /llmDeliveryMode 必须是/)
})

test('阈值越界 / 灰区倒置被拒绝', () => {
  assert.throws(() => normalizeConfig({ allowThreshold: 1.5 }), /allowThreshold 必须是/)
  assert.throws(() => normalizeConfig({ blockThreshold: 0 }), /blockThreshold 必须是/)
  assert.throws(
    () => normalizeConfig({ allowThreshold: 0.9, blockThreshold: 0.2 }),
    /灰区范围必须满足/,
  )
})

test('数值项范围校验', () => {
  assert.throws(() => normalizeConfig({ maxFiles: 0 }), /maxFiles 必须是/)
  assert.throws(() => normalizeConfig({ maxFiles: 999 }), /maxFiles 必须是/)
  assert.throws(() => normalizeConfig({ auditTimeoutMs: 10 }), /auditTimeoutMs 必须是/)
  assert.throws(() => normalizeConfig({ idleShutdownMs: -1 }), /idleShutdownMs 必须是/)
})

test('类型错误被拒绝', () => {
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled 必须是布尔值/)
  assert.throws(() => normalizeConfig({ engineRoot: 42 }), /engineRoot 必须是字符串/)
  assert.throws(() => normalizeConfig([]), /config 必须是对象/)
  assert.throws(() => normalizeConfig({ llmEnabled: 'true' }), /llmEnabled 必须是布尔值或留空/)
})

test('engineRoot 指向不存在的目录时报错并指明原因', () => {
  assert.throws(
    () => normalizeConfig({ engineRoot: 'D:\\__no_such_engine__' }),
    /引擎目录不存在/,
  )
})

test('toBridgeOptions 只投影用户显式设置过的项', () => {
  const config = normalizeConfig({ maxFiles: 3 })
  const options = toBridgeOptions(config)
  assert.equal(options.maxFiles, 3)
  assert.equal(options.includeEvidence, true)
  assert.equal('allowThreshold' in options, false)
  assert.equal('llmEnabled' in options, false)
  assert.equal('reportDir' in options, false)
})

test('默认引擎目录确实存在（本地环境自检）', () => {
  const root = defaultEngineRoot()
  // 默认推导为「本包的同级 CG_GUI」；单独 clone 本包时这里会失败，属环境问题而非代码问题
  assert.equal(existsSync(root), true, `默认引擎目录不存在：${root}（可用配置项 engineRoot 指定）`)
  assert.equal(existsSync(`${root}/calibguard`), true)
})
