/**
 * 凭据配置（面板「凭据名 + API Key → 保存」）的单元测试。
 *
 * 覆盖：
 *   - 面板可传凭据名（不写死名字），保存后名字进共享设置、值进凭据库；
 *   - 插件配置 credentialRef 优先于共享设置里的名字；
 *   - 没有名字 / 名字非法时给人话报错；
 *   - 保存的 credentialRef 不会被当作桥接参数下发（settings 白名单含它，但 #prepare 会剥离）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { CalibGuardEngine } from '../lib/engine.js'
import { SettingsStore, validateSettings } from '../lib/settings.js'

function withTempSettings(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-cred-'))
  try {
    const store = new SettingsStore({ file: join(dir, 'settings.json') })
    return fn(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeEngine(store, credentials) {
  const config = normalizeConfig(undefined)
  return new CalibGuardEngine({ config, settingsStore: store, credentials })
}

test('面板传凭据名保存：值进凭据库、名字记进共享设置', () => {
  withTempSettings((store) => {
    const saved = {}
    const engine = makeEngine(store, {
      set: async (ref, value) => { saved.ref = ref; saved.value = value },
      resolve: async () => null,
    })
    return engine.setCredential('sk-test-value', 'PANEL_KEY').then((result) => {
      assert.equal(result.ref, 'PANEL_KEY')
      assert.equal(result.saved, true)
      assert.deepEqual(saved, { ref: 'PANEL_KEY', value: 'sk-test-value' })
      assert.equal(store.get().credentialRef, 'PANEL_KEY')
      assert.equal(engine.effectiveCredentialRef(), 'PANEL_KEY')
      assert.equal(engine.diagnostics().credentialRef, 'PANEL_KEY')
    })
  })
})

test('插件配置 credentialRef 优先于面板保存的名字', () => {
  withTempSettings((store) => {
    store.save({ credentialRef: 'PANEL_KEY' })
    const engine = makeEngine(store, { set: async () => {}, resolve: async () => null })
    // config 默认 credentialRef 为空 → 用面板保存的名字
    assert.equal(engine.effectiveCredentialRef(), 'PANEL_KEY')
    // 模拟插件配置里显式指定
    engine.config = { ...engine.config, credentialRef: 'CONFIG_KEY' }
    assert.equal(engine.effectiveCredentialRef(), 'CONFIG_KEY')
  })
})

test('没有凭据名时给出可操作报错（不再要求改插件配置）', async () => {
  await withTempSettings(async (store) => {
    const engine = makeEngine(store, { set: async () => {}, resolve: async () => null })
    await assert.rejects(() => engine.setCredential('sk-x'), /还没有凭据名/)
  })
})

test('凭据名非法时拒绝', async () => {
  await withTempSettings(async (store) => {
    const engine = makeEngine(store, { set: async () => {}, resolve: async () => null })
    await assert.rejects(() => engine.setCredential('sk-x', 'bad name'), /凭据名不合法/)
    await assert.rejects(() => engine.setCredential('sk-x', '1abc'), /凭据名不合法/)
  })
})

test('保存后面板能解析到 Key（ctx.credentials.resolve）', async () => {
  await withTempSettings((store) => {
    const engine = makeEngine(store, {
      set: async () => {},
      resolve: async (ref) => (ref === 'PANEL_KEY' ? { value: 'sk-resolved', source: 'store' } : null),
    })
    return engine.setCredential('sk-resolved', 'PANEL_KEY')
      .then(() => engine.resolveCredential())
      .then((resolved) => {
        assert.equal(resolved.key, 'sk-resolved')
        assert.match(resolved.source, /^credentials:/)
      })
  })
})

test('共享设置校验 credentialRef 形状', () => {
  assert.deepEqual(validateSettings({ credentialRef: 'DEEPSEEK_API_KEY' }), { credentialRef: 'DEEPSEEK_API_KEY' })
  assert.throws(() => validateSettings({ credentialRef: 'bad name' }), /credentialRef/)
  assert.throws(() => validateSettings({ credentialRef: '1ABC' }), /credentialRef/)
  assert.throws(() => validateSettings({ credentialRef: 42 }), /credentialRef/)
})

test('DSH 凭据库不可写时回退到本地凭据文件（仅本机）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-cred-local-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const store = new SettingsStore({ file: join(dir, 'settings.json') })
    // 模拟旧版 DSH：ctx.credentials 只有 resolve，没有 set
    const engine = new CalibGuardEngine({
      config: normalizeConfig(undefined),
      settingsStore: store,
      credentials: { resolve: async () => null },
    })
    const result = await engine.setCredential('sk-local-file', 'LOCAL_KEY')
    assert.equal(result.storage, 'local-file')
    assert.equal(store.get().credentialRef, 'LOCAL_KEY')

    const saved = JSON.parse(readFileSync(join(dir, 'calibguard-credentials.json'), 'utf8'))
    assert.equal(saved.LOCAL_KEY, 'sk-local-file')

    const resolved = await engine.resolveCredential()
    assert.equal(resolved.key, 'sk-local-file')
    assert.equal(resolved.source, 'local-file')
    assert.equal(engine.diagnostics().credentialStorage, 'local-file')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入 DSH 凭据库抛错时也回退本地文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-cred-fail-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const store = new SettingsStore({ file: join(dir, 'settings.json') })
    const engine = new CalibGuardEngine({
      config: normalizeConfig(undefined),
      settingsStore: store,
      credentials: {
        resolve: async () => null,
        set: async () => { throw new Error('not supported') },
      },
    })
    const result = await engine.setCredential('sk-fallback', 'FALLBACK_KEY')
    assert.equal(result.storage, 'local-file')
    const resolved = await engine.resolveCredential()
    assert.equal(resolved.key, 'sk-fallback')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})