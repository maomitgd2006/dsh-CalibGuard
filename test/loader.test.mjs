/**
 * 装载器级集成测试：在**真实的 cordis 应用树**里装载本插件，验证完整生命周期。
 *
 * 与 plugin.test.mjs（假 ctx）的区别：这里用的是 DSH 自带的真 cordis ——
 *   - 会真正执行 Config 校验（schemastery 的 StandardSchemaV1）；
 *   - 会真正走 fiber 的 inject 解析（先不提供 tools，插件必须「待命而不报错」；
 *     提供 tools 后才激活）；
 *   - 会真正走卸载路径（root.stop()）。
 *
 * 不启动任何 DSH 服务、不监听端口、不触碰用户的 profile。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { normalizeConfig } from '../lib/config.js'

const config = normalizeConfig(undefined)
const pythonPath = process.platform === 'win32'
  ? join(config.engineRoot, '.venv', 'Scripts', 'python.exe')
  : join(config.engineRoot, '.venv', 'bin', 'python')
const ready = existsSync(pythonPath)

let Context
let plugin
try {
  Context = (await import('@deepseek-ai/cordis')).Context
  plugin = await import('../lib/index.js')
} catch {
  Context = undefined
}

const skip = Context ? (ready ? false : '缺少引擎环境，跳过') : '未安装 @deepseek-ai/cordis（先跑 scripts/link-dsh.mjs）'

/** 等待若干毫秒（cordis 的 fiber 重载是异步的）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('真 cordis 树：提供 tools 服务后激活并注册三个工具', { skip }, async () => {
  const registered = []
  const root = new Context()
  const pluginObject = { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }

  // 先不提供 tools：插件应处于待命（不报错、不注册）
  const fiber = root.plugin(pluginObject, { announceToModel: false, idleShutdownMs: 0 })

  await sleep(50)
  assert.equal(registered.length, 0, 'tools 服务出现前不应注册任何工具')

  // 提供 tools 服务后，cordis 应自动重新装载该插件
  root.provide('tools', {
    register(definition) {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  })

  await sleep(300)
  assert.deepEqual(
    registered.map((item) => item.name).sort(),
    ['calibguard_audit', 'calibguard_configure', 'calibguard_status'],
    'tools 服务就绪后应注册三个工具',
  )
  assert.equal(typeof root.calibguard?.audit, 'function', 'ctx.provide 的 calibguard 服务应可从上下文读取')

  const service = root.calibguard
  const value = await service.inspect()
  assert.equal(value.engineRoot, config.engineRoot)
  assert.equal(value.device, 'cpu', '算力 6.1 的显卡必须定档 CPU')

  // 卸载：fiber 卸载会触发插件注册的 dispose，从而停掉桥接并撤销工具
  await fiber?.dispose?.()
  await service.dispose()                       // 幂等兜底：桥接已停则立即返回
  await sleep(300)
  assert.equal(registered.length, 0, '卸载后工具应被撤销')
})

test('真 cordis 树：非法 config 不会让插件带病激活', { skip }, async () => {
  const registered = []
  const root = new Context()
  const pluginObject = { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }

  root.provide('tools', {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  })

  // Config（schemastery）会先拦下非法值：可能同步抛错，也可能让 fiber 进入错误态。
  // 两条路径都接受，但绝不允许「带着非法配置注册工具」。
  let threw = false
  let fiber
  try {
    fiber = root.plugin(pluginObject, { device: 'tpu' })
  } catch {
    threw = true
  }
  await sleep(200)
  assert.equal(registered.length, 0, '非法配置下不允许注册任何工具')
  if (threw) assert.equal(fiber, undefined)

  await fiber?.dispose?.()
})
