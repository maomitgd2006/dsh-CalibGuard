/**
 * 子进程环境清洗单测：凭据形状与 DSH_* 一律不进桥接进程，显式变量可覆盖。
 *
 * 这是"插件不偷偷继承宿主凭据"这条安全约束的回归测试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FALLBACK_SENSITIVE_ENV_PATTERN,
  buildChildEnv,
  scrubEnvFallback,
  usingPlatformScrub,
} from '../lib/env.js'

const SAMPLE_PARENT = {
  PATH: 'C:\\Windows',
  SystemRoot: 'C:\\Windows',
  TEMP: 'C:\\Temp',
  HARMLESS: 'ok',
  DEEPSEEK_API_KEY: 'sk-should-not-leak',
  MY_API_KEY: 'a',
  db_password: 'b',
  SOME_TOKEN: 'c',
  A_SECRET: 'd',
  AWS_CREDENTIAL: 'e',
  DSH_SESSION_ID: 'f',
  dsh_lower_case: 'g',
  PYTHONIOENCODING: 'latin-1',
}

test('兜底清洗：凭据形状与 DSH_* 全部剔除，普通变量保留', () => {
  const env = scrubEnvFallback(SAMPLE_PARENT)
  // 注意：规则与平台一致，只覆盖 KEY/PASSWORD/SECRET/TOKEN 四类词根；
  // 形如 AWS_CREDENTIAL 这种不在词根里的名字**不会**被剔除 —— 这是该启发式的已知边界，
  // 真实凭据通常落在 *_KEY / *_TOKEN / *_SECRET / *PASSWORD 上。
  for (const key of ['DEEPSEEK_API_KEY', 'MY_API_KEY', 'db_password', 'SOME_TOKEN', 'A_SECRET']) {
    assert.equal(key in env, false, `${key} 不应进入子进程`)
  }
  for (const key of ['DSH_SESSION_ID', 'dsh_lower_case']) {
    assert.equal(key in env, false, `${key}（大小写不敏感）不应进入子进程`)
  }
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'HARMLESS', 'PYTHONIOENCODING']) {
    assert.equal(env[key], SAMPLE_PARENT[key], `${key} 应保留`)
  }
})

test('兜底清洗：非法正则退回内置启发式（不因坏配置泄露机密）', () => {
  const env = scrubEnvFallback(SAMPLE_PARENT, { pattern: '([' })
  assert.equal('DEEPSEEK_API_KEY' in env, false)
  assert.equal(env.HARMLESS, 'ok')
})

test('兜底清洗：自定义模式可覆盖默认启发式', () => {
  const env = scrubEnvFallback({ KEEP_ME: '1', MY_KEY: '2' }, { pattern: '^MY_' })
  assert.equal(env.KEEP_ME, '1')
  assert.equal('MY_KEY' in env, false)
})

test('buildChildEnv：清洗 + 显式变量覆盖（显式值是调用方的明确意图）', async () => {
  const env = await buildChildEnv({
    source: SAMPLE_PARENT,
    explicit: { PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(env.PYTHONIOENCODING, 'utf-8', '显式变量应覆盖父环境同名值')
  assert.equal(env.PATH, SAMPLE_PARENT.PATH)
  assert.equal('DEEPSEEK_API_KEY' in env, false)
  assert.equal(Object.keys(env).some((key) => key.toUpperCase().startsWith('DSH_')), false)
})

test('buildChildEnv：默认 source 是真实 process.env（生产路径）', async () => {
  const env = await buildChildEnv({ explicit: { CALIBGUARD_ENV_PROBE: '1' } })
  assert.equal(env.CALIBGUARD_ENV_PROBE, '1')
  assert.equal(Object.keys(env).some((key) => /KEY|PASSWORD|SECRET|TOKEN/i.test(key)), false)
  assert.equal(Object.keys(env).some((key) => key.toUpperCase().startsWith('DSH_')), false)
  // Windows 上 PATH 的真实大小写常是 Path，用大小写不敏感的方式断言
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  assert.ok(pathKey, 'PATH 必须保留，否则子进程无法启动')
  assert.equal(typeof env[pathKey], 'string')
})

test('usingPlatformScrub：能报告是否复用了 DSH 自己的实现', async () => {
  const using = await usingPlatformScrub()
  assert.equal(typeof using, 'boolean')
})

test('内置兜底模式本身是有效正则', () => {
  assert.doesNotThrow(() => new RegExp(FALLBACK_SENSITIVE_ENV_PATTERN, 'i'))
})
