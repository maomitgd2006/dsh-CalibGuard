#!/usr/bin/env node
/**
 * 一键准备 CalibGuard 引擎（给从 Release 下载本插件的用户用）。
 *
 * 本插件只是"壳"：真正的审计引擎（`calibguard/` 代码 + `models/` 模型权重）在
 * CG 仓库里，且需要一套装好依赖的 Python 环境。本脚本把这些补齐：
 *
 *   1) 下载 CG 的发行包（默认 `CalibGuard-GUI.zip`，约 467 MB）并解压到 `<本包同级>/CG_GUI`；
 *   2) 在 `<CG_GUI>/.venv` 创建 Python 虚拟环境；
 *   3) 按 `<CG_GUI>/requirements-gui.txt` 安装依赖（torch / transformers / scikit-learn / openai / PyYAML…）；
 *   4) 跑一次桥接自检，打印设备定档、模型、阈值结果。
 *
 * 用法：
 *   node setup.mjs                                  # 全自动（推荐）
 *   node setup.mjs --help                           # 查看全部参数
 *   node setup.mjs --from D:\CalibGuard-GUI.zip     # 用已下载的 zip，不再联网
 *   node setup.mjs --dest D:\CG_GUI                 # 装到自定义位置（之后配 engineRoot）
 *
 * 无第三方依赖，只用 Node 内置模块；下载走 Node 20+ 的 fetch。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const PKG_ROOT = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DEST = resolve(PKG_ROOT, '..', 'CG_GUI')
const DEFAULT_URL = 'https://github.com/P-436/CG/releases/download/v1.0.0/CalibGuard-GUI.zip'
/** torch 官方轮子目前覆盖的 Python 版本上限（3.13/3.14 装不上 torch）。 */
const PY_MIN = 10
const PY_MAX = 12

// ============================== 输出与进程 ==============================

const log = (...args) => console.log(...args)
const step = (text) => console.log(`\n== ${text} ==`)
const warn = (text) => console.warn(`⚠️  ${text}`)

class SetupError extends Error {}

function fail(text) {
  throw new SetupError(text)
}

function bytes(n) {
  const num = Number(n) || 0
  if (num >= 1024 ** 3) return `${(num / 1024 ** 3).toFixed(2)} GB`
  if (num >= 1024 ** 2) return `${(num / 1024 ** 2).toFixed(1)} MB`
  if (num >= 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${num} B`
}

/** 同步执行命令：capture=true 时返回 stdout/stderr，否则直接继承终端。 */
function run(cmd, args, { capture = false, timeout = 0 } = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout,
  })
  if (result.error) throw new SetupError(`无法执行 ${cmd}：${result.error.message}`)
  return result
}

/** 流式执行（能看到 pip 的实时进度）。 */
function runLive(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', (error) => rejectPromise(new SetupError(`${cmd} 启动失败：${error.message}`)))
    child.on('close', (code) => (code === 0 ? resolvePromise() : rejectPromise(new SetupError(`${cmd} 退出码 ${code}`))))
  })
}

// ============================== 参数 ==============================

function parseArgs(argv) {
  const options = {
    dest: DEFAULT_DEST,
    from: '',
    url: DEFAULT_URL,
    python: '',
    skipDownload: false,
    skipVenv: false,
    skipInstall: false,
    skipVerify: false,
    force: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      i += 1
      if (argv[i] === undefined) fail(`${arg} 需要一个值`)
      return argv[i]
    }
    switch (arg) {
      case '-h': case '--help': options.help = true; break
      case '--dest': options.dest = resolve(value()); break
      case '--from': options.from = resolve(value()); break
      case '--url': options.url = value(); break
      case '--python': options.python = value(); break
      case '--skip-download': options.skipDownload = true; break
      case '--skip-venv': options.skipVenv = true; break
      case '--skip-install': options.skipInstall = true; break
      case '--skip-verify': options.skipVerify = true; break
      case '--force': options.force = true; break
      default: fail(`未知参数：${arg}（用 --help 查看用法）`)
    }
  }
  return options
}

function printHelp() {
  console.log(`一键准备 CalibGuard 引擎

用法：
  node setup.mjs [选项]

选项：
  --dest <dir>      引擎安装目录（默认：本包同级的 CG_GUI）
  --from <zip>      使用本地已下载的发行包（不联网）
  --url <url>       发行包下载地址（默认：CG 的 v1.0.0 Release 资产）
  --python <exe>    指定 Python 解释器（需 3.10–3.12）
  --skip-download   跳过下载（已有引擎或 --from 时）
  --skip-venv       跳过创建虚拟环境
  --skip-install    跳过 pip install
  --skip-verify     跳过最后的桥接自检
  --force           覆盖已有引擎目录 / 重建 venv
  -h, --help        显示本帮助

示例：
  node setup.mjs
  node setup.mjs --from D:\\CalibGuard-GUI.zip
  node setup.mjs --dest D:\\CG_GUI --skip-download

说明：
  • 引擎约 480 MB（含 475 MB 模型权重），依赖安装另需约 1–3 GB 磁盘；
  • 默认用 PyPI 的 CPU 版 torch 即可（低算力显卡本来也会被定档到 CPU）；
    要用 GPU 请按 PyTorch 官网自行安装对应 CUDA 轮子。
`)
}

// ============================== 引擎检测 ==============================

function engineStatus(dest) {
  const checks = {
    hasEngine: existsSync(join(dest, 'calibguard', '__init__.py')),
    hasModel: existsSync(join(dest, 'models', 'codebert_finetuned', 'model.safetensors')),
    hasCalibration: existsSync(join(dest, 'models', 'calibration_params.json')),
    hasRequirements: existsSync(join(dest, 'requirements-gui.txt')),
  }
  return { dest, ...checks, complete: checks.hasEngine && checks.hasModel && checks.hasCalibration }
}

function describeEngine(status) {
  return `calibguard=${status.hasEngine ? '✓' : '✗'}  models=${status.hasModel ? '✓' : '✗'}  calibration=${status.hasCalibration ? '✓' : '✗'}`
}

// ============================== 下载 ==============================

async function download(url, file) {
  log(`下载：${url}`)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.part`
  rmSync(temp, { force: true })

  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    throw new SetupError(`下载失败（网络错误）：${error.message}\n`
      + '可以手动下载后重试：node setup.mjs --from <下载到的 zip>')
  }
  if (!response.ok || !response.body) {
    throw new SetupError(`下载失败：HTTP ${response.status} ${response.statusText}\n`
      + '可以手动下载后重试：node setup.mjs --from <下载到的 zip>')
  }

  const total = Number(response.headers.get('content-length') || 0)
  log(`保存到：${file}  大小：${total ? bytes(total) : '未知'}`)

  const sink = createWriteStream(temp)
  const reader = Readable.fromWeb(response.body)
  const startedAt = Date.now()
  let received = 0
  let lastPercent = 0

  await new Promise((resolvePromise, rejectPromise) => {
    reader.on('data', (chunk) => {
      received += chunk.length
      if (!total) return
      const percent = Math.floor((received / total) * 100)
      if (percent >= lastPercent + 2) {
        lastPercent = percent
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000)
        log(`  ${percent}%  ${bytes(received)} / ${bytes(total)}  (${bytes(received / elapsed)}/s)`)
      }
    })
    reader.on('error', rejectPromise)
    sink.on('error', rejectPromise)
    sink.on('finish', resolvePromise)
    reader.pipe(sink)
  })

  if (total && received !== total) {
    rmSync(temp, { force: true })
    throw new SetupError(`下载不完整：${bytes(received)} / ${bytes(total)}，请重试或用 --from 手动指定。`)
  }
  rmSync(file, { force: true })
  renameSync(temp, file)
  log(`下载完成：${bytes(received)}（用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`)
}

// ============================== 解压 ==============================

function extract(zipFile, dest) {
  log(`解压到：${dest}`)
  mkdirSync(dest, { recursive: true })

  const attempts = [['tar', ['-xf', zipFile, '-C', dest]]]
  if (process.platform === 'win32') {
    attempts.push(['powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]])
  } else {
    attempts.push(['unzip', ['-oq', zipFile, '-d', dest]])
  }

  const errors = []
  for (const [cmd, args] of attempts) {
    const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' })
    if (probe.error) continue
    const result = spawnSync(cmd, args, { encoding: 'utf8' })
    if (result.status === 0) return
    errors.push(`${cmd}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  }
  throw new SetupError(`解压失败（已尝试 tar 与平台专用命令）：\n${errors.join('\n')}`)
}

// ============================== Python ==============================

/** 返回 { version: '3.12', bits: 64 } 或 null。torch 只提供 64 位轮子，32 位必须排除。 */
function pythonInfo(cmd, args) {
  const result = spawnSync(
    cmd,
    [...args, '-c', 'import struct,sys;print("%d.%d %d" % (sys.version_info[0], sys.version_info[1], struct.calcsize("P") * 8))'],
    { encoding: 'utf8', timeout: 20_000 },
  )
  if (result.error || result.status !== 0) return null
  const text = String(result.stdout || '').trim()
  const match = /^(\d+\.\d+)\s+(\d+)$/.exec(text)
  if (!match) return null
  return { version: match[1], bits: Number(match[2]) }
}

function versionOk(version) {
  const [major, minor] = String(version).split('.').map(Number)
  return major === 3 && minor >= PY_MIN && minor <= PY_MAX
}

function findPython(explicit) {
  const candidates = []
  if (explicit) candidates.push({ label: explicit, cmd: explicit, args: [] })
  if (process.env.DSH_CALIBGUARD_PYTHON) {
    candidates.push({ label: 'DSH_CALIBGUARD_PYTHON', cmd: process.env.DSH_CALIBGUARD_PYTHON, args: [] })
  }
  if (process.platform === 'win32') {
    for (const minor of [PY_MAX, 11, PY_MIN]) candidates.push({ label: `py -3.${minor}`, cmd: 'py', args: [`-3.${minor}`] })
  }
  for (const minor of [PY_MAX, 11, PY_MIN]) candidates.push({ label: `python3.${minor}`, cmd: `python3.${minor}`, args: [] })
  candidates.push({ label: 'python', cmd: 'python', args: [] })
  candidates.push({ label: 'python3', cmd: 'python3', args: [] })

  const seen = []
  for (const candidate of candidates) {
    const info = pythonInfo(candidate.cmd, candidate.args)
    if (!info) continue
    const desc = `${candidate.label} = ${info.version} (${info.bits} 位)`
    seen.push(desc)
    if (info.bits !== 64) continue // torch 没有 32 位轮子
    if (!versionOk(info.version)) continue
    return { ...candidate, version: info.version, bits: info.bits }
  }

  const hints = []
  if (seen.some((line) => line.includes('(32 位)'))) {
    hints.push('检测到 32 位 Python：torch 不提供 32 位轮子，必须换 64 位解释器。')
  }
  if (seen.some((line) => / = 3\.(1[3-9]|[2-9]\d) \(64 位\)/.test(line))) {
    hints.push(`检测到 Python 3.${PY_MAX + 1}+：torch 目前没有对应轮子（需要 3.${PY_MIN}–3.${PY_MAX}）。`)
  }
  fail(`需要 64 位 Python 3.${PY_MIN}–3.${PY_MAX}。\n`
    + `检测结果：${seen.length > 0 ? seen.join('、') : '未找到任何 Python'}\n`
    + `${hints.join('\n')}${hints.length > 0 ? '\n' : ''}`
    + `请安装 64 位 Python 3.12 后重试，或用 --python 指定解释器（如 --python "C:\\Python312\\python.exe"）。`)
}

function venvPython(dest) {
  return process.platform === 'win32'
    ? join(dest, '.venv', 'Scripts', 'python.exe')
    : join(dest, '.venv', 'bin', 'python')
}

// ============================== 主流程 ==============================

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return }

  log('CalibGuard 引擎安装器')
  log(`插件目录：${PKG_ROOT}`)
  log(`引擎目标：${options.dest}`)

  try {
    const { statfsSync } = await import('node:fs')
    const free = Number(statfsSync(options.dest).bavail) * Number(statfsSync(options.dest).bsize)
    log(`目标盘剩余空间：${bytes(free)}`)
    if (free < 4 * 1024 ** 3) warn('剩余空间不足 4 GB：下载(约 467 MB) + 解压(约 480 MB) + 依赖(1–3 GB) 可能不够。')
  } catch { /* 平台不支持就跳过 */ }

  // ---------- 1. 引擎 ----------
  const before = engineStatus(options.dest)
  let downloadedZip = ''

  // --from 是用户显式指定的输入，路径不存在就直接报错（无论目标是否已有引擎）
  if (options.from && !existsSync(options.from)) {
    fail(`--from 指定的文件不存在：${options.from}`)
  }
  if (options.from && before.complete && !options.force) {
    log('\n提示：目标引擎已完整，已忽略 --from（如需重新解压请加 --force）')
  }

  if (before.complete && !options.force) {
    log('\n✓ 引擎已存在且完整，跳过下载与解压')
  } else if (options.skipDownload) {
    if (!before.hasEngine) fail('--skip-download 指定了，但目标目录里没有 calibguard/（可先用 --from 指定压缩包）。')
    log('\n跳过下载（--skip-download）：直接使用现有目录')
  } else {
    step('准备引擎')
    let zipFile = options.from
    if (!zipFile) {
      downloadedZip = join(dirname(options.dest), `CalibGuard-GUI-${Date.now()}.zip`)
      await download(options.url, downloadedZip)
      zipFile = downloadedZip
    } else {
      log(`使用本地压缩包：${zipFile}（${bytes(statSync(zipFile).size)}）`)
    }
    if (options.force && existsSync(options.dest)) {
      warn(`--force：清空已有目录 ${options.dest}`)
      rmSync(options.dest, { recursive: true, force: true })
    }
    mkdirSync(options.dest, { recursive: true })
    if (readdirSync(options.dest).length > 0 && !options.force) {
      warn('目标目录非空：将覆盖同名文件（如需全新安装请加 --force）')
    }
    extract(zipFile, options.dest)
    const after = engineStatus(options.dest)
    if (!after.hasEngine) {
      fail(`解压完成，但 ${options.dest} 里没有 calibguard/。\n`
        + '请确认压缩包是 CG 的发行包 CalibGuard-GUI.zip（其根目录应包含 calibguard/ 与 models/）。')
    }
    if (!after.hasModel || !after.hasCalibration) {
      warn('没找到模型权重或校准参数（models/）：引擎能启动，但审计会失败，请确认下载完整。')
    }
    if (downloadedZip) {
      rmSync(downloadedZip, { force: true })
      log('已清理下载的临时压缩包')
    }
  }

  const status = engineStatus(options.dest)
  log(`\n引擎检查：${describeEngine(status)}`)

  // ---------- 2. venv ----------
  const python = venvPython(options.dest)
  if (existsSync(python) && !options.force) {
    log(`\n✓ 虚拟环境已存在：${python}`)
  } else if (options.skipVenv) {
    if (!existsSync(python) && !options.skipInstall) {
      fail('--skip-venv 指定了，但没有可用虚拟环境；不能继续 pip install。')
    }
    log('\n跳过创建虚拟环境（--skip-venv）')
  } else {
    step('创建 Python 虚拟环境')
    const found = findPython(options.python)
    log(`使用 Python：${found.label}（${found.version}）`)
    run(found.cmd, [...found.args, '-m', 'venv', join(options.dest, '.venv')])
    if (!existsSync(python)) fail(`虚拟环境创建后找不到解释器：${python}`)
    log('✓ 虚拟环境已创建')
  }

  // ---------- 3. 依赖 ----------
  if (options.skipInstall) {
    log('\n跳过依赖安装（--skip-install）')
  } else {
    step('安装 Python 依赖（首次约 1–3 GB，可能几分钟）')
    if (!existsSync(python)) fail(`找不到虚拟环境解释器：${python}`)
    const requirements = join(options.dest, 'requirements-gui.txt')
    if (!existsSync(requirements)) fail(`找不到依赖清单：${requirements}`)
    await runLive(python, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'])
    await runLive(python, ['-m', 'pip', 'install', '-r', requirements])
    log('✓ 依赖安装完成')
  }

  // ---------- 4. 自检 ----------
  if (options.skipVerify) {
    log('\n跳过自检（--skip-verify）')
  } else {
    step('桥接自检')
    if (!existsSync(python)) fail(`找不到虚拟环境解释器：${python}，无法自检。`)
    const bridge = join(PKG_ROOT, 'bridge', 'calibguard_bridge.py')
    const result = spawnSync(python, [bridge, '--selftest', '--engine-root', options.dest], {
      cwd: options.dest,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    const stdout = String(result.stdout || '').trim()
    const jsonLine = stdout.split('\n').filter((line) => line.trim().startsWith('{')).pop()
    if (result.status !== 0 || !jsonLine) {
      warn(`自检失败（exit ${result.status}）`)
      if (stdout) console.error(stdout)
      if (result.stderr) console.error(result.stderr)
      fail('引擎未通过自检：常见原因是依赖没装全、Python 版本不匹配、或模型文件缺失。')
    }
    const payload = JSON.parse(jsonLine)
    const info = payload.result || {}
    log(`✓ 自检通过：设备 ${info.device} ｜ 模型 ${info.modelPresent ? '就绪' : '缺失'} ｜ 阈值 `
      + `${info.gate?.allowThreshold}/${info.gate?.blockThreshold} ｜ 云端复核 `
      + `${info.llm?.enabled ? (info.llm?.configured ? '可用' : '无凭据（灰区转人工）') : '关闭'}`)
    if (info.devicePolicy?.reason) log(`  设备定档：${info.device}（${info.devicePolicy.reason}）`)
  }

  // ---------- 5. 下一步 ----------
  step('完成')
  const isDefault = resolve(options.dest) === resolve(DEFAULT_DEST)
  log('接下来：')
  if (!isDefault) {
    log('  1) 在插件配置里指定引擎路径：')
    log(`       engineRoot: '${options.dest.replace(/\\/g, '\\\\')}'`)
  } else {
    log('  1) 插件配置无需改动（默认使用同级的 CG_GUI）')
  }
  log('  2) 重启 DSH：左侧边栏会出现盾牌图标；或让 AI 调 calibguard_status 验证。')
  log(`\n卸载：删除 ${options.dest} 即可（本脚本不改 DSH 配置）。`)
}

main().catch((error) => {
  if (error instanceof SetupError) {
    console.error(`\n✖ ${error.message}`)
  } else {
    console.error('\n✖ 未预期的错误：', error)
  }
  process.exit(1)
})
