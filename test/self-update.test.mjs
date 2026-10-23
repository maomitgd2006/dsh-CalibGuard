/**
 * 自更新检查（只提示、不静默升级）的单测：
 *   - semver 比较；
 *   - 发现新版本 → available；跳过该版本 / 以后不再询问后不再提示；
 *   - 网络失败记录错误但不影响其它功能；
 *   - 频率设置合并。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SelfUpdateChecker, compareVersions } from '../lib/self-update.js'

function makeChecker({ latest = '0.5.0', current = '0.4.0', settings = {}, fail = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cg-selfupd-'))
  const fetchImpl = async () => {
    if (fail) throw new Error('network down')
    return { ok: true, json: async () => ({ version: latest }) }
  }
  const checker = new SelfUpdateChecker({
    home,
    currentVersion: current,
    fetchImpl,
    config: { selfUpdateCheck: 'startup' },
    settingsStore: { get: () => ({ ...settings }) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  return { checker, home }
}

test('compareVersions 基础比较', () => {
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0)
  assert.equal(compareVersions('0.5.0', '0.4.9'), 1)
  assert.equal(compareVersions('v0.4.0', '0.4.1'), -1)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0)
})

test('发现新版本 → available，且不自动升级（只给升级方式）', async () => {
  const { checker, home } = makeChecker()
  try {
    const snapshot = await checker.checkNow()
    assert.equal(snapshot.available, true)
    assert.equal(snapshot.latestVersion, '0.5.0')
    assert.equal(snapshot.currentVersion, '0.4.0')
    assert.ok(snapshot.upgrade.desktop.includes('添加插件'))
    assert.ok(snapshot.upgrade.command.includes('dsh-calibguard@latest'))
    assert.ok(snapshot.stateFile.endsWith('calibguard-self-update.json'))
    assert.equal(existsSync(snapshot.stateFile), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('跳过此版本 / 以后不再询问后不再提示', async () => {
  const { checker } = makeChecker()
  try {
    await checker.checkNow()
    assert.equal(checker.dismiss('version').available, false)
    checker.state.skippedVersion = null
    assert.equal(checker.dismiss('forever').available, false)
    assert.equal(checker.snapshot().neverAsk, true)
  } finally {
    rmSync(checker.baseDir, { recursive: true, force: true })
  }
})

test('网络失败：记录错误但不抛出；仍可继续检查', async () => {
  const { checker } = makeChecker({ fail: true })
  try {
    const snapshot = await checker.checkNow()
    assert.equal(snapshot.available, false)
    assert.match(snapshot.lastError, /network down/)
  } finally {
    rmSync(checker.baseDir, { recursive: true, force: true })
  }
})

test('频率设置：面板设置优先，非法值回退 startup', () => {
  const { checker } = makeChecker({ settings: { selfUpdateCheck: 'daily' } })
  try {
    assert.equal(checker.options().mode, 'daily')
    checker.settingsStore = { get: () => ({ selfUpdateCheck: 'every-hour' }) }
    assert.equal(checker.options().mode, 'startup')
  } finally {
    rmSync(checker.baseDir, { recursive: true, force: true })
  }
})
