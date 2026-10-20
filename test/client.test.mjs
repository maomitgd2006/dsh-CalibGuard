/**
 * 客户端半边的离线测试：不需要浏览器，用假的 window/React 验证：
 *   - 脚本以 classic script + __ModuleLoader__.load 的形式加载；
 *   - bundle id 与 package.json 的 name 一致（DSH 用它做模块 id）；
 *   - factory 返回 { apply, inject }；
 *   - apply 把侧边栏图标注册到 sidebar.panellist（id=calibguard）、
 *     把页面注册到 main（key=calibguard）；
 *   - 任何损坏的 ctx 都不会让 apply 抛异常（UI 起不来不能拖垮 Harness）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const CLIENT_CODE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 在隔离 VM 里执行 classic script，捕获 __ModuleLoader__.load 的入参。 */
function loadClientBundle() {
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) { captured = options },
      },
    },
    console: { warn: () => {}, log: () => {}, error: () => {} },
  }
  vm.runInNewContext(CLIENT_CODE, sandbox, { filename: 'lib/client.js' })
  assert.ok(captured, '脚本必须调用 window.__ModuleLoader__.load')
  return captured
}

/** 最小 React stub：只满足 hooks 的存在性（本测试不真正渲染）。 */
function fakeReact() {
  const noop = () => {}
  return {
    useState: (initial) => [initial, noop],
    useEffect: noop,
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
  }
}

function fakeJsxRuntime() {
  const Fragment = Symbol('Fragment')
  const create = (type, props) => ({ type, props })
  return { jsx: create, jsxs: create, Fragment }
}

function requireStub(specifier) {
  if (specifier === 'react') return fakeReact()
  if (specifier === 'react/jsx-runtime') return fakeJsxRuntime()
  throw new Error(`client bundle 只允许 require 种子模块，出现了：${specifier}`)
}

test('bundle id 与包名一致（DSH 用它作为 client 模块 id）', () => {
  const bundle = loadClientBundle()
  assert.equal(bundle.id, PACKAGE_JSON.name)
  assert.equal(typeof bundle.factory, 'function')
})

test('factory 返回 { apply, inject }，inject 只含 slots', () => {
  const bundle = loadClientBundle()
  const exports = bundle.factory(requireStub)
  assert.equal(typeof exports.apply, 'function')
  // VM 沙箱里创建的数组属于另一个 realm，先转成本 realm 的数组再比较
  assert.deepEqual(Array.from(exports.inject), ['slots'])
})

test('apply 注册侧边栏图标与主面板（各一次，key/id 正确）', () => {
  const bundle = loadClientBundle()
  const exports = bundle.factory(requireStub)
  const registrations = []
  const ctx = {
    slots: {
      inject: (slotName, callback) => {
        assert.ok(['sidebar.panellist', 'main'].includes(slotName), `未知插槽 ${slotName}`)
        return callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(registrations.length, 2)

  const panellist = registrations.find((item) => item.options.name === 'sidebar.panellist')
  assert.ok(panellist, '应注册 sidebar.panellist')
  assert.equal(panellist.options.id, 'calibguard')
  assert.equal(typeof panellist.options.label, 'function')
  assert.equal(typeof panellist.component, 'function')

  const main = registrations.find((item) => item.options.name === 'main')
  assert.ok(main, '应注册 main')
  assert.equal(main.options.key, 'calibguard')
  assert.equal(typeof main.component, 'function')
})

test('apply 对损坏的 ctx 静默降级，不抛异常', () => {
  const bundle = loadClientBundle()
  const exports = bundle.factory(requireStub)
  for (const ctx of [undefined, null, {}, { slots: {} }, { slots: { inject: null } }]) {
    assert.doesNotThrow(() => exports.apply(ctx))
  }
})

test('apply 在插槽注册抛错时也能继续（两个注册互不连累）', () => {
  const bundle = loadClientBundle()
  const exports = bundle.factory(requireStub)
  let calls = 0
  const ctx = {
    slots: {
      inject: (_name, callback) => callback(),
      register: () => { calls += 1; throw new Error('boom') },
    },
  }
  assert.doesNotThrow(() => exports.apply(ctx))
  assert.equal(calls, 2, '两个插槽都应尝试注册')
})

test('client.js 是 classic script（不出现 import/export 语句）', () => {
  assert.equal(/^\s*(import|export)\s/m.test(CLIENT_CODE), false)
})
