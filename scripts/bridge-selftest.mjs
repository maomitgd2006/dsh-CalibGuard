#!/usr/bin/env node
/**
 * 部署自检：打印 CalibGuard 引擎状态，并按需审计给定路径。
 *
 * 用法：
 *   node scripts/bridge-selftest.mjs                    # 只看引擎状态
 *   node scripts/bridge-selftest.mjs <路径> [更多路径…]  # 状态 + 审计
 *   node scripts/bridge-selftest.mjs --device cpu <路径> # 强制 CPU
 *
 * 与在 DSH 里调用工具等价：走同一条桥接进程与同一份配置。
 */
import { normalizeConfig } from '../lib/config.js'
import { CalibGuardEngine } from '../lib/engine.js'
import { buildTools } from '../lib/tools.js'

const argv = process.argv.slice(2)
const overrides = {}
const paths = []
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (token === '--device') overrides.device = argv[++index]
  else if (token === '--no-gui-settings') overrides.useGuiSettings = false
  else if (token === '--report-dir') overrides.reportDir = argv[++index]
  else if (token === '--max-files') overrides.maxFiles = Number(argv[++index])
  else if (token === '--credential-ref') overrides.credentialRef = argv[++index]
  else if (token === '-h' || token === '--help') {
    console.log('用法：node scripts/bridge-selftest.mjs [--device auto|cpu|cuda] [--no-gui-settings] [--credential-ref <名>] [--report-dir <dir>] [--max-files N] [路径…]')
    process.exit(0)
  } else paths.push(token)
}

const config = normalizeConfig(overrides)
const engine = new CalibGuardEngine({
  config,
  logger: { debug: () => {}, info: () => {}, warn: (message) => console.error(`[warn] ${message}`) },
})

try {
  const status = await engine.inspect()
  console.log('== CalibGuard 引擎状态 ==')
  console.log(`引擎目录   : ${status.engineRoot}（v${status.engineVersion}）`)
  console.log(`Python     : ${status.python} ｜ torch ${status.torch} ｜ CUDA 可用 ${status.cudaAvailable}`)
  console.log(`推理设备   : ${status.device}`)
  console.log(`设备定档   : ${status.devicePolicy?.mode} —— ${status.devicePolicy?.reason}`)
  console.log(`模型权重   : ${status.modelPresent ? `${(status.modelBytes / 1048576).toFixed(1)} MB` : '缺失'}`)
  console.log(`校准参数   : ${status.calibrationPresent ? `platt A=${status.calibration?.A} B=${status.calibration?.B}（${status.calibration?.n_samples} 条）` : '缺失'}`)
  console.log(`门控阈值   : 放行 < ${status.gate.allowThreshold} ｜ 拦截 > ${status.gate.blockThreshold}`)
  console.log(`云端复核   : ${status.llm.enabled ? '启用' : '关闭'}${status.llm.configured ? '' : '（未配置凭据 → 灰区转人工）'}`)
  const credential = engine.diagnostics().credential
  console.log(`凭据来源   : ${credential.configured ? credential.source : '无（未配置 credentialRef / llmApiKey）'}`)
  const perf = status.performance ?? {}
  console.log(`滑窗/吞吐  : ${perf.maxLength ?? '?'} token 窗 ｜ 步长 ${perf.windowStride ?? '?'}`
    + ` ｜ ${perf.windowsPerSecond ? `${perf.windowsPerSecond} 窗口/秒（实测）` : '尚无实测吞吐'}`)
  console.log(`设置来源   : ${status.settingsSource}`)

  if (paths.length === 0) {
    console.log('\n（未给出路径，只做状态自检。追加路径即可审计。）')
  } else {
    const tools = buildTools({ engine, config })
    const value = await tools[0].execute({ paths }, {})
    console.log('\n== 审计结果 ==')
    console.log(tools[0].output.render({}, value)[0].text)
  }
} catch (error) {
  console.error(`\n[自检失败] ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  await engine.stop('selftest')
}
