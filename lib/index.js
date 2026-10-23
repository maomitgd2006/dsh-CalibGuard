/**
 * CalibGuard × DeepSeek Harness 插件（host 半边）。
 *
 * 作用：把 CG_GUI 目录里那套未改动的 CalibGuard 审计引擎接进 DSH ——
 *   - 注册两个模型可见工具：calibguard_audit（审计文件/目录）与 calibguard_status（引擎就绪状态）；
 *   - 注册宿主 HTTP 路由（/api/calibguard/*），供浏览器面板拖拽上传、读写共享设置与看报告；
 *   - 通过 ctx.provide 暴露 `calibguard` 服务，供其它插件调用；
 *   - 可选地把「何时该用 CalibGuard」写进系统提示词；
 *   - 浏览器半边见 lib/client.js（侧边栏图标 + 主面板）。
 *
 * 零硬依赖：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 都是动态 import，
 * 拿不到时自动退化（恒等 defineTool / 无 Config 结构校验），因此本包既能装在 profile 的
 * node_modules 里，也能直接用 file:// 行从仓库路径加载。
 */
import { CalibGuardEngine } from './engine.js'
import { DEFAULT_CONFIG, loadConfigSchema, normalizeConfig, toBridgeOptions } from './config.js'
import { ROUTE_PREFIX, createCalibGuardRoutes } from './routes.js'
import { SettingsStore } from './settings.js'
import { buildTools } from './tools.js'

/** Cordis 插件名（只用于日志与诊断）。 */
const name = 'calibguard'

/** 硬依赖：没有工具注册表就什么都不做。其余服务按可选方式获取。 */
const inject = ['tools']

/**
 * Schemastery 配置 schema。拿不到 schemastery 时为 undefined ——
 * DSH 侧 Config 是可选项，缺省即跳过结构校验，插件仍按 normalizeConfig 自行校验。
 */
const Config = await loadConfigSchema()

/**
 * `defineTool` 同样按可选取用：它做定义期校验（schema 方言、timeoutMs 合法性等），
 * 拿不到时退化为恒等函数——DSH 的工具注册表接受等价的对象字面量。
 */
const defineTool = await import('@deepseek-ai/dsh-tools')
  .then((module) => (typeof module?.defineTool === 'function' ? module.defineTool : undefined))
  .catch(() => undefined)
  ?? ((definition) => definition)

/** 系统提示词片段（英文，与 Harness 其余提示词保持一致的语言）。 */
const PROMPT_SECTION_NAME = 'calibguard'
const PROMPT_TEXT = [
  '## CalibGuard file auditing',
  'This deployment has CalibGuard wired in: a locally fine-tuned, Platt-calibrated CodeBERT gate that',
  'classifies files as allow / suspicious / block / manual_review and only escalates its gray zone to a',
  'cloud LLM review when that is enabled. No file content leaves the machine for the local decision.',
  'Before you run, install, import, or ship code or packages you did not write yourself — especially',
  'freshly downloaded scripts, archives, dependencies, and generated code — call `calibguard_audit`.',
  'Treat `block` as "do not execute without human review", `manual_review` as "inconclusive, ask the',
  'user", and `allow` as "no meaningful signal found" rather than a safety guarantee.',
  'If an audit errors, call `calibguard_status` to check engine readiness before retrying.',
  'When the user wants to change CalibGuard behavior (gate thresholds, cloud review, delivery mode,',
  'directory limits) but does not know where, call `calibguard_configure` — it writes the shared settings',
  'used by both the panel and your calls. That tool can never read or write API keys: if the user needs',
  'to set a key, ask them to fill it in the CalibGuard panel (never ask for the key in chat).',
].join('\n')

/**
 * 注册工具、服务与提示词。
 *
 * @param {object} ctx cordis 上下文（已保证 ctx.tools 可用）
 * @param {object} rawConfig patch 行里的 config（可能为空）
 */
function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console

  if (!config.enabled) {
    logger.info?.('[calibguard] 插件已按配置禁用（config.enabled=false）')
    return
  }

  // ---------- 注册工具 ----------
  // credentials 是可选服务：有就走 DSH 的分层凭据解析（credentialRef），
  // 没有就退回「按配置名读同名环境变量」——两条路都不硬编码任何凭据名。
  const credentials = ctx.get?.('credentials')

  // GUI 与 AI 共用的设置：面板保存后，工具调用同样使用这份参数（调用级参数仍可覆盖）。
  const settingsStore = new SettingsStore({ file: config.settingsPath || undefined, logger })
  const engine = new CalibGuardEngine({ config, logger, credentials, settingsStore })
  logger.info?.(`[calibguard] 共享设置文件：${settingsStore.file}`
    + `${Object.keys(settingsStore.get()).length > 0 ? `（已加载 ${Object.keys(settingsStore.get()).length} 项）` : '（当前为空，跟随插件配置）'}`)
  if (config.credentialRef && !credentials) {
    logger.debug?.('[calibguard] 未找到 credentials 服务，credentialRef 将按同名环境变量解析')
  }

  // 首启自动装环境：不阻塞插件激活，后台准备引擎（内置代码 + npm 模型分片）/建 venv/装依赖。
  try {
    engine.warmup()
  } catch (error) {
    logger.warn?.(`[calibguard] 启动环境预热失败：${error?.message ?? error}`)
  }

  /**
   * 把清理函数挂到当前 fiber 上。
   *
   * 用 `ctx.effect(() => disposer)`：cordis 保证 fiber 卸载时按逆序执行这些 disposer，
   * 这与 `ctx.provide` 内部用的是同一套机制。只有在上下文不支持 effect 时才退化为
   * 「数组 + dispose 事件」的老式写法。
   */
  const fallbackCleanups = []
  const scoped = (disposer, label) => {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposer, label)
      return
    }
    fallbackCleanups.push(disposer)
  }

  for (const definition of buildTools({ engine, config, define: defineTool })) {
    const dispose = ctx.tools.register(definition)
    if (typeof dispose === 'function') scoped(dispose, `calibguard:unregister(${definition.name})`)
  }

  // ---------- 可选：浏览器面板用的宿主 HTTP 路由 ----------
  //
  // 关键教训：**不能用一次性的 ctx.get('webServer')** —— 插件 fiber 可能先于
  // webServer 服务就绪而激活，那一刻 get 拿到 undefined，路由就永久缺失
  //（浏览器端表现为 fetch 返回纯文本 "not found"、JSON.parse 报错）。
  // 正确做法是 ctx.inject(['webServer'], cb)：服务出现后 cb 自动执行，
  // 服务消失/重载时其作用域内的路由会被撤销，不会重复注册。
  const registerRoutes = (webCtx) => {
    try {
      const { routes } = createCalibGuardRoutes({ engine, config, logger, settingsStore })
      let count = 0
      for (const route of routes) {
        const dispose = webCtx.webServer.register(route)
        if (typeof dispose === 'function') {
          if (typeof webCtx.effect === 'function') webCtx.effect(() => dispose, `calibguard:route(${route.path})`)
          else scoped(dispose, `calibguard:route(${route.path})`)
        }
        count += 1
      }
      logger.info?.(`[calibguard] UI 路由已注册（${count} 条）：${ROUTE_PREFIX}/{status,audit,report,settings,credential}`)
    } catch (error) {
      logger.warn?.(`[calibguard] 注册 UI 路由失败（不影响工具）：${error?.message ?? error}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx))
    } catch (error) {
      logger.warn?.(`[calibguard] 注入 webServer 失败：${error?.message ?? error}`)
    }
  } else if (ctx.get?.('webServer')?.register) {
    registerRoutes(ctx)
  } else {
    logger.debug?.('[calibguard] 未找到 webServer 服务，跳过 UI 路由（工具仍可用）')
  }

  // ---------- 可选：系统提示词片段 ----------
  if (config.announceToModel) {
    const systemPrompt = ctx.get?.('systemPrompt')
    if (systemPrompt?.section) {
      try {
        const order = typeof systemPrompt.getSectionOrder === 'function'
          ? systemPrompt.getSectionOrder('TOOL_BASH')
          : 1000
        const dispose = systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: Number.isFinite(order) ? order + 1 : 1001,
          text: PROMPT_TEXT,
        })
        if (typeof dispose === 'function') scoped(dispose, 'calibguard:prompt-section')
      } catch (error) {
        logger.warn?.(`[calibguard] 注册系统提示词片段失败（忽略）：${error?.message ?? error}`)
      }
    } else {
      logger.debug?.('[calibguard] 未找到 systemPrompt 服务，跳过提示词片段')
    }
  }

  // ---------- 可选：暴露 calibguard 服务 ----------
  const service = {
    /** 归一化后的插件配置。 */
    config,
    /** op=status：引擎/模型/校准/设备/LLM 就绪快照。 */
    inspect: (options) => engine.inspect(options),
    /** 审计一组路径，返回与 calibguard_audit 相同的结构。 */
    audit: (paths, options, runOptions) => engine.audit(paths, options, runOptions),
    /** 把插件配置摊成桥接 options（供其它插件复用同一套阈值/LLM 设置）。 */
    bridgeOptions: () => toBridgeOptions(config),
    /** 运行诊断（进程 pid、stderr 尾巴、上次退出、最近一次凭据来源）。 */
    diagnostics: () => engine.diagnostics(),
    /** 运行环境快照（首次运行自动准备引擎/venv 的状态与进度）。 */
    environment: () => engine.environment(),
    /** 解析云端复核凭据（每次调用重新解析；返回 { key, source }，供诊断/自检用）。 */
    resolveCredential: () => engine.resolveCredential(),
    /** 把云端复核 Key 写入 DSH 凭据库（面板「API Key → 保存」走这里，需要配置 credentialRef）。 */
    setCredential: (value) => engine.setCredential(value),
    /** 主动停机（通常不需要，插件卸载时会自动调用）。 */
    dispose: () => engine.stop('service.dispose'),
  }
  if (typeof ctx.provide === 'function') {
    // ctx.provide 是 effect 作用域的：fiber 卸载时服务自动撤销
    ctx.provide('calibguard', service)
    logger.info?.(`[calibguard] 已就绪：引擎 ${config.engineRoot}，设备定档 ${config.device}`)
  } else {
    logger.warn?.('[calibguard] 当前上下文不支持 ctx.provide，仅注册工具（不暴露服务）')
  }

  // ---------- 卸载清理：停子进程 ----------
  scoped(() => { engine.stop('plugin.dispose').catch(() => {}) }, 'calibguard:stop-bridge')

  if (typeof ctx.effect !== 'function' && typeof ctx.on === 'function') {
    // 退化路径：上下文没有 effect 时用 dispose 事件兜底（仅测试/极简宿主会走到）
    ctx.on('dispose', () => {
      for (const cleanup of fallbackCleanups.splice(0)) {
        try { cleanup() } catch { /* 已失效 */ }
      }
    })
  }
}

export { apply, inject, name, Config, DEFAULT_CONFIG }
