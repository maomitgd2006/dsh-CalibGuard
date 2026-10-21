/**
 * 面板「重装 torch」任务的轻量测试（不实际联网安装）：
 *   - 初始状态为 idle；
 *   - 非法 mode 被拒绝；
 *   - snapshot 字段形状稳定（面板依赖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { CalibGuardEngine } from '../lib/engine.js'

function makeEngine() {
  return new CalibGuardEngine({ config: normalizeConfig(undefined) })
}

test('torch 任务初始状态 idle，snapshot 形状稳定', () => {
  const engine = makeEngine()
  const snapshot = engine.torchJobSnapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.error, null)
  assert.ok(Array.isArray(snapshot.tail))
  assert.equal(snapshot.tail.length, 0)
  const gpu = engine.gpuTorchStatus()
  assert.equal(gpu.gpuName, null)
  assert.equal(gpu.cudaAvailable, null)
})

test('非法 mode 被拒绝（面板只会传 auto/cuda/cpu）', async () => {
  const engine = makeEngine()
  await assert.rejects(() => engine.installTorch('gpu'), /mode 必须是/)
})
