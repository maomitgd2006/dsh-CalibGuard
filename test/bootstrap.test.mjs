/**
 * 首启环境引导的状态机（**不真的下载/安装**：只测判定、幂等与状态快照）。
 *
 * CG_GUI 的 launcher 是"首启装环境"；本插件用 EnvironmentBootstrap 对齐这个行为：
 *   - venv 已存在 → 立即就绪，不 spawn 子进程；
 *   - 关闭 autoSetup → 明确 disabled，不联网；
 *   - 正在运行/失败 → 状态可被面板读取。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { EnvironmentBootstrap, venvPythonPath } from '../lib/bootstrap.js'

const tempDirs = []
function tempEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'calibguard-bootstrap-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('venvPythonPath 按平台给出解释器路径', () => {
  const path = venvPythonPath('X:\\engine')
  if (process.platform === 'win32') {
    assert.equal(path, join('X:\\engine', '.venv', 'Scripts', 'python.exe'))
  } else {
    assert.equal(path, join('X:\\engine', '.venv', 'bin', 'python'))
  }
})

test('venv 已存在 → 立即就绪，不 spawn（start 同步 resolve）', async () => {
  const engineRoot = tempEngine()
  const python = venvPythonPath(engineRoot)
  mkdirSync(join(python, '..'), { recursive: true })
  writeFileSync(python, '', 'utf8')

  const bootstrap = new EnvironmentBootstrap({ engineRoot })
  assert.equal(bootstrap.venvReady, true)
  const snapshot = await bootstrap.start()
  assert.equal(snapshot.state, 'ready')
  assert.equal(snapshot.venvReady, true)
  // 重复 start 幂等
  assert.equal((await bootstrap.start()).state, 'ready')
})

test('关闭 autoSetup → disabled，不尝试联网/安装', async () => {
  const engineRoot = tempEngine()
  const bootstrap = new EnvironmentBootstrap({ engineRoot, enabled: false })
  const snapshot = await bootstrap.start()
  assert.equal(snapshot.state, 'disabled')
  assert.match(snapshot.message, /autoSetup=false/)
  assert.equal(snapshot.engineRoot, engineRoot)
  assert.equal(bootstrap.venvReady, false)
})

test('waitReady(0) 在未就绪时立即返回快照（不阻塞调用方）', async () => {
  const engineRoot = tempEngine()
  const bootstrap = new EnvironmentBootstrap({ engineRoot, enabled: false })
  const snapshot = await bootstrap.waitReady(0)
  assert.equal(snapshot.state, 'disabled')
  assert.equal(snapshot.venvReady, false)
})

test('snapshot 字段稳定（面板按这些字段渲染）', () => {
  const bootstrap = new EnvironmentBootstrap({ engineRoot: tempEngine(), enabled: false })
  const snapshot = bootstrap.snapshot()
  for (const key of ['state', 'step', 'message', 'enabled', 'engineRoot', 'venvReady', 'startedAt', 'finishedAt', 'error', 'tail']) {
    assert.ok(key in snapshot, `snapshot 缺字段 ${key}`)
  }
  assert.deepEqual(snapshot.tail, [])
})
