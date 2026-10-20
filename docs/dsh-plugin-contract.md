# DSH 插件契约速查（在 DSH 0.1.5-rc.2 上实测提取）

> 来源：`<DSH_HOME>/profiles/node_modules/@deepseek-ai/*`（DSH 0.1.5-rc.2 / bundle 0.2.0-rc.2）
> 与 `<DSH_HOME>/profiles/<profile>/{package.json,cordis.patch.yml}`（`<DSH_HOME>` 默认 `~/.dsh`）。
> 每条都对应本仓库里已跑通或已核对过的实现，写下来是为了以后改插件时不必再逆向一遍。

## 1. 插件模块

DSH 的 loader 行 `name` 指向一个 ESM 模块，模块导出（`cordis` 会做 `exports.default ?? exports`）至少要有 `apply`：

```js
const name = 'my-plugin'          // 仅用于日志/诊断
const inject = ['tools']          // 服务依赖：缺失时插件不激活，出现时自动重载
const Config = z.object({...})    // 可选；缺省即跳过结构校验
function apply(ctx, config) { ... }
export { apply, inject, name, Config }
```

- `name` / `inject` / `Config` **都是可选的**；`apply` 必须存在。
- `Config` 必须是 StandardSchemaV1（schemastery 的 `z.object()` 就是）。**`.required()` 的键缺失会让该行启动失败**（`ValidationError: missing required value`），`.default(v)` 则补默认值。

## 2. 提供服务

```js
ctx.provide('calibguard', serviceObject)   // effect 作用域，fiber 卸载自动撤销；返回 disposer
```

- 用 `ctx.provide(...)`；**不要用 `ctx.set(...)`**（非 effect 作用域，且「未 provide 就 set」会抛错）。
- 服务类写法（`class X extends Service { constructor(ctx) { super(ctx, 'name') } }`）等价，构造时自动 provide。

## 3. 注册工具

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
ctx.tools.register(defineTool({
  name: 'calibguard_audit',
  description: '…模型可见的说明…',
  parameters: { path: { type: 'string', required: true, description: '…' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: {…} }, render: (args, value) => [{ type: 'text', text: '…' }] },
  timeoutMs: 600_000,                 // 必须是正有限数，否则定义期抛错
  isConcurrencySafe: () => true,      // 只有字面量 true 才允许并行派发
  async execute(args, exec) { … },    // 出错就 throw，DSH 会物化成 isError 结果
  presentCall: (args) => ({ card: 'generic', title: '…', kind: 'read' }),
}))
```

参数方言**不是**标准 JSON Schema：
- 根是**隐式开放对象**，`parameters` 直接写属性表；
- 必填是**每个属性**上的 `required: true`（不是 `required: [...]` 数组）；
- 对象节点必须显式给 `additionalProperties`；
- 可用节点：`string/number/integer/boolean/null`（可带 `enum`/`const`）、`array`（`items`）、`object`（`properties`+`additionalProperties`）、`{type:'json'}`（作者侧逃生舱，投影后退化为「仅注释」）、`oneOf`。
- `output.schema` 用的是**同一套方言**，但根要写成显式节点（`{type:'object', additionalProperties:false, properties:{…}}`）。
- **返回值会被 `output.schema` 严格校验**（校验失败即工具失败），随后深冻结后交给 `render`。

## 4. ContentBlock（render 的返回类型）

`{type:'text', text}` / `{type:'reasoning', text}` / `{type:'image', attachment}` / `{type:'file', attachment}` / `{type:'tool-call', id, name, arguments}` / `{type:'tool-result', toolCallId, content, isError?}`。
本插件只用 `text`。

## 5. 系统提示词

```js
ctx.systemPrompt.section({ name: 'calibguard', order: 1001, text: '…' })  // 返回 disposer
```
`PromptSection = { name, order, text | (ctx)=>string, complete? }`；没有 `render` 字段。
序数建议用 `ctx.systemPrompt.getSectionOrder('TOOL_BASH')`（=1000）等常量而非硬编码字面量。
`{{变量}}` 插值是**严格**的：写错变量名会抛错，所以本插件只用静态文本。
`systemPrompt` 用 `ctx.get('systemPrompt')` 可选获取，避免把它写进 `inject` 后在不含该服务的 profile 里永不激活。

## 6. 配置树与 patch 层

层的顺序：`dsh.profile.bundles` 里各 bundle 的 patch → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。**逐行覆盖，后写胜。**

patch 数组元素语义：
- `{ id, config }`：按 id 命中已有行，**整体替换**它的 `config`（不是深合并）；
- `{ id, disabled: true }`：停用该行；
- `{ insert: [...] }`（无 id）：把这些行**追加到根行列表末尾**；行内可以带 `config`；
- `{ id, insert: [...] }`：只对 group 有效（追加到该 group 的 `config` 数组）；
- 没有 `remove`/`groups`；删行 = 从源列表里去掉。id 找不到只是警告，不致命。

**`insert` 行里的路径型 `name` 会被自动改写成 `file://` URL**（相对 patch 文件所在目录解析），所以：

```yaml
- insert:
    - id: calibguard
      name: 'file:///<本包绝对路径>/lib/index.js'
      config: { device: auto }
```
或写绝对路径 `name: '<本包绝对路径>\lib\index.js'`（同样会被改写成 file://）。

**裸包名**从 profile 目录（`baseUrl`）解析，也就是必须能从 `profiles/<name>/node_modules` 或 `profiles/node_modules` 找到；找不到则该行启动失败（`Cannot find package`）。

## 7. 模块解析的坑

- 用 `file://` 行加载**仓库外的包**时，包内 `import '@deepseek-ai/xxx'` 是从**包自己所在目录**向上找 node_modules —— 不在 profile 里就会失败。
  → 两种解法：①（推荐）用 `dsh plugin --profile <p> add file:<路径>` 正规安装；②（源码开发）跑 `node scripts/link-dsh.mjs` 建目录联接。
  → 本插件还做了第三层保险：所有 DSH 依赖都是**动态 import + 失败退化**，因此即使两个都没做，插件仍能加载（只是少了 Config 结构校验与 defineTool 定义期校验）。
- 传给 `spawn` 的脚本路径必须是**真实文件路径**（`fileURLToPath`），URL 对象会被序列化成 `file:///…` 交给子进程，Python 打不开。

## 8. 客户端半边（web）

**不需要打包器**：包在 `package.json` 里声明
```json
"dsh": { "client": { "platform": "web", "inject": [] } },
"exports": { "./client": "./lib/client.js" }
```
客户端 bundle 必须是 **classic script**（不是 ESM），形如：

```js
window.__ModuleLoader__.load({
  id: 'dsh-calibguard',                    // 必须等于 package.json 的 name
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    const { jsx } = require('react/jsx-runtime')
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
        { name: 'tool.call.toolview', key: 'calibguard_audit' }, Row))
    }
    exports.apply = apply; exports.inject = inject; return module.exports
  },
})
```

- scaffold 从 loader 行解析包根并取 `package.json.name` 作为模块 id，所以**插件行必须指向一个真实包**（有 package.json）。
- `require` 只解析「种子表 + 启动图行」：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
- 已核实的 slot：工具卡片 `tool.call.toolview`（`key` = **工具名**，渲染时附加 `entryKey`/`fallback` 两个 prop）；设置页 `settings.plugin.item`（`key` = 设置命名空间，需要 host 侧 `ctx.settings.installSection` 配合）。

> 本插件早期版本曾**故意不带客户端半边**（当时无法在开发机上验证浏览器侧代码，而 client bundle 在宿主启动时就会被读取，缺文件会直接抛 `MissingClientBundleError`）。
> **现已实现**：侧边栏图标 + `main` 面板 + 宿主 HTTP 路由，见 README「浏览器面板」一节；UI 起不来也不会影响工具。

## 9. 其它已验证事实

- profile 的 `desktop` 名称被 Electron 独占：`dsh --profile desktop ...` 的启动 / dump-config / plugin 管理请求会被 CLI 拒绝。
- `profiles/web/package.json` 的 `dsh.profile.patchReload: "live"` 才会热应用 patch；`desktop` 未声明该字段（默认启动时应用一次）。
- 工具/服务/provider 的 inspect 能力（`cordis_inspect_*`）是插件开发时确认契约的首选入口：`host/Service`、`client/Slots`、`client/Builtin`、`client/Theme`。

## 10. 凭据与子进程环境（写任何 spawn 子进程的插件都该看）

**平台规则**（`@deepseek-ai/dsh-subprocess`）：

```js
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;   // 词根匹配，大小写不敏感
function scrubbedParentEnv() {                                 // ← 这个函数**是导出的**
  // 去掉敏感名 与 全部 DSH_* 前缀；PATH/HOME/locale/proxy 保留
}
```
外部插件可以直接 `import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'` 复用，
不必复制那条正则（本插件就是这么做的，见 `lib/env.js`）。注意该启发式**不覆盖** `CREDENTIAL`、
`AUTH` 等词根——真实凭据通常落在 `*_KEY / *_TOKEN / *_SECRET / *PASSWORD` 上，但别把它当全集。

**正确的凭据获取方式**：`ctx.credentials.resolve(ref)`（`@deepseek-ai/dsh-credentials`）。

```js
const inject = ['tools']                       // credentials 用可选方式取，别进 inject
const credentials = ctx.get('credentials')     // 可能不存在
const resolved = await credentials.resolve('DEEPSEEK_API_KEY')  // 运行时传字符串即可（brand 只在类型层）
// resolved = { value: string, source: 'env' | 'file' | 'project-env' | 'user-env' } | undefined
```
- 分层优先级（`dsh-credentials-local` 原文）：**继承的进程环境**（最高，只读）> `$DSH_HOME/.credentials.yaml`（可写）> `<cwd>/.env` > `$DSH_HOME/.env`。
- 契约要求「**每次操作重新解析，不得跨操作缓存**」，这样凭据轮换无需重启。
- 给子进程传凭据时：放进请求体走 stdin 管道，**不要**放 argv（进程列表可见）或环境变量（等于把秘密暴露给整个子进程树）。

## 11. 浏览器 UI：侧边栏面板 + 宿主 HTTP 路由（在 DSH 0.1.5-rc.2 上实测）

### 11.1 一个"自己的页面"怎么挂

DSH 的面板模型：**左侧 `sidebar.panellist` 放图标，`main` 按 key 渲染页面** —— 点击图标时
设置是被 `ctx.layout.selectPanel(id)` 驱动的，所以两处要用**同一个 id**。

```js
// client half：inject = ['slots']
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'my-panel', order: 50, label: () => 'My Panel' },
  GlyphComponent,                       // 收到 props { size, active }，只负责画图标
))

ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'my-panel' },    // key 与上面的 id 一致
  PanelComponent,
))
```
- `sidebar.panellist` 的条目由外壳渲染成按钮（带 Tooltip、`aria-current`、label），组件只返回 glyph。
- `main` 是 keyed slot，`keyDomain: open`（已占用：`conversation`）——新 key 不冲突。
- 外壳实现参考：`dsh-client-ui-sidebar/lib/client.js`（`syncPanels` / `selectPanel`）、
  `dsh-client-ui-conversation/lib/client.js`（`slots.register({ name:'main', key:'conversation' })`）。

### 11.2 宿主 HTTP 路由

```js
const webServer = ctx.get('webServer')          // 可选依赖，别写进 inject
const disposer = webServer.register({
  kind: 'exact',                                 // 'exact' | 'prefix'
  path: '/api/my-plugin/thing',
  handler: (req, res) => { /* 完整持有 Node 的 req/res 生命周期 */ },
})
```
- `webServer.getOrigin()` 返回 `http://127.0.0.1:<port>`。
- 重复的 `(kind, path)` 会抛错；卸载时调用返回的 disposer。
- ⚠️ **服务时序坑（实测踩过）**：不要在 `apply` 里用一次性的 `ctx.get('webServer')` ——
  插件 fiber 可能先于 `webServer` 就绪而激活，那一刻拿到 `undefined`，路由就**永久缺失**
  （浏览器表现：fetch 返回纯文本 `not found`，前端 `response.json()` 抛
  `Unexpected token 'o', "not found" is not valid JSON`）。正确写法：
  ```js
  ctx.inject(['webServer'], (webCtx) => {
    const dispose = webCtx.webServer.register(route)
    webCtx.effect(() => dispose)      // 服务重载/卸载时自动撤销，不会重复注册
  })
  ```
- ⚠️ 宿主对 `/` 与 `/api/*` **有鉴权**（从进程外 `Invoke-WebRequest` 一律 401）。所以排查要分开：
  **401 = 鉴权问题**，**纯文本 `not found` = 路由缺失**。
- 实测 `dsh-host-webserver` 里**没有**对自定义路由做 token/鉴权检查（全文搜不到 401/authorization），
  所以同源 `fetch('/api/...')` 即可用；`dsh-client-ui-deliverables/lib/client.js` 也是这么调宿主路径的。
- 前端永远先 `response.text()` 再按 `content-type` 决定是否 `JSON.parse`，否则就会遇到上面那个
  `Unexpected token` 报错而不是可读原因。
- multipart 不必解析：本插件的浏览器半边把 `File` 读成 base64 放进 JSON（宿主侧零依赖、有体积上限）。

### 11.3 文件上传的边界（本插件取值）

| 限制 | 值 |
|---|---|
| 请求体 | 32 MB（base64 后） |
| 解码后总字节 | 24 MB |
| 单次文件数 | 50 |
| 落盘位置 | 系统临时目录，审计完 `rm -rf` |

### 11.4 client bundle 的验收条件（扫描器视角）

- `package.json`：`dsh.client.platform === 'web'`、`exports["./client"]` 为字符串或 `{default}`；
- 文件必须存在（宿主启动时 `readFileSync`，缺失抛 `MissingClientBundleError`）；
- 必须是 **classic script**（不是 ESM），首行调用 `window.__ModuleLoader__.load({ id, factory })`；
- `id` 必须等于 `package.json.name`（扫描器用包名做模块 id）；
- factory 内 `require()` 只能命中种子表（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`）或 `dsh.client.external` 里声明的模块。
- **改完必须重启宿主**：bundle 只在启动时扫描，浏览器端的 HMR 只对仓库内自带插件（配合 `pnpm run dev:web`）生效。


