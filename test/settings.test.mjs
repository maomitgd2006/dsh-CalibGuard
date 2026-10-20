/**
 * 共享设置单测：GUI 保存 → AI 工具共用（同一个存储、同一套校验）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { SettingsStore, defaultSettingsPath, pickSettings, validateSettings } from '../lib/settings.js'

const tempDirs = []

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'calibguard-settings-test-'))
  tempDirs.push(dir)
  return join(dir, 'settings.json')
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('默认路径在 $DSH_HOME 下（不写进仓库）', () => {
  const file = defaultSettingsPath()
  assert.match(file, /calibguard-settings\.json$/)
  assert.equal(file.includes('DSH_CG'), false)
})

test('文件不存在时初始为空设置', () => {
  const store = new SettingsStore({ file: tempFile() })
  assert.deepEqual(store.get(), {})
  assert.equal(store.loadError, null)
})

test('save 持久化并可重新加载（含原子写）', () => {
  const file = tempFile()
  const store = new SettingsStore({ file })
  const saved = store.save({ allowThreshold: 0.05, blockThreshold: 0.95, llmDeliveryMode: 'window', llmWindowChars: 2000, llmWindowOverlap: 200 })
  assert.deepEqual(saved, {
    allowThreshold: 0.05,
    blockThreshold: 0.95,
    llmDeliveryMode: 'window',
    llmWindowChars: 2000,
    llmWindowOverlap: 200,
  })
  assert.equal(existsSync(file), true)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /"allowThreshold": 0.05/)
  // 重新构造 = 模拟重启后读回
  const reloaded = new SettingsStore({ file })
  assert.deepEqual(reloaded.get(), saved)
})

test('白名单外键被忽略，非法值不落盘', () => {
  const file = tempFile()
  const store = new SettingsStore({ file })
  store.save({ allowThreshold: 0.1, reportDir: 'C:\\evil', llmApiKey: 'sk-should-not-be-here', foo: 1 })
  assert.deepEqual(store.get(), { allowThreshold: 0.1 })
  for (const bad of [
    { allowThreshold: 0.9, blockThreshold: 0.2 },
    { llmDeliveryMode: 'chunked' },
    { llmWindowChars: 100, llmWindowOverlap: 100 },
    'not-an-object',
  ]) {
    assert.throws(() => store.save(bad))
  }
  // 失败后原值保持不变
  assert.deepEqual(store.get(), { allowThreshold: 0.1 })
})

test('损坏的设置文件降级为空设置且记录错误', () => {
  const file = tempFile()
  writeFileSync(file, '{broken json', 'utf8')
  const store = new SettingsStore({ file })
  assert.deepEqual(store.get(), {})
  assert.match(store.loadError, /JSON|Unexpected/i)
})

test('reset 清空为「跟随插件配置」', () => {
  const file = tempFile()
  const store = new SettingsStore({ file })
  store.save({ maxFiles: 5 })
  assert.deepEqual(store.get(), { maxFiles: 5 })
  assert.deepEqual(store.reset(), {})
  assert.deepEqual(new SettingsStore({ file }).get(), {})
})

test('pickSettings/validateSettings 语义', () => {
  assert.deepEqual(pickSettings(null), {})
  assert.deepEqual(pickSettings({ allowThreshold: 0.1, nope: 1 }), { allowThreshold: 0.1 })
  assert.deepEqual(validateSettings({ llmEnabled: false }), { llmEnabled: false })
  assert.throws(() => validateSettings({ llmEnabled: 'yes' }), /llm_enabled 必须是布尔值/)
})

test('windowStride 不属于共享设置（只走工具参数/插件配置）', () => {
  const file = tempFile()
  const store = new SettingsStore({ file })
  // 面板不再管理该键：写入时被白名单静默丢弃，其余键正常保存
  assert.deepEqual(store.save({ windowStride: 510, maxFiles: 5 }), { maxFiles: 5 })
  assert.deepEqual(new SettingsStore({ file }).get(), { maxFiles: 5 })
})

test('LLM 端点/模型名纳入共享设置，并复刻 CG_GUI 的空值校验', () => {
  const file = tempFile()
  const store = new SettingsStore({ file })
  assert.deepEqual(
    store.save({ llmBaseUrl: 'https://example.invalid', llmModel: 'demo-model' }),
    { llmBaseUrl: 'https://example.invalid', llmModel: 'demo-model' },
  )
  assert.deepEqual(new SettingsStore({ file }).get(), {
    llmBaseUrl: 'https://example.invalid',
    llmModel: 'demo-model',
  })
  // 启用云端复核时端点/模型名不能为空（与 CG_GUI 前端同口径）
  assert.throws(() => store.save({ llmEnabled: true, llmBaseUrl: '' }), /Base URL 不能为空/)
  assert.throws(() => store.save({ llmEnabled: true, llmModel: '   ' }), /模型名称不能为空/)
  assert.throws(() => store.save({ llmBaseUrl: 42 }), /llmBaseUrl 必须是字符串/)
})
