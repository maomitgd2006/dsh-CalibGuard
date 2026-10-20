/**
 * 客户端 manifest 契约测试：断言本包的声明满足 DSH client-module 扫描器的验收条件。
 *
 * 这些规则来自 `@deepseek-ai/dsh-client-modules` 的实际实现：
 *   - `dsh.client.platform` 必须存在且（对本 GUI）等于 'web'，否则整包被忽略；
 *   - `exports["./client"]` 必须是字符串或 { default: 字符串 }；
 *   - 指向的 bundle 文件必须真实存在（缺失会在宿主启动时抛 MissingClientBundleError）；
 *   - bundle 必须是 classic script 且调用 window.__ModuleLoader__.load，id === 包名。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 解析 exports["./client"] 指向的相对路径（与扫描器同款两种形态）。 */
function clientExportTarget(pkg) {
  const entry = pkg.exports?.['./client']
  if (typeof entry === 'string') return entry
  if (entry && typeof entry.default === 'string') return entry.default
  return undefined
}

test('dsh.client 声明存在且 platform 为 web', () => {
  const client = PACKAGE_JSON.dsh?.client
  assert.ok(client, 'package.json 缺少 dsh.client')
  assert.equal(client.platform, 'web')
  assert.ok(Array.isArray(client.inject), 'dsh.client.inject 必须是字符串数组')
  for (const item of client.inject) assert.equal(typeof item, 'string')
  if (client.external !== undefined) {
    assert.ok(Array.isArray(client.external))
    for (const item of client.external) assert.equal(typeof item, 'string')
  }
})

test('exports["./client"] 指向真实存在的 bundle', () => {
  const target = clientExportTarget(PACKAGE_JSON)
  assert.equal(typeof target, 'string', 'exports["./client"] 必须是字符串或 { default: 字符串 }')
  const file = new URL(`../${target.replace(/^\.\//, '')}`, import.meta.url)
  assert.equal(existsSync(fileURLToPath(file)), true, `client bundle 不存在：${target}`)
})

test('bundle 是 classic script 且 id 与包名一致', () => {
  const target = clientExportTarget(PACKAGE_JSON)
  const code = readFileSync(fileURLToPath(new URL(`../${target.replace(/^\.\//, '')}`, import.meta.url)), 'utf8')
  assert.match(code, /window\.__ModuleLoader__\.load\(/)
  const idMatch = code.match(/id:\s*['"]([^'"]+)['"]/)
  assert.ok(idMatch, 'bundle 必须声明 id')
  assert.equal(idMatch[1], PACKAGE_JSON.name, 'bundle id 必须等于包名（扫描器用它做模块 id）')
  // 不能用 ESM 语法：它是被当作 classic script 加载的
  assert.equal(/^\s*(import|export)\s/m.test(code), false)
  // 允许 require 的只有种子模块 + 本包声明的 external
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  const allowed = new Set(['react', 'react/jsx-runtime', ...(PACKAGE_JSON.dsh.client.external ?? [])])
  for (const specifier of requires) {
    assert.ok(allowed.has(specifier), `client bundle 只允许 require 种子模块，出现了：${specifier}`)
  }
})

test('bundle 随包分发（files 覆盖 lib/）', () => {
  const files = PACKAGE_JSON.files ?? []
  assert.ok(files.some((entry) => entry === 'lib' || entry.startsWith('lib/')), 'files 必须包含 lib')
})
