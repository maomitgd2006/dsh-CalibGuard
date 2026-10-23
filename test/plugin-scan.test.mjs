/**
 * 其他 DSH 插件扫描的单元测试：
 *   - 只列 profile `dsh.profile.bundles` 里的插件，排除自身与 @deepseek-ai/* 核心包；
 *   - 新装/升级识别（pluginKey）与「首次只记基线」行为；
 *   - 扫描结果汇总（worst 判定）与状态文件；
 *   - 周期/开关设置合并；环境未就绪时跳过。
 * 引擎用假实现替代，不触发真实推理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listInstalledPlugins, pluginKey, PluginScanManager } from '../lib/plugin-scan.js'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cg-scan-'))
  mkdirSync(join(home, 'profiles', 'desktop', 'node_modules'), { recursive: true })
  return home
}

function writeProfile(home, bundles, packages) {
  writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dsh: { profile: { bundles } },
  }, null, 2))
  for (const pkg of packages) {
    const dir = join(home, 'profiles', 'desktop', 'node_modules', pkg.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }))
  }
}

function fakeAudit({ blockFor } = {}) {
  const calls = []
  const audit = async (paths, options) => {
    const target = paths[0] || ''
    calls.push({ target, options })
    const isBlock = blockFor && target.includes(blockFor)
    return {
      summary: isBlock
        ? { total: 2, block: 1, manual_review: 0, suspicious: 1, allow: 0, error: 0 }
        : { total: 1, block: 0, manual_review: 0, suspicious: 0, allow: 1, error: 0 },
      elapsedMs: 5,
      results: isBlock
        ? [
          { final_decision: 'block', file_path: join(target, 'evil.js') },
          { final_decision: 'suspicious', file_path: join(target, 'maybe.js') },
        ]
        : [{ final_decision: 'allow', file_path: join(target, 'ok.js') }],
    }
  }
  audit.calls = calls
  return audit
}

function makeManager(home, { audit, settings = {}, config = {} } = {}) {
  const warnings = []
  const engine = {
    bootstrap: { venvReady: true },
    audit: audit ?? fakeAudit(),
  }
  const settingsStore = { get: () => ({ ...settings }) }
  const configFull = {
    pluginScanMode: 'update',
    pluginScanMaxFiles: 100,
    ...config,
  }
  const manager = new PluginScanManager({
    engine,
    config: configFull,
    settingsStore,
    home,
    logger: { info: () => {}, warn: (line) => warnings.push(line) },
  })
  return { manager, engine, warnings, settingsStore }
}

test('只列其他已安装插件：排除自己与 @deepseek-ai/*，忽略未装/已删', () => {
  const home = makeHome()
  try {
    writeProfile(home, ['@deepseek-ai/dsh-base', 'dsh-calibguard', 'good-plugin', '@scope/bad-plugin', 'missing-plugin'], [
      { name: 'good-plugin', version: '1.2.3' },
      { name: '@scope/bad-plugin', version: '0.1.0' },
    ])
    const plugins = listInstalledPlugins({ home })
    assert.deepEqual(plugins.map((plugin) => plugin.name), ['@scope/bad-plugin', 'good-plugin'])
    const good = plugins.find((plugin) => plugin.name === 'good-plugin')
    assert.equal(good.version, '1.2.3')
    assert.ok(good.dir.endsWith(join('node_modules', 'good-plugin')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pluginKey 在版本变化时改变', () => {
  const home = makeHome()
  try {
    writeProfile(home, ['p1'], [{ name: 'p1', version: '1.0.0' }])
    const [plugin] = listInstalledPlugins({ home })
    const key1 = pluginKey(plugin)
    writeProfile(home, ['p1'], [{ name: 'p1', version: '1.0.1' }])
    const [updated] = listInstalledPlugins({ home })
    assert.notEqual(pluginKey(updated), key1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('首次 tick 只记录基线；新装插件后自动扫描它并保存结果', async () => {
  const home = makeHome()
  try {
    writeProfile(home, ['old-plugin'], [{ name: 'old-plugin', version: '1.0.0' }])
    const { manager, engine } = makeManager(home)
    await manager.tick()                                   // 基线
    assert.equal(engine.audit.calls.length, 0)

    writeProfile(home, ['old-plugin', 'new-plugin'], [
      { name: 'new-plugin', version: '2.0.0' },
    ])
    await manager.tick()
    assert.equal(engine.audit.calls.length, 1)
    assert.ok(engine.audit.calls[0].target.includes('new-plugin'))
    const snapshot = manager.snapshot()
    assert.equal(snapshot.lastMode, 'update')
    assert.equal(snapshot.results.length, 1)
    assert.equal(snapshot.results[0].name, 'new-plugin')
    const state = JSON.parse(readFileSync(snapshot.stateFile, 'utf8'))
    assert.ok(Array.isArray(state.known) && state.known.length === 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('scanNow 汇总 worst 判定并打风险日志', async () => {
  const home = makeHome()
  try {
    writeProfile(home, ['evil-plugin', 'nice-plugin'], [
      { name: 'evil-plugin', version: '6.6.6' },
      { name: 'nice-plugin', version: '1.0.0' },
    ])
    const audit = fakeAudit({ blockFor: 'evil-plugin' })
    const { manager, warnings } = makeManager(home, { audit })
    const snapshot = await manager.scanNow('all')
    assert.equal(snapshot.results.length, 2)
    const evil = snapshot.results.find((item) => item.name === 'evil-plugin')
    assert.equal(evil.worst, 'block')
    assert.equal(evil.block, 1)
    assert.ok(evil.blockedFiles[0].endsWith('evil.js'))
    const nice = snapshot.results.find((item) => item.name === 'nice-plugin')
    assert.equal(nice.worst, 'allow')
    assert.ok(warnings.some((line) => line.includes('evil-plugin') && line.includes('拦截')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('设置合并：面板设置优先于插件配置；非法 mode 回退默认', () => {
  const home = makeHome()
  try {
    const { manager } = makeManager(home, {
      settings: { pluginScanMode: 'off', pluginScanMaxFiles: 7 },
    })
    assert.deepEqual(manager.options(), { mode: 'off', enabled: false, maxFiles: 7 })
    const { manager: fallback } = makeManager(home, {
      settings: { pluginScanMode: 'every-day' },
    })
    assert.equal(fallback.options().mode, 'update')
    const { manager: legacy } = makeManager(home, {
      settings: { scanPluginsOnUpdate: true, pluginScanInterval: 'weekly' },
      config: { pluginScanMode: undefined },
    })
    assert.equal(legacy.options().mode, 'weekly')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('周期模式：到期后 tick 会全量扫描', async () => {
  const home = makeHome()
  try {
    writeProfile(home, ['p1'], [{ name: 'p1', version: '1.0.0' }])
    const audit = fakeAudit()
    const { manager } = makeManager(home, { audit, config: { pluginScanMode: 'monthly' } })
    await manager.tick() // 基线
    manager.state.lastScanAt = Date.now() - 40 * 24 * 60 * 60 * 1000
    manager.state.known = manager.state.known ?? []
    await manager.tick()
    assert.equal(audit.calls.length, 1)
    assert.equal(manager.snapshot().lastMode, 'periodic')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('引擎环境未就绪时跳过扫描并给出原因', async () => {
  const home = makeHome()
  try {
    writeProfile(home, ['p1'], [{ name: 'p1', version: '1.0.0' }])
    const audit = fakeAudit()
    const { manager } = makeManager(home, { audit })
    manager.engine.bootstrap.venvReady = false
    const snapshot = await manager.scanNow('all')
    assert.equal(audit.calls.length, 0)
    assert.match(snapshot.error, /引擎环境尚未就绪/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
