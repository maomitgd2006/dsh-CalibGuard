/**
 * 桥接侧路径展开语义（不加载模型，秒级）：
 *
 *   - 显式给出的文件（含面板上传的文件）：**全部审计**，不受 maxFiles 影响；
 *   - 目录：递归展开合计最多 maxFiles 个，超出则截断并置 truncated=true。
 *
 * 这条语义就是面板上「目录文件上限」的真实含义；曾经实现成"总数截断"，
 * 会导致用户显式拖入 30 个文件时被默认上限 20 悄悄砍掉，因此单独立测试锁住。
 *
 * 依赖 DSH_CG 用到的 Python 引擎环境；缺失时整体跳过（skip），不算失败。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

import { normalizeConfig } from '../lib/config.js'

const config = normalizeConfig(undefined)
const pythonPath = process.platform === 'win32'
  ? join(config.engineRoot, '.venv', 'Scripts', 'python.exe')
  : join(config.engineRoot, '.venv', 'bin', 'python')
const bridgePath = join(config.packageRoot, 'bridge', 'calibguard_bridge.py')
const ready = existsSync(pythonPath) && existsSync(bridgePath)
const skip = ready ? false : `缺少 Python 引擎环境（${pythonPath}），跳过路径展开测试`

const SCRIPT = `
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location('cb_bridge', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakePipeline:
    """复刻引擎的 _collect_files：os.walk + 按路径排序。"""
    def _collect_files(self, path):
        found = []
        for root, dirs, files in os.walk(path):
            dirs.sort()
            for name in sorted(files):
                found.append(os.path.join(root, name))
        return found

payload = json.loads(sys.argv[2])
try:
    files, truncated = module._expand_paths(FakePipeline(), payload['paths'], payload['maxFiles'])
    print(json.dumps({'files': files, 'truncated': truncated, 'error': None}))
except Exception as exc:  # noqa: BLE001
    print(json.dumps({'files': [], 'truncated': False, 'error': str(exc)}))
`

const tempDirs = []

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'calibguard-expand-'))
  tempDirs.push(root)
  // 目录树：根目录 6 个 + 子目录 3 个 = 9 个文件
  for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `f${i}.py`), `print(${i})\n`, 'utf8')
  const sub = join(root, 'sub')
  mkdirSync(sub)
  for (let i = 0; i < 3; i += 1) writeFileSync(join(sub, `s${i}.py`), `print(${i})\n`, 'utf8')
  // 目录外的 3 个显式文件
  const outside = mkdtempSync(join(tmpdir(), 'calibguard-explicit-'))
  tempDirs.push(outside)
  const explicit = []
  for (let i = 0; i < 3; i += 1) {
    const file = join(outside, `e${i}.py`)
    writeFileSync(file, `print(${i})\n`, 'utf8')
    explicit.push(file)
  }
  return { root, explicit }
}

/** 调 Python 侧的 _expand_paths（无模型依赖）。 */
function runExpand(paths, maxFiles) {
  const result = spawnSync(pythonPath, ['-c', SCRIPT, bridgePath, JSON.stringify({ paths, maxFiles })], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(result.status, 0, `Python 退出码非 0：${result.stderr}`)
  return JSON.parse(result.stdout.trim())
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('目录展开受 maxFiles 限制，显式文件不受影响', { skip }, () => {
  const { root, explicit } = makeTree()
  const capped = runExpand([root, ...explicit], 4)
  assert.equal(capped.error, null)
  assert.equal(capped.truncated, true, '目录文件数超过上限应标记截断')
  // 3 个显式文件全在 + 目录只取 4 个
  assert.equal(capped.files.length, 7)
  for (const file of explicit) assert.ok(capped.files.includes(file), `显式文件 ${file} 不应被上限砍掉`)
  const fromDir = capped.files.filter((file) => !explicit.includes(file))
  assert.equal(fromDir.length, 4)
  // 目录内按路径排序取前 4 个
  assert.deepEqual(fromDir, [join(root, 'f0.py'), join(root, 'f1.py'), join(root, 'f2.py'), join(root, 'f3.py')])
})

test('上限足够时不截断，目录文件全部返回', { skip }, () => {
  const { root, explicit } = makeTree()
  const all = runExpand([root, ...explicit], 200)
  assert.equal(all.error, null)
  assert.equal(all.truncated, false)
  assert.equal(all.files.length, 12)
})

test('只给显式文件时不受 maxFiles=1 影响（修复前的行为会只剩 1 个）', { skip }, () => {
  const { explicit } = makeTree()
  const only = runExpand(explicit, 1)
  assert.equal(only.error, null)
  assert.equal(only.truncated, false, '显式文件不应触发截断标记')
  assert.deepEqual(only.files, explicit)
})

test('路径不存在时抛出可读错误', { skip }, () => {
  const missing = join(tmpdir(), 'calibguard-does-not-exist-文件.py')
  const result = runExpand([missing], 20)
  assert.match(String(result.error), /路径不存在/)
})
