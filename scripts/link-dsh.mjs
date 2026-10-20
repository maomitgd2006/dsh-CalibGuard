#!/usr/bin/env node
/**
 * 开发期便利脚本：把 DSH 自带的包以「目录联接（junction）」方式挂到本包的 node_modules 下。
 *
 * 为什么需要：本插件对 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 是**可选**依赖
 * （动态 import，拿不到就退化）。用 file:// 行直接从仓库路径加载插件时，Node 会从
 * `<本包目录>/lib` 向上找 node_modules；挂上联接后即可解析到 DSH 自带的同一份包实例。
 *
 * 若你改用 `dsh plugin --profile <p> add file:<本包绝对路径>` 正规安装到 profile，则不需要本脚本。
 *
 * 用法：node scripts/link-dsh.mjs [--dsh-modules <路径>] [--dry-run]
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 需要挂接的包（只列本包直接 import 的）。 */
const PACKAGES = ['cordis', 'dsh-tools', 'schemastery']

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { dshModules: null, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dsh-modules') args.dshModules = argv[++index]
    else if (argv[index] === '--dry-run') args.dryRun = true
    else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('用法：node scripts/link-dsh.mjs [--dsh-modules <@deepseek-ai 所在目录>] [--dry-run]')
      process.exit(0)
    } else {
      console.error(`未知参数：${argv[index]}`)
      process.exit(2)
    }
  }
  return args
}

/** 自动探测 DSH 包目录：环境变量 → 常见 profile 位置。 */
function detectDshModules() {
  const candidates = []
  if (process.env.DSH_PACKAGES_DIR) candidates.push(process.env.DSH_PACKAGES_DIR)
  const home = process.env.USERPROFILE || process.env.HOME
  if (home) {
    candidates.push(join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai'))
    candidates.push(join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai'))
    candidates.push(join(home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh-tools'))) return candidate
  }
  return null
}

const args = parseArgs(process.argv.slice(2))
const source = args.dshModules ? resolve(args.dshModules) : detectDshModules()
if (!source) {
  console.error('找不到 DSH 包目录。请用 --dsh-modules 显式指定（含 dsh-tools / schemastery 的目录）。')
  process.exit(1)
}

const target = join(packageRoot, 'node_modules', '@deepseek-ai')
console.log(`DSH 包目录：${source}`)
console.log(`挂接目标  ：${target}`)

for (const name of PACKAGES) {
  const from = join(source, name)
  const to = join(target, name)
  if (!existsSync(from)) {
    console.error(`✗ 源包不存在，跳过：${from}`)
    continue
  }
  if (args.dryRun) {
    console.log(`· [dry-run] ${to}  ->  ${from}`)
    continue
  }
  mkdirSync(target, { recursive: true })
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  // Windows 用 junction（无需管理员权限），其它平台用目录符号链接
  symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`✓ ${name}  ->  ${from}`)
}

if (!args.dryRun) console.log('\n完成。可用 node --test 跑本包的测试。')
