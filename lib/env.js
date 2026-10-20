/**
 * 子进程环境构造：**不把宿主的凭据隐式传给桥接进程**。
 *
 * DSH 自己就是这么做的（`dsh-subprocess` 的 `scrubbedParentEnv`）：凡名字形如
 * `*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*` 的变量，以及全部 `DSH_*` 变量，
 * 都不进子进程；调用方要传凭据必须**显式**给。
 *
 * 本模块两种来源，按优先级：
 *   1. 优先复用 `@deepseek-ai/dsh-subprocess` 真正导出的 `scrubbedParentEnv()`
 *      —— 与平台策略永远同步，不复制它的正则；
 *   2. 拿不到该包时（例如脱离 DSH 单独跑测试）退化为本地实现，敏感名模式由
 *      配置 `sensitiveEnvPattern` 提供（默认值只是兜底启发式，可配置）。
 *
 * 凭据本身**不经过这里**：插件解析到的 Key 通过请求 options 走 stdin 管道传给
 * 桥接进程（不进 argv、不进子进程环境），见 engine.js。
 */

/** 本地兜底用的敏感名模式（可由配置覆盖；仅为「拿不到平台实现」时的启发式）。 */
export const FALLBACK_SENSITIVE_ENV_PATTERN = 'KEY|PASSWORD|SECRET|TOKEN'

/** 平台实现缓存：`null` = 尚未尝试，`undefined` = 不可用。 */
let platformScrub = null

/**
 * 懒加载平台实现。
 * @returns {(() => Record<string, string>) | undefined}
 */
async function platformScrubbedParentEnv() {
  if (platformScrub !== null) return platformScrub
  try {
    const module = await import('@deepseek-ai/dsh-subprocess')
    platformScrub = typeof module?.scrubbedParentEnv === 'function'
      ? module.scrubbedParentEnv
      : undefined
  } catch {
    platformScrub = undefined
  }
  return platformScrub
}

/**
 * 本地兜底清洗：去掉敏感名与 `DSH_*`（与平台同一条规则：大小写不敏感）。
 *
 * @param {Record<string, string | undefined>} source 父环境
 * @param {object} [options]
 * @param {string} [options.pattern] 敏感名正则（字符串形式，来自配置）
 * @returns {Record<string, string>}
 */
export function scrubEnvFallback(source, { pattern = FALLBACK_SENSITIVE_ENV_PATTERN } = {}) {
  let sensitive
  try {
    sensitive = new RegExp(pattern, 'i')
  } catch {
    // 配置里的正则非法时，退回内置兜底（不因为一个坏配置把机密漏出去）
    sensitive = new RegExp(FALLBACK_SENSITIVE_ENV_PATTERN, 'i')
  }
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (sensitive.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

/**
 * 构造桥接进程的环境变量。
 *
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.source] 父环境（默认 process.env）
 * @param {string} [options.pattern] 兜底模式（来自配置 sensitiveEnvPattern）
 * @param {Record<string, string>} [options.explicit] 显式补充的变量（会覆盖清洗结果）
 * @returns {Promise<Record<string, string>>} 可安全交给 spawn 的环境
 */
export async function buildChildEnv({ source = process.env, pattern, explicit = {} } = {}) {
  // 平台实现只作用于真实 process.env；显式传入其它 source（测试）时用兜底实现，
  // 这样「规则」仍然一致，而调用方也能拿到确定性的结果。
  const platform = source === process.env ? await platformScrubbedParentEnv() : undefined
  const base = platform
    ? platform()
    : scrubEnvFallback(source, { pattern })
  return { ...base, ...explicit }
}

/** 当前是否在用平台实现（诊断用，便于说明「为什么这里没有重复实现规则」）。 */
export async function usingPlatformScrub() {
  return Boolean(await platformScrubbedParentEnv())
}
