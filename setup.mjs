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
import {
  chmodSync, copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync,
  readdirSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'

const PKG_ROOT = dirname(fileURLToPath(import.meta.url))
/** torch 官方轮子目前覆盖的 Python 版本上限（3.13/3.14 装不上 torch）。 */
const PY_MIN = 10
const PY_MAX = 12

/** 引擎/模型下载的镜像前缀：GitHub 直连失败时依次重试（均实测支持 Range 分段）。 */
const ENGINE_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/']

/** CUDA 版 torch（与 CG_GUI launcher 相同的定档口径）。 */
const TORCH_CUDA_INDEX = process.env.DSH_CALIBGUARD_TORCH_INDEX || 'https://download.pytorch.org/whl/cu128'
const CUDA_MIN = [12, 8]
const CUDA_MIN_COMPUTE_CAP = [7, 5]
/** 并发分段下载的段数（0/负数 = 单连接）。 */
const DOWNLOAD_CONNECTIONS = Number(process.env.DSH_CALIBGUARD_DOWNLOAD_CONNECTIONS || 4)
/** pip 索引：默认清华镜像，失败回退官方 PyPI。 */
const DEFAULT_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const OFFICIAL_PIP_INDEX = 'https://pypi.org/simple'

/** DSH 主目录。 */
function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/**
 * 默认引擎目录：
 * - 源码仓库（本包不在 node_modules 里）→ 与本包同级的 CG_GUI；
 * - 从 npm / GitHub 装进 node_modules → 放 DSH 主目录，避免被包管理器升级清掉。
 */
function defaultDest() {
  const installed = PKG_ROOT.split(/[\\/]/).includes('node_modules')
  return installed ? join(dshHomeDir(), 'calibguard-engine') : resolve(PKG_ROOT, '..', 'CG_GUI')
}
const DEFAULT_DEST = defaultDest()

/** 给 GitHub 直链生成「直连 + 镜像」候选列表。 */
function mirroredUrls(url) {
  const extra = String(process.env.DSH_CALIBGUARD_ENGINE_MIRRORS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const urls = [url]
  for (const prefix of [...extra, ...ENGINE_MIRRORS]) {
    const candidate = prefix + url
    if (!urls.includes(candidate)) urls.push(candidate)
  }
  return urls
}

/** pip 索引候选（自定义 → 清华 → 阿里 → 中科大 → 腾讯 → 官方）。 */
function pipIndexes() {
  const custom = String(process.env.DSH_CALIBGUARD_PIP_INDEX || process.env.PIP_INDEX_URL || '').trim()
  return [...new Set([
    custom,
    DEFAULT_PIP_INDEX,
    'https://mirrors.aliyun.com/pypi/simple/',
    'https://pypi.mirrors.ustc.edu.cn/simple/',
    'https://mirrors.cloud.tencent.com/pypi/simple',
    OFFICIAL_PIP_INDEX,
  ].filter(Boolean))]
}

/** 比较版本元组：[a,b] vs [c,d]。 */
function cmpVersion(a, b) {
  return (a[0] - b[0]) || ((a[1] ?? 0) - (b[1] ?? 0))
}

function fmtVersion(version) {
  return Array.isArray(version) ? version.slice(0, 2).join('.') : '未知'
}

/** 用 nvidia-smi 探测 GPU：返回 { hasNvidia, gpuName, computeCap, cudaVersion }。 */
function detectGpu() {
  const probe = (args) => {
    const result = spawnSync('nvidia-smi', args, { encoding: 'utf8', timeout: 20_000 })
    if (result.error || result.status !== 0) return ''
    return String(result.stdout || '').trim()
  }
  const csv = probe(['--query-gpu=name,compute_cap', '--format=csv,noheader'])
  if (!csv) return { hasNvidia: false, gpuName: null, computeCap: null, cudaVersion: null }
  const first = csv.split(/\r?\n/)[0] || ''
  const parts = first.split(',').map((item) => item.trim())
  const gpuName = parts[0] || null
  let computeCap = null
  if (parts[1] && /^\d+\.\d+$/.test(parts[1])) {
    computeCap = parts[1].split('.').map(Number)
  }
  const header = probe([])
  const match = /CUDA Version:\s*(\d+)\.(\d+)/.exec(header)
  const cudaVersion = match ? [Number(match[1]), Number(match[2])] : null
  return { hasNvidia: true, gpuName, computeCap, cudaVersion }
}

/** 是否需要安装 CUDA 版 torch（与 CG_GUI launcher 同款「CUDA 版本 + 算力」双检）。 */
function decideCudaTorch(gpu) {
  if (String(process.env.DSH_CALIBGUARD_CPU_ONLY || '') === '1') {
    return { useCuda: false, reason: 'DSH_CALIBGUARD_CPU_ONLY=1，强制 CPU' }
  }
  if (!gpu.hasNvidia) return { useCuda: false, reason: '未检测到 NVIDIA 显卡（nvidia-smi 不可用）' }
  if (!gpu.cudaVersion || cmpVersion(gpu.cudaVersion, CUDA_MIN) < 0) {
    return {
      useCuda: false,
      reason: `CUDA 版本 ${fmtVersion(gpu.cudaVersion)} < ${fmtVersion(CUDA_MIN)}（或无法探测）`,
    }
  }
  if (gpu.computeCap && cmpVersion(gpu.computeCap, CUDA_MIN_COMPUTE_CAP) < 0) {
    return {
      useCuda: false,
      reason: `算力 ${fmtVersion(gpu.computeCap)} < ${fmtVersion(CUDA_MIN_COMPUTE_CAP)}（cu128 轮子无对应 kernel）`,
    }
  }
  return { useCuda: true, reason: `算力 ${fmtVersion(gpu.computeCap)} ｜ CUDA ${fmtVersion(gpu.cudaVersion)}` }
}

/** 已安装 torch 的 CUDA 版本（空串 = CPU 版；null = 未安装/无法导入）。 */
function installedTorchCuda(python) {
  const result = spawnSync(python, ['-c', 'import torch;print(torch.version.cuda or "")'], {
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (result.error || result.status !== 0) return null
  return String(result.stdout || '').trim()
}

/** 插件内置引擎目录：CG_GUI 核心文件（代码 / 词表 / 校准参数），不含 476 MB 模型权重。 */
const BUNDLED_ENGINE = join(PKG_ROOT, 'engine')

/** 模型权重下载地址：放在本仓库的 Release 资产上（GitHub 直连失败会自动尝试 ghproxy 等镜像）。 */
const MODEL_URL = 'https://github.com/maomitgd2006/dsh-CalibGuard/releases/download/model-v1.0.0/calibguard-model-1.0.0.zip'

/** 完整模型的 SHA-256（与 CG 发行包里的 model.safetensors 完全一致）。 */
const MODEL_SHA256 = '2f088a00c1a08c9331a58de2b9adc9bb7ace8f28a2491ee7b699f41c7b7efc65'

/** 模型压缩包的合理大小下限（防止镜像返回错误页被当成压缩包）。 */
const MODEL_ZIP_MIN_BYTES = 400 * 1024 ** 2

/** 文件 SHA-256（流式，避免大文件占内存）。 */
function sha256File(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectPromise)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * 准备模型权重：下载本仓库 Release 里的模型压缩包 → 校验尺寸/SHA-256 → 缓存到
 * `~/.dsh/calibguard-tools/model-cache` → 复制进引擎目录。
 * 每个镜像都会完整尝试（下载 → 解压 → 校验），坏镜像不会污染结果；已缓存时秒级完成。
 */
async function fetchModelWeights(dest) {
  const cacheDir = join(toolsDir(), 'model-cache')
  mkdirSync(cacheDir, { recursive: true })
  const cachedModel = join(cacheDir, 'model.safetensors')
  const finalPath = join(dest, 'models', 'codebert_finetuned', 'model.safetensors')

  let modelFile = ''
  if (existsSync(cachedModel) && (await sha256File(cachedModel)) === MODEL_SHA256) {
    log(`✓ 复用已缓存的模型：${cachedModel}`)
    modelFile = cachedModel
  } else {
    const zipPath = join(cacheDir, 'calibguard-model-1.0.0.zip')
    const unpacked = join(cacheDir, 'unpacked')
    let lastError = null
    for (const url of mirroredUrls(MODEL_URL)) {
      try {
        log(`下载模型权重（约 442 MB）：${url}`)
        await downloadParallel(url, zipPath)
        const size = statSync(zipPath).size
        if (size < MODEL_ZIP_MIN_BYTES) {
          throw new SetupError(`下载内容异常（${bytes(size)}，预期约 442 MB，可能是镜像错误页）`)
        }
        rmSync(unpacked, { recursive: true, force: true })
        mkdirSync(unpacked, { recursive: true })
        extract(zipPath, unpacked)
        const found = findBinary(unpacked, 'model.safetensors')
        if (!found) throw new SetupError('模型压缩包里没有 model.safetensors')
        const actual = await sha256File(found)
        if (actual !== MODEL_SHA256) throw new SetupError(`模型 SHA-256 不匹配：${actual}`)
        deleteFile(cachedModel)
        try {
          renameSync(found, cachedModel)
        } catch {
          copyFileSync(found, cachedModel)
        }
        rmSync(unpacked, { recursive: true, force: true })
        deleteFile(zipPath)
        modelFile = cachedModel
        lastError = null
        log(`✓ 模型已缓存：${cachedModel}`)
        break
      } catch (error) {
        lastError = error
        warn(`下载源失败：${String(error.message).split('\n')[0]}，换下一个源…`)
        deleteFile(zipPath)
        deleteFile(`${zipPath}.part`)
        rmSync(unpacked, { recursive: true, force: true })
      }
    }
    if (!modelFile) {
      throw new SetupError(`模型下载失败：${lastError?.message ?? '未知错误'}\n`
        + `可以重试（支持断点续传），或手动下载后放到：${cachedModel}\n`
        + '（下载地址：https://github.com/maomitgd2006/dsh-CalibGuard/releases/tag/model-v1.0.0）')
    }
  }

  log(`写入引擎目录：${finalPath}`)
  mkdirSync(dirname(finalPath), { recursive: true })
  deleteFile(finalPath)
  copyFileSync(modelFile, finalPath)
  const finalSha = await sha256File(finalPath)
  if (finalSha !== MODEL_SHA256) {
    deleteFile(finalPath)
    throw new SetupError(`写入后模型校验失败（SHA-256 ${finalSha}），请重试。`)
  }
  log(`✓ 模型已就绪：${finalPath}（${bytes(statSync(finalPath).size)}）`)
}

/** 删除文件（不存在也不报错）。 */
function deleteFile(file) {
  rmSync(file, { force: true })
}

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
    url: '',
    python: '',
    skipDownload: false,
    skipVenv: false,
    skipInstall: false,
    skipVerify: false,
    force: false,
    noPortablePython: false,
    forcePortablePython: false,
    reinstallTorch: false,
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
      case '--no-portable-python': options.noPortablePython = true; break
      case '--force-portable-python': options.forcePortablePython = true; break
      case '--reinstall-torch': options.reinstallTorch = true; break
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
  --from <zip>      使用本地已下载的 CG 发行包（解压安装）
  --url <url>       从指定地址下载 CG 发行包并解压安装
                   （默认不下载 CG 包：用插件内置引擎 + 从 npm 镜像取模型分片）
  --python <exe>    指定 Python 解释器（需 3.10–3.12）
  --skip-download   跳过下载（已有引擎或 --from 时）
  --skip-venv       跳过创建虚拟环境
  --skip-install    跳过 pip install
  --skip-verify     跳过最后的桥接自检
  --force           覆盖已有引擎目录 / 重建 venv
  --no-portable-python  本机没有 Python 时不自动下载便携版（默认会自动下载）
  --force-portable-python  跳过本机 Python 检测，强制用便携版（测试用）
  --reinstall-torch 重新安装 torch（检测到 NVIDIA 时装 CUDA/cu128 版，约 2.5 GB）
  -h, --help        显示本帮助

示例：
  node setup.mjs
  node setup.mjs --from D:\\CalibGuard-GUI.zip
  node setup.mjs --dest D:\\CG_GUI --skip-download

说明：
  • 默认用插件内置的引擎（CG_GUI 核心代码，约 5 MB），模型权重（475 MB）分两片
    从 npm 镜像下载（npmmirror 加速，每个分片 < 256 MB）；也可用 --from 指定 CG 发行包；
  • 依赖安装另需约 1–3 GB 磁盘；
  • 本机没有 64 位 Python 3.10–3.12 时，会自动用 uv 下载便携 Python 3.10.8（约 30 MB）；
  • 下载默认走 GitHub 直连，失败会自动尝试 ghproxy / gh-proxy / ghfast 镜像；
    可用 DSH_CALIBGUARD_ENGINE_MIRRORS 追加镜像前缀（逗号分隔）；
  • pip 默认用清华镜像（pypi.tuna.tsinghua.edu.cn），失败自动回退官方 PyPI；
    可用 DSH_CALIBGUARD_PIP_INDEX 指定其它索引；
  • 从 npm 安装时引擎默认放在 ~/.dsh/calibguard-engine（可用 --dest 或插件配置 engineRoot 指定）；
  • GPU 自动定档：检测到 NVIDIA 且 CUDA≥12.8、算力≥7.5（如 RTX 20/30/40 系）时
    自动安装 CUDA（cu128）版 torch；否则用 CPU 版；可用 DSH_CALIBGUARD_CPU_ONLY=1 强制 CPU；
  • 大文件（模型/引擎包）默认 4 路并发分段下载，可用 DSH_CALIBGUARD_DOWNLOAD_CONNECTIONS 调整；
  • 装完想换 GPU/CPU 版 torch：node setup.mjs --reinstall-torch。
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

/**
 * 下载一个文件。
 * - 断点续传：已有 `<file>.part` 时用 Range 续传（服务器不支持则从头下）；
 * - 空闲超时：120 秒收不到数据就中止，避免界面「一直卡在准备中」；
 * - 失败时保留 .part，换源/重试可继续。
 */
async function download(url, file) {
  log(`下载：${url}`)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.part`
  const resumed = existsSync(temp) ? statSync(temp).size : 0
  if (resumed > 0) log(`发现未完成的下载，尝试续传（已有 ${bytes(resumed)}）`)

  const controller = new AbortController()
  let idleTimer = null
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error('120 秒没有收到数据')), 120_000)
  }
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }

  let response
  try {
    resetIdle()
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: resumed > 0 ? { Range: `bytes=${resumed}-` } : {},
    })
  } catch (error) {
    clearIdle()
    throw new SetupError(`下载失败（网络错误）：${error.message}\n`
      + '可以手动下载后重试：node setup.mjs --from <下载到的 zip>')
  }
  if (response.status === 416 && resumed > 0) {
    clearIdle()
    rmSync(temp, { force: true })
    throw new SetupError('续传位置无效（HTTP 416），已清除断点，请重试。')
  }
  if (!response.ok || !response.body) {
    clearIdle()
    throw new SetupError(`下载失败：HTTP ${response.status} ${response.statusText}\n`
      + '可以手动下载后重试：node setup.mjs --from <下载到的 zip>')
  }

  const partial = response.status === 206
  const remaining = Number(response.headers.get('content-length') || 0)
  const total = partial ? resumed + remaining : remaining
  const append = partial && resumed > 0
  log(`保存到：${file}  大小：${total ? bytes(total) : '未知'}${append ? '（续传）' : ''}`)

  const sink = createWriteStream(temp, { flags: append ? 'a' : 'w' })
  const reader = Readable.fromWeb(response.body)
  const startedAt = Date.now()
  let received = append ? resumed : 0
  let lastPercent = -1
  let lastLogAt = 0

  await new Promise((resolvePromise, rejectPromise) => {
    reader.on('data', (chunk) => {
      resetIdle()
      received += chunk.length
      const now = Date.now()
      if (total) {
        const percent = Math.floor((received / total) * 100)
        if (percent >= lastPercent + 2) {
          lastPercent = percent
          const elapsed = Math.max(1, (now - startedAt) / 1000)
          log(`  ${percent}%  ${bytes(received)} / ${bytes(total)}  (${bytes((received - resumed) / elapsed)}/s)`)
        }
      } else if (now - lastLogAt > 5000) {
        lastLogAt = now
        const elapsed = Math.max(1, (now - startedAt) / 1000)
        log(`  ${bytes(received)}  (${bytes((received - resumed) / elapsed)}/s)`)
      }
    })
    reader.on('error', (error) => { clearIdle(); rejectPromise(error) })
    sink.on('error', (error) => { clearIdle(); rejectPromise(error) })
    sink.on('finish', () => { clearIdle(); resolvePromise() })
    reader.pipe(sink)
  })

  if (total && received !== total) {
    throw new SetupError(`下载不完整：${bytes(received)} / ${bytes(total)}（已保留断点，重试可续传）`)
  }
  rmSync(file, { force: true })
  renameSync(temp, file)
  log(`下载完成：${bytes(received)}（用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`)
}

/** 下载一个区间的分片（支持断点续传/重试）。 */
async function downloadRange(url, file, start, end, { attempts = 3, idleMs = 120_000 } = {}) {
  const total = end - start + 1
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const offset = existsSync(file) ? statSync(file).size : 0
    if (offset >= total) return
    const controller = new AbortController()
    let idleTimer = null
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(new Error(`${Math.round(idleMs / 1000)} 秒没有收到数据`)), idleMs)
    }
    let response
    try {
      resetIdle()
      response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { Range: `bytes=${start + offset}-${end}` },
      })
    } catch (error) {
      if (idleTimer) clearTimeout(idleTimer)
      lastError = error
      warn(`分片 ${start}-${end} 第 ${attempt} 次失败：${error.message}`)
      continue
    }
    if (response.status !== 206 && !(response.status === 200 && offset === 0 && start === 0)) {
      if (idleTimer) clearTimeout(idleTimer)
      lastError = new SetupError(`分片请求返回 HTTP ${response.status}`)
      continue
    }
    const sink = createWriteStream(file, { flags: offset > 0 ? 'a' : 'w' })
    const reader = Readable.fromWeb(response.body)
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        reader.on('data', (chunk) => { resetIdle() })
        reader.on('error', (error) => { clearTimeout(idleTimer); rejectPromise(error) })
        sink.on('error', (error) => { clearTimeout(idleTimer); rejectPromise(error) })
        sink.on('finish', () => { clearTimeout(idleTimer); resolvePromise() })
        reader.pipe(sink)
      })
    } catch (error) {
      lastError = error
      warn(`分片 ${start}-${end} 第 ${attempt} 次中断：${error.message}（已保留断点）`)
      continue
    }
    if (statSync(file).size >= total) return
    lastError = new SetupError('分片下载不完整')
  }
  throw new SetupError(`分片 ${start}-${end} 下载失败：${lastError?.message ?? '未知错误'}`)
}

/**
 * 并发分段下载（大幅提升 GitHub/镜像的单连接限速场景）。
 * 先探测是否支持 Range；不支持或文件不够大时自动退回单连接 download()。
 */
async function downloadParallel(url, file, { connections = DOWNLOAD_CONNECTIONS } = {}) {
  if (!connections || connections < 2) return download(url, file)
  let total = 0
  let supportsRange = false
  try {
    const probe = await fetch(url, {
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(60_000),
    })
    if (probe.ok) {
      supportsRange = probe.status === 206
      const contentRange = probe.headers.get('content-range') || ''
      const sizePart = contentRange.split('/')[1]
      total = Number(sizePart || probe.headers.get('content-length') || 0)
      try { await probe.arrayBuffer() } catch { /* 忽略探测体 */ }
    }
  } catch {
    supportsRange = false
  }
  if (!supportsRange || !(total > 0) || total < 32 * 1024 ** 2) return download(url, file)

  const chunk = Math.ceil(total / connections)
  const parts = []
  for (let index = 0; index < connections; index += 1) {
    const start = index * chunk
    const end = Math.min(total - 1, start + chunk - 1)
    if (start > end) break
    parts.push({ start, end, file: `${file}.part${index}`, percent: 0 })
  }
  log(`分段并发下载：${parts.length} 路，共 ${bytes(total)}（单连接慢时明显提速）`)
  const startedAt = Date.now()
  let finished = 0
  await Promise.all(parts.map(async (part) => {
    await downloadRange(url, part.file, part.start, part.end)
    finished += 1
    log(`  分片 ${finished}/${parts.length} 完成（${bytes(statSync(part.file).size)}）`)
  }))
  log(`分段下载完成：${bytes(total)}（用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒），开始合并…`)
  const temp = `${file}.merging`
  deleteFile(temp)
  await streamPipeline((async function* generate() {
    for (const part of parts) {
      for await (const chunkData of createReadStream(part.file)) yield chunkData
    }
  })(), createWriteStream(temp))
  for (const part of parts) deleteFile(part.file)
  if (statSync(temp).size !== total) {
    deleteFile(temp)
    throw new SetupError(`合并后大小不符：${bytes(statSync(temp).size)} / ${bytes(total)}`)
  }
  deleteFile(file)
  renameSync(temp, file)
  log(`✓ 分段下载合并完成：${file}（${bytes(statSync(file).size)}）`)
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

// ============================== 便携 Python（本机没有时用 uv 自动装） ==============================

/** 自动下载的便携 Python 版本（与 CG_GUI launcher 的 PYTHON_PIN 一致）。 */
const PYTHON_PIN = '3.10.8'

/** uv 与便携 Python 的存放目录：放在 DSH 主目录下，避免污染仓库；删引擎目录不影响它。 */
function toolsDir() {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? resolve(process.env.DSH_HOME.trim())
    : join(homedir(), '.dsh')
  return join(dshHome, 'calibguard-tools')
}

/** 当前平台对应的 uv 发行包名；不支持返回空串。 */
function uvAssetName() {
  const { platform, arch } = process
  if (platform === 'win32') {
    if (arch === 'x64') return 'uv-x86_64-pc-windows-msvc.zip'
    if (arch === 'arm64') return 'uv-aarch64-pc-windows-msvc.zip'
  } else if (platform === 'linux') {
    if (arch === 'x64') return 'uv-x86_64-unknown-linux-gnu.tar.gz'
    if (arch === 'arm64') return 'uv-aarch64-unknown-linux-gnu.tar.gz'
  } else if (platform === 'darwin') {
    if (arch === 'arm64') return 'uv-aarch64-apple-darwin.tar.gz'
    if (arch === 'x64') return 'uv-x86_64-apple-darwin.tar.gz'
  }
  return ''
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const nested = findBinary(full, name)
      if (nested) return nested
    }
  }
  return ''
}

/** 拿到可执行的 uv：PATH 上已有就用；否则下载官方发行包并缓存。失败返回空串。 */
async function ensureUv(dest) {
  const binaryName = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const cached = join(toolsDir(), binaryName)
  if (existsSync(cached)) return cached
  const probe = spawnSync('uv', ['--version'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) return 'uv'
  const asset = uvAssetName()
  if (!asset) return ''
  const dir = toolsDir()
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, asset)
  const urls = mirroredUrls(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`)
  let downloaded = false
  for (const url of urls) {
    try {
      log(`下载 uv（约 12 MB）：${url}`)
      await download(url, archive)
      downloaded = true
      break
    } catch (error) {
      warn(`uv 下载失败（${error.message}），换下一个源再试…`)
    }
  }
  if (!downloaded) return ''
  const unpacked = join(dir, 'uv-unpacked')
  rmSync(unpacked, { recursive: true, force: true })
  mkdirSync(unpacked, { recursive: true })
  extract(archive, unpacked)
  const found = findBinary(unpacked, binaryName)
  if (!found) {
    rmSync(unpacked, { recursive: true, force: true })
    rmSync(archive, { force: true })
    return ''
  }
  copyFileSync(found, cached)
  if (process.platform !== 'win32') {
    try { chmodSync(cached, 0o755) } catch { /* 某些文件系统不支持，忽略 */ }
  }
  rmSync(unpacked, { recursive: true, force: true })
  rmSync(archive, { force: true })
  log('✓ uv 已就绪')
  return cached
}

/** 用 uv 下载便携 Python 并创建带 pip 的 venv；成功返回 true。 */
async function installPortablePython(uv, dest) {
  const dir = toolsDir()
  const pythonDir = join(dir, 'python')
  mkdirSync(pythonDir, { recursive: true })
  const baseEnv = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: pythonDir,
    UV_NO_MODIFY_PATH: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  const attempts = [
    { label: '直连', env: baseEnv },
    {
      label: '镜像 ghproxy',
      env: {
        ...baseEnv,
        UV_PYTHON_INSTALL_MIRROR: 'https://ghproxy.cn/https://github.com/astral-sh/python-build-standalone/releases/download',
      },
    },
  ]
  let installed = false
  for (const attempt of attempts) {
    log(`uv python install ${PYTHON_PIN}（${attempt.label}，约 30 MB）…`)
    const result = spawnSync(uv, ['python', 'install', PYTHON_PIN], {
      encoding: 'utf8',
      env: attempt.env,
      timeout: 15 * 60_000,
    })
    if (result.status === 0) { installed = true; break }
    const tail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-2).join(' / ')
    warn(`失败：${tail || `exit ${result.status ?? 'error'}`}`)
  }
  if (!installed) return false
  log('uv venv --seed（创建 .venv）…')
  const venvDir = join(dest, '.venv')
  rmSync(venvDir, { recursive: true, force: true })
  const venv = spawnSync(uv, ['venv', '--seed', '--python', PYTHON_PIN, venvDir], {
    encoding: 'utf8',
    env: baseEnv,
    timeout: 10 * 60_000,
  })
  if (venv.status !== 0) {
    const tail = String(venv.stderr || venv.stdout || '').trim().split('\n').slice(-2).join(' / ')
    warn(`uv venv 失败：${tail}`)
    return false
  }
  return existsSync(venvPython(dest))
}

function venvPython(dest) {  return process.platform === 'win32'
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
    if (free < 4 * 1024 ** 3) warn('剩余空间不足 4 GB：模型(约 476 MB) + 依赖(1–3 GB) 可能不够。')
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
    if (options.force && existsSync(options.dest)) {
      warn(`--force：清空已有目录 ${options.dest}`)
      rmSync(options.dest, { recursive: true, force: true })
    }
    mkdirSync(options.dest, { recursive: true })
    if (readdirSync(options.dest).length > 0 && !options.force) {
      warn('目标目录非空：将覆盖同名文件（如需全新安装请加 --force）')
    }

    if (options.from || options.url) {
      // 显式指定了 CG 发行包（--from 本地 zip / --url 下载 zip）
      let zipFile = options.from
      if (!zipFile) {
        downloadedZip = join(dirname(options.dest), `CalibGuard-GUI-${Date.now()}.zip`)
        const candidates = mirroredUrls(options.url)
        let lastError = null
        for (const candidate of candidates) {
          try {
            await downloadParallel(candidate, downloadedZip)
            if (statSync(downloadedZip).size < 100 * 1024 ** 2) {
              throw new SetupError('下载内容明显偏小，可能是镜像错误页')
            }
            lastError = null
            break
          } catch (error) {
            lastError = error
            warn(`下载源失败：${String(error.message).split('\n')[0]}`)
            rmSync(downloadedZip, { force: true })
            rmSync(`${downloadedZip}.part`, { force: true })
          }
        }
        if (lastError) {
          fail(`引擎下载失败：${lastError.message}\n`
            + '可手动下载后重试：node setup.mjs --from <CalibGuard-GUI.zip>\n'
            + '或在插件配置里把 engineRoot 指向已有的 CG_GUI 目录。')
        }
        zipFile = downloadedZip
      } else {
        log(`使用本地压缩包：${zipFile}（${bytes(statSync(zipFile).size)}）`)
      }
      extract(zipFile, options.dest)
      if (downloadedZip) {
        rmSync(downloadedZip, { force: true })
        log('已清理下载的临时压缩包')
      }
    } else {
      // 默认：内置引擎（CG_GUI 核心文件）+ npm 分片下载模型
      if (!existsSync(BUNDLED_ENGINE)) {
        fail(`安装包缺少内置引擎目录：${BUNDLED_ENGINE}\n`
          + '（安装包可能不完整；可用 --from 指定 CG 发行包，或在插件配置里把 engineRoot 指向已有 CG_GUI）')
      }
      log('复制内置引擎（CG_GUI 核心：代码 / 词表 / 校准参数）…')
      cpSync(BUNDLED_ENGINE, options.dest, { recursive: true, force: true })
      const modelPath = join(options.dest, 'models', 'codebert_finetuned', 'model.safetensors')
      if (existsSync(modelPath) && (await sha256File(modelPath)) === MODEL_SHA256) {
        log('✓ 模型权重已存在，跳过下载')
      } else {
        step('下载模型权重（约 442 MB，GitHub 失败自动换镜像）')
        await fetchModelWeights(options.dest)
      }
    }

    const after = engineStatus(options.dest)
    if (!after.hasEngine) {
      fail(`引擎准备完成，但 ${options.dest} 里没有 calibguard/。\n`
        + '请确认安装包完整，或用 --from 指定 CG 的发行包 CalibGuard-GUI.zip。')
    }
    if (!after.hasModel || !after.hasCalibration) {
      warn('没找到模型权重或校准参数（models/）：引擎能启动，但审计会失败，请确认下载完整。')
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
    const found = options.forcePortablePython ? null : findPython(options.python)
    if (found) {
      log(`使用本机 Python：${found.label}（${found.version}）`)
      run(found.cmd, [...found.args, '-m', 'venv', join(options.dest, '.venv')])
    } else if (options.noPortablePython) {
      fail('本机没有 64 位 Python 3.10–3.12，且已指定 --no-portable-python。'
        + '请安装后再试：https://www.python.org/downloads/（或用 --python 指定解释器）')
    } else {
      log('本机没有可用的 64 位 Python 3.10–3.12，自动下载便携版（首次约 30 MB）…')
      const uv = await ensureUv(options.dest)
      if (!uv) {
        fail('自动获取 uv 失败，无法下载便携 Python。请手动安装 64 位 Python 3.12 后重试：'
          + 'https://www.python.org/downloads/')
      }
      const ok = await installPortablePython(uv, options.dest)
      if (!ok) {
        fail('自动安装便携 Python 失败。请手动安装 64 位 Python 3.12 后重试：'
          + 'https://www.python.org/downloads/')
      }
      log(`✓ 便携 Python ${PYTHON_PIN} 已就绪（${join(toolsDir(), 'python')}）`)
    }
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
    const installWithMirrors = async (args) => {
      let lastError = null
      for (const index of pipIndexes()) {
        log(`pip 源：${index}`)
        try {
          await runLive(python, ['-m', 'pip', 'install', '--timeout', '180', '--retries', '5', '-i', index, ...args])
          return
        } catch (error) {
          lastError = error
          warn(`pip 安装失败（${index}）：${error.message}`)
        }
      }
      throw lastError ?? new SetupError('pip 安装失败')
    }
    await installWithMirrors(['--upgrade', 'pip', '--quiet'])

    // GPU 定档：有可用 NVIDIA（CUDA≥12.8、算力≥7.5）时先装 CUDA 版 torch，
    // 与 CG_GUI launcher 的口径一致；否则装 CPU 版 torch。
    const gpu = detectGpu()
    const decision = decideCudaTorch(gpu)
    const gpuLabel = gpu.gpuName ? `（${gpu.gpuName}）` : ''
    log(`GPU 定档：${decision.useCuda ? 'CUDA（cu128）' : 'CPU'} —— ${decision.reason}${gpuLabel}`)
    const existingTorchCuda = installedTorchCuda(python)
    if (decision.useCuda && (!existingTorchCuda || options.reinstallTorch)) {
      step(`安装 CUDA 版 torch（cu128，约 2.5 GB${existingTorchCuda ? '，重装' : ''}）`)
      if (options.reinstallTorch) {
        try {
          await runLive(python, ['-m', 'pip', 'uninstall', '-y', 'torch'])
        } catch { /* 未安装则忽略 */ }
      }
      try {
        await runLive(python, [
          '-m', 'pip', 'install', 'torch', '--index-url', TORCH_CUDA_INDEX,
          '--timeout', '300', '--retries', '3',
        ])
      } catch (error) {
        warn(`CUDA 版 torch 安装失败（${error.message}），回退 CPU 版 torch`)
      }
    } else if (existingTorchCuda) {
      log(`✓ 已安装 CUDA 版 torch（CUDA ${existingTorchCuda}）`)
    }

    await installWithMirrors(['-r', requirements, '--prefer-binary'])
    const finalTorchCuda = installedTorchCuda(python)
    log(`torch CUDA：${finalTorchCuda || '无（CPU 版）'}`)
    if (decision.useCuda && !finalTorchCuda) {
      warn('检测到可用 GPU 但 torch 是 CPU 版：审计仍可运行，只是用 CPU。'
        + '可重跑：node setup.mjs --reinstall-torch')
    }
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
