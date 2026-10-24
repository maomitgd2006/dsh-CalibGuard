/**
 * CalibGuard 浏览器半边（DSH client plugin，纯 JS，无需打包器）。
 *
 * 注册两处 UI：
 *   1. `sidebar.panellist` 的图标（id=calibguard）—— 点击后由 DSH 的 layout 切换到该面板；
 *   2. `main` 的 keyed 面板（key=calibguard）—— 审计页面。
 *
 * 设置区**照着 CG_GUI/web/index.html 的设置面板做**：
 *   云端复核开关 → LLM 组（API Key / Base URL / 模型名称 / 送审内容 / 投递方式 +
 *   联动显隐的截断大小、滑窗大小、滑窗重叠）→ 灰区范围（下限~上限）→ 保存。
 *   保存进「共享设置」，AI 工具调用同样使用（等价于 CG_GUI 的 gui-settings.json）。
 *
 * 约定：本文件是 classic script，由 `/plugins/.../client.js` 直接加载；
 * 必须调用 `window.__ModuleLoader__.load({ id, factory })`，id === package.json 的 name；
 * factory 内只能 require 种子模块（这里只用 react / react/jsx-runtime）。
 * 整文件不抛异常；apply 内每处注册各自 try/catch —— UI 起不来不能拖垮 Harness 界面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-calibguard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var jsxRuntime = require('react/jsx-runtime')
    var jsx = jsxRuntime.jsx
    var jsxs = jsxRuntime.jsxs
    var Fragment = jsxRuntime.Fragment
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useRef = React.useRef

    var API = '/api/calibguard'
    var PANEL_ID = 'calibguard'
    var PANEL_LABEL = 'CalibGuard'

    // ============================== 样式（中性灰阶，明暗主题都可用） ==============================

    var C = {
      border: 'rgba(127,127,127,.32)',
      soft: 'rgba(127,127,127,.10)',
      softer: 'rgba(127,127,127,.05)',
      text: 'inherit',
      muted: 'rgba(127,127,127,.95)',
      block: '#d84a3d',
      suspicious: '#d98a1a',
      manual: '#b8860b',
      allow: '#2f9e63',
      error: '#d84a3d',
    }

    var S = {
      page: { height: '100%', overflow: 'auto', padding: '20px 24px 40px', color: C.text, fontSize: 13 },
      head: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' },
      title: { fontSize: 17, fontWeight: 600, margin: 0 },
      badge: { padding: '2px 8px', borderRadius: 999, border: '1px solid ' + C.border, fontSize: 12, color: C.muted },
      card: { border: '1px solid ' + C.border, borderRadius: 10, padding: 14, marginBottom: 14, background: C.softer },
      cardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 10 },
      drop: {
        border: '2px dashed ' + C.border,
        borderRadius: 10,
        padding: '26px 18px',
        textAlign: 'center',
        color: C.muted,
        cursor: 'pointer',
        background: C.softer,
        transition: 'border-color .15s, background .15s',
      },
      dropActive: { borderColor: C.allow, background: 'rgba(47,158,99,.08)' },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, marginTop: 10 },
      group: { borderTop: '1px solid ' + C.border, marginTop: 12, paddingTop: 4 },
      groupOff: { opacity: 0.5 },
      label: { color: C.muted },
      input: {
        padding: '6px 8px', borderRadius: 6, border: '1px solid ' + C.border,
        background: 'transparent', color: C.text, fontSize: 13, outline: 'none',
        width: '100%', boxSizing: 'border-box',
      },
      inputDisabled: { opacity: 0.55 },
      textarea: {
        width: '100%', minHeight: 68, padding: '8px 10px', borderRadius: 6,
        border: '1px solid ' + C.border, background: 'transparent', color: C.text,
        fontSize: 13, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit',
      },
      button: {
        padding: '7px 16px', borderRadius: 7, border: '1px solid ' + C.border,
        background: C.soft, color: C.text, fontSize: 13, cursor: 'pointer', fontWeight: 500,
      },
      buttonPrimary: {
        padding: '7px 18px', borderRadius: 7, border: '1px solid ' + C.allow,
        background: 'rgba(47,158,99,.14)', color: C.text, fontSize: 13, cursor: 'pointer', fontWeight: 600,
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
        borderRadius: 999, border: '1px solid ' + C.border, fontSize: 12, background: C.softer,
      },
      err: {
        border: '1px solid ' + C.error, borderRadius: 8, padding: 10, marginTop: 12,
        color: C.error, fontSize: 12, whiteSpace: 'pre-wrap',
      },
      note: { color: C.muted, fontSize: 12, marginTop: 6, lineHeight: 1.5 },
      range: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 },
      summary: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 },
      pill: { borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, border: '1px solid ' + C.border },
      item: { border: '1px solid ' + C.border, borderRadius: 9, padding: 12, marginBottom: 10, background: C.softer },
      itemHead: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' },
      path: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
      meta: { color: C.muted, fontSize: 12, marginTop: 4, fontFamily: 'ui-monospace, Consolas, monospace' },
      pre: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.55,
        border: '1px solid ' + C.border, borderRadius: 8, padding: 12, background: C.softer,
        maxHeight: 420, overflow: 'auto', fontFamily: 'ui-monospace, Consolas, monospace',
      },
      muted: { color: C.muted, fontSize: 12 },
      link: { color: C.allow, cursor: 'pointer', textDecoration: 'underline', fontSize: 12 },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', fontWeight: 500 },
    }

    var DECISION_LABEL = {
      block: 'BLOCK 拦截',
      suspicious: 'SUSPICIOUS 可疑',
      manual_review: 'MANUAL 转人工',
      allow: 'ALLOW 放行',
    }
    var DECISION_COLOR = {
      block: C.block,
      suspicious: C.suspicious,
      manual_review: C.manual,
      allow: C.allow,
    }
    var DECISION_ORDER = ['block', 'manual_review', 'suspicious', 'allow']

    /** CG_GUI 的默认值（读不到引擎状态时兜底，与 config.py 的 AppConfig 一致）。 */
    var FALLBACK = {
      llmEnabled: true,
      llmBaseUrl: 'https://api.deepseek.com',
      llmModel: 'deepseek-chat',
      allowThreshold: 0.15,
      blockThreshold: 0.85,
      llmContentSource: 'evidence',
      llmDeliveryMode: 'truncate',
      llmTruncateChars: 3000,
      llmWindowChars: 3000,
      llmWindowOverlap: 500,
      maxFiles: 20,
      windowStride: 256,
      // 其他 DSH 插件扫描 / 本插件自更新检查（面板可改，存共享设置）
      pluginScanMode: 'update',
      pluginScanMaxFiles: 100,
      selfUpdateCheck: 'startup',
    }

    // ============================== 小工具 ==============================

    function update(map, key, value) {
      var next = {}
      for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) next[k] = map[k]
      next[key] = value
      return next
    }

    function toNumberOrUndefined(value) {
      if (value === '' || value === null || value === undefined) return undefined
      var num = Number(value)
      return Number.isFinite(num) ? num : undefined
    }

    /** File → base64（不含 data URL 前缀）。 */
    function fileToBase64(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader()
        reader.onload = function () {
          var result = String(reader.result || '')
          var comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : '')
        }
        reader.onerror = function () { reject(new Error('读取文件失败：' + file.name)) }
        reader.readAsDataURL(file)
      })
    }

    /**
     * 统一接口请求：先按文本读、再按 content-type 决定是否 JSON.parse。
     *
     * 这样即使宿主返回纯文本（路由缺失时的 "not found"、鉴权失败等），
     * 也会变成一句可读错误，而不是 `Unexpected token ...` 解析异常。
     */
    function apiFetch(path, options) {
      return fetch(API + path, options).then(function (response) {
        return response.text().then(function (text) {
          var contentType = String((response.headers && response.headers.get('content-type')) || '')
          if (contentType.indexOf('application/json') < 0) {
            var hint = ''
            if (response.status === 401 || response.status === 403) hint = '（鉴权失败：请在 Harness 里保持已登录）'
            else if (String(text).trim() === 'not found') hint = '（接口未注册：插件路由没挂上，通常需要重启 DSH 生效）'
            else if (response.status === 404) hint = '（404：接口或报告不存在）'
            throw new Error('接口返回非 JSON（HTTP ' + response.status + '）' + hint + '：' + String(text).slice(0, 120))
          }
          var payload
          try {
            payload = JSON.parse(text)
          } catch (error) {
            throw new Error('接口返回的 JSON 无法解析：' + String(text).slice(0, 120))
          }
          if (!response.ok || (payload && payload.ok === false)) {
            throw new Error((payload && payload.error) || ('HTTP ' + response.status))
          }
          return payload
        })
      })
    }

    function evidenceLine(evidence) {
      if (!evidence || typeof evidence !== 'object') return ''
      var groups = [
        ['危险API', evidence.dangerous_apis],
        ['网络', evidence.network_indicators],
        ['凭据', evidence.credential_access],
        ['混淆', evidence.obfuscation_signals],
        ['文件操作', evidence.file_operations],
        ['注入话术', evidence.injection_phrases],
        ['高熵串', evidence.high_entropy_strings],
      ]
      var parts = []
      for (var i = 0; i < groups.length; i++) {
        var values = groups[i][1]
        if (Array.isArray(values) && values.length > 0) parts.push(groups[i][0] + ': ' + values.slice(0, 4).join(' , '))
      }
      return parts.join(' | ')
    }

    /** 照抄 CG_GUI validateSettings 的校验口径（后端仍是权威）。 */
    function validateForm(form) {
      if (!(form.allowThreshold > 0 && form.allowThreshold < form.blockThreshold && form.blockThreshold < 1)) {
        return '灰区范围必须满足 0 < 下限 < 上限 < 1'
      }
      if (!form.llmEnabled) return ''
      if (!String(form.llmBaseUrl || '').trim()) return '启用云端复核时 Base URL 不能为空'
      if (!String(form.llmModel || '').trim()) return '启用云端复核时模型名称不能为空'
      if (form.llmDeliveryMode === 'truncate' && !(form.llmTruncateChars >= 1)) return '截断大小必须 ≥ 1'
      if (form.llmDeliveryMode === 'window') {
        if (!(form.llmWindowChars >= 1)) return '滑窗大小必须 ≥ 1'
        if (!(form.llmWindowOverlap >= 0 && form.llmWindowOverlap < form.llmWindowChars)) {
          return '滑窗重叠必须满足 0 ≤ 重叠 < 滑窗大小'
        }
      }
      return ''
    }

    // ============================== 侧边栏图标 ==============================

    function Glyph(props) {
      var size = (props && props.size) || 16
      return jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', { key: 'shield', d: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z' }),
          jsx('path', { key: 'check', d: 'M9 12.2l2.1 2.1L15.4 10' }),
        ],
      })
    }

    // ============================== 结果条目 ==============================

    function ResultItem(props) {
      var item = props.item
      var color = DECISION_COLOR[item.final_decision] || C.muted
      var p = Number(item.calibrated_probability || 0)
      var reportId = String(item.report_md_path || '').split(/[\\/]/).pop().replace(/\.md$/, '')
      return jsx('div', {
        style: S.item,
        children: jsxs(Fragment, {
          children: [
            jsxs('div', {
              style: S.itemHead,
              children: [
                jsx('span', { style: Object.assign({}, S.pill, { color: color, borderColor: color }), children: DECISION_LABEL[item.final_decision] || item.final_decision }),
                jsx('span', { style: S.path, children: item.file_path }),
                jsx('span', { style: S.meta, children: 'p=' + p.toFixed(4) }),
                jsx('span', { style: S.meta, children: item.gate_decision }),
              ],
            }),
            jsx('div', {
              style: S.meta,
              children: 'size=' + item.file_size_bytes + 'B ｜ windows=' + item.windows_evaluated
                + (item.early_stopped ? ' (early-stop)' : '')
                + ' ｜ sha256=' + String(item.file_sha256 || '').slice(0, 16) + '…',
            }),
            evidenceLine(item.evidence) ? jsx('div', { style: S.meta, children: evidenceLine(item.evidence) }) : null,
            item.llm && item.llm.status && item.llm.status !== 'disabled'
              ? jsx('div', {
                style: S.meta,
                children: 'LLM: ' + item.llm.status + ' ｜ risk=' + (item.llm.risk || '-')
                  + ' ｜ ' + (item.llm.reason || '') + (item.llm.action ? ' ｜ ' + item.llm.action : ''),
              })
              : null,
            item.consistency_warning ? jsx('div', { style: { color: C.manual, fontSize: 12 }, children: '⚠ 一致性告警：本地概率高但 LLM 判 low' }) : null,
            item.error ? jsx('div', { style: { color: C.error, fontSize: 12, whiteSpace: 'pre-wrap' }, children: '⚠ ' + item.error }) : null,
            reportId
              ? jsx('div', {
                style: { marginTop: 6 },
                children: jsx('span', { style: S.link, onClick: function () { props.onOpenReport(reportId) }, children: '查看 Markdown 报告' }),
              })
              : null,
          ],
        }),
      })
    }

    // ============================== 主面板 ==============================

    function Panel() {
      var statusState = useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var statusErrorState = useState('')
      var statusError = statusErrorState[0]
      var setStatusError = statusErrorState[1]

      var droppedState = useState([])
      var dropped = droppedState[0]
      var setDropped = droppedState[1]

      var pathsState = useState('')
      var pathsText = pathsState[0]
      var setPathsText = pathsState[1]

      var formState = useState(Object.assign({}, FALLBACK))
      var form = formState[0]
      var setForm = formState[1]
      var setField = function (key, value) { setForm(function (current) { return update(current, key, value) }) }

      var apiKeyState = useState('')
      var apiKey = apiKeyState[0]
      var setApiKey = apiKeyState[1]

      // 凭据名（保存位置的名字）；留空则用插件配置里的 credentialRef
      var credNameState = useState('')
      var credName = credNameState[0]
      var setCredName = credNameState[1]

      // torch 重装提示（面板按钮/结果）
      var torchMsgState = useState('')
      var torchMsg = torchMsgState[0]
      var setTorchMsg = torchMsgState[1]

      // 其他插件扫描提示
      var pluginScanMsgState = useState('')
      var pluginScanMsg = pluginScanMsgState[0]
      var setPluginScanMsg = pluginScanMsgState[1]

      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var resultState = useState(null)
      var result = resultState[0]
      var setResult = resultState[1]

      var reportState = useState(null)
      var report = reportState[0]
      var setReport = reportState[1]

      var dragState = useState(false)
      var dragging = dragState[0]
      var setDragging = dragState[1]

      var msgState = useState('')
      var settingsMsg = msgState[0]
      var setSettingsMsg = msgState[1]
      var fileState = useState('')
      var settingsFile = fileState[0]
      var setSettingsFile = fileState[1]
      var credState = useState({ ref: null, writable: false, configured: false })
      var credential = credState[0]
      var setCredential = credState[1]

      var fileInput = useRef(null)

      useEffect(function () {
        refreshStatus()
        loadSettings()
      }, [])

      useEffect(function () {
        if (!torchRunning) return undefined
        var timer = setInterval(refreshStatus, 3000)
        return function () { clearInterval(timer) }
      }, [torchRunning])
      useEffect(function () {
        if (!pluginScanRunning) return undefined
        var timer = setInterval(refreshStatus, 3000)
        return function () { clearInterval(timer) }
      }, [pluginScanRunning])
      useEffect(function () {
        if (torchState === 'done') refreshStatus()
      }, [torchState])

      function applyStatus(payload) {
        var data = (payload && payload.status) || {}
        var llm = data.llm || {}
        var gate = data.gate || {}
        var perf = data.performance || {}
        setCredential({
          ref: (payload && payload.credentialRef) || null,
          writable: Boolean(payload && payload.credentialWritable),
          configured: Boolean(llm.configured),
        })
        setCredName(function (prev) { return prev || (payload && payload.credentialRef) || 'DEEPSEEK_API_KEY' })
        var scanOptions = payload && payload.pluginScan && payload.pluginScan.options
        var selfOptions = payload && payload.selfUpdate && payload.selfUpdate.options
        if (scanOptions || selfOptions) {
          setForm(function (current) {
            var next = current
            if (scanOptions) {
              next = update(next, 'pluginScanMode', scanOptions.mode || 'update')
              next = update(next, 'pluginScanMaxFiles', scanOptions.maxFiles || 100)
            }
            if (selfOptions) next = update(next, 'selfUpdateCheck', selfOptions.mode || 'startup')
            return next
          })
        }
        setForm(function (current) {
          var next = update(current, 'llmEnabled', llm.enabled !== false)
          next = update(next, 'allowThreshold', gate.allowThreshold !== undefined ? gate.allowThreshold : current.allowThreshold)
          next = update(next, 'blockThreshold', gate.blockThreshold !== undefined ? gate.blockThreshold : current.blockThreshold)
          next = update(next, 'llmBaseUrl', llm.baseUrl || current.llmBaseUrl)
          next = update(next, 'llmModel', llm.model || current.llmModel)
          next = update(next, 'llmContentSource', llm.contentSource || current.llmContentSource)
          next = update(next, 'llmDeliveryMode', llm.deliveryMode || current.llmDeliveryMode)
          next = update(next, 'llmTruncateChars', llm.truncateChars !== undefined ? llm.truncateChars : current.llmTruncateChars)
          next = update(next, 'llmWindowChars', llm.windowChars !== undefined ? llm.windowChars : current.llmWindowChars)
          next = update(next, 'llmWindowOverlap', llm.windowOverlap !== undefined ? llm.windowOverlap : current.llmWindowOverlap)
          next = update(next, 'windowStride', perf.windowStride !== undefined ? perf.windowStride : current.windowStride)
          return next
        })
      }

      function refreshStatus() {
        setStatusError('')
        apiFetch('/status')
          .then(function (payload) { setStatus(payload); applyStatus(payload) })
          .catch(function (err) { setStatusError(String((err && err.message) || err)) })
      }

      function loadSettings() {
        apiFetch('/settings')
          .then(function (payload) {
            var saved = (payload && payload.settings) || {}
            setSettingsFile((payload && payload.file) || '')
            // 只覆盖「已保存」的键；其余保留状态接口给出的有效值（含插件配置默认）
            setForm(function (current) {
              var next = {}
              for (var k in current) if (Object.prototype.hasOwnProperty.call(current, k)) next[k] = current[k]
              for (var key in saved) {
                if (Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== null) next[key] = saved[key]
              }
              return next
            })
          })
          .catch(function (err) { setSettingsMsg('读取共享设置失败：' + String((err && err.message) || err)) })
      }

      /** 保存设置（等价 CG_GUI 的「保存」）：写入共享设置；如填了 Key 则写入 DSH 凭据库。 */
      function saveSettings() {
        var invalid = validateForm(form)
        if (invalid) { setSettingsMsg(invalid); return }
        setSettingsMsg('保存中…')
        var payload = {
          llmEnabled: Boolean(form.llmEnabled),
          allowThreshold: form.allowThreshold,
          blockThreshold: form.blockThreshold,
          llmContentSource: form.llmContentSource,
          llmDeliveryMode: form.llmDeliveryMode,
          llmTruncateChars: form.llmTruncateChars,
          llmWindowChars: form.llmWindowChars,
          llmWindowOverlap: form.llmWindowOverlap,
          maxFiles: form.maxFiles,
        }
        // 注意：模型侧 window_stride 不由面板管理（不在共享设置里），
        // 只保留「工具参数 / 插件配置」两个入口，避免多一个难懂的概念。
        if (String(form.llmBaseUrl || '').trim()) payload.llmBaseUrl = String(form.llmBaseUrl).trim()
        if (String(form.llmModel || '').trim()) payload.llmModel = String(form.llmModel).trim()
        // 凭据名（保存位置）由面板填写，也存进共享设置，下次启动审计仍能找到
        var credentialName = String(credName || '').trim() || (credential.ref || '')
        if (credentialName) payload.credentialRef = credentialName
        // 其他 DSH 插件扫描 / 自更新检查设置（Node 侧使用，不下发桥接进程）
        payload.pluginScanMode = String(form.pluginScanMode || 'update')
        payload.pluginScanMaxFiles = Number(form.pluginScanMaxFiles || 100)
        payload.selfUpdateCheck = String(form.selfUpdateCheck || 'startup')

        apiFetch('/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (response) {
          setSettingsFile((response && response.file) || settingsFile)
          if (!apiKey) {
            setSettingsMsg('已保存 ✓ 面板与 AI 工具共用这些参数')
            refreshStatus()
            return null
          }
          return apiFetch('/credential', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: apiKey, name: credentialName }),
          }).then(function (outcome) {
            setApiKey('')
            if (outcome && outcome.credentialRef) setCredName(outcome.credentialRef)
            var storage = outcome && outcome.credentialStorage
            setSettingsMsg(storage === 'local-file'
              ? '已保存 ✓ 参数共用；当前 DSH 版本不支持从插件写入凭据库，API Key 已保存到本机文件 '
                + '（~/.dsh/calibguard-credentials.json，仅本机可见）'
              : '已保存 ✓ 参数共用；API Key 已写入 DSH 凭据库（' + ((outcome && outcome.credentialRef) || credentialName) + '）')
            refreshStatus()
            loadSettings()
          }).catch(function (err) {
            setSettingsMsg('参数已保存，但 API Key 写入失败：' + String((err && err.message) || err))
          })
        }).catch(function (err) { setSettingsMsg('保存失败：' + String((err && err.message) || err)) })
      }

      function resetSettings() {
        setSettingsMsg('重置中…')
        apiFetch('/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }).then(function () {
          setApiKey('')
          setSettingsMsg('已重置 ✓ 现在跟随插件配置默认值')
          loadSettings()
          refreshStatus()
        }).catch(function (err) { setSettingsMsg('重置失败：' + String((err && err.message) || err)) })
      }

      var onDrop = useCallback(function (event) {
        event.preventDefault()
        setDragging(false)
        var files = []
        if (event.dataTransfer && event.dataTransfer.files) {
          for (var i = 0; i < event.dataTransfer.files.length; i++) files.push(event.dataTransfer.files[i])
        }
        if (files.length > 0) setDropped(function (current) { return current.concat(files) })
      }, [])

      var onDragOver = useCallback(function (event) { prevent(event); setDragging(true) }, [])
      var onDragLeave = useCallback(function () { setDragging(false) }, [])

      function prevent(event) { event.preventDefault() }

      function pickFiles(event) {
        var files = []
        if (event.target && event.target.files) {
          for (var i = 0; i < event.target.files.length; i++) files.push(event.target.files[i])
        }
        if (files.length > 0) setDropped(function (current) { return current.concat(files) })
        if (event.target) event.target.value = ''
      }

      function run() {
        setError('')
        setReport(null)
        setBusy(true)
        var payload = { options: { includeEvidence: true } }
        var pathLines = String(pathsText || '').split('\n').map(function (line) { return line.trim() }).filter(function (line) { return line.length > 0 })
        if (pathLines.length > 0) payload.paths = pathLines

        var encode = dropped.length > 0
          ? Promise.all(dropped.map(function (file) {
            return fileToBase64(file).then(function (base64) { return { name: file.name, base64: base64 } })
          }))
          : Promise.resolve([])

        encode.then(function (files) {
          if (files.length > 0) payload.files = files
          return apiFetch('/audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }).then(function (body) {
          setResult(body.result)
          setBusy(false)
          refreshStatus()
        }).catch(function (err) {
          setBusy(false)
          setError(String((err && err.message) || err))
        })
      }

      function checkSelfUpdate() {
        setPluginScanMsg('正在检查 npm 上的最新版本…')
        apiFetch('/self-update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        }).then(function (payload) {
          setPluginScanMsg(payload && payload.available
            ? '发现新版本 v' + payload.latestVersion
            : '已是最新版本' + (payload && payload.latestVersion ? '（' + payload.latestVersion + '）' : ''))
          refreshStatus()
        }).catch(function (err) {
          setPluginScanMsg('检查更新失败：' + String((err && err.message) || err))
        })
      }

      function dismissSelfUpdate(scope) {
        apiFetch('/self-update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'dismiss', scope: scope }),
        }).then(function () { refreshStatus() }).catch(function (err) {
          setPluginScanMsg('操作失败：' + String((err && err.message) || err))
        })
      }

      function scanPlugins(mode) {
        setPluginScanMsg(mode === 'changed' ? '已启动「只扫新装/更新」…' : '已启动全量扫描…')
        apiFetch('/scan-plugins', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: mode }),
        }).then(function () {
          refreshStatus()
        }).catch(function (err) {
          setPluginScanMsg('启动扫描失败：' + String((err && err.message) || err))
        })
      }

      function installTorch(mode) {
        setTorchMsg('已启动重装 torch（后台进行，面板自动刷新进度）…')
        apiFetch('/install-torch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: mode }),
        }).then(function () {
          refreshStatus()
        }).catch(function (err) {
          setTorchMsg('重装启动失败：' + String((err && err.message) || err))
        })
      }

      function clearResult() {
        setResult(null)
        setReport(null)
        setError('')
      }

      function openReport(name) {
        setReport({ name: name, text: '加载中…' })
        fetch(API + '/report?name=' + encodeURIComponent(name))
          .then(function (response) {
            return response.text().then(function (text) { return { status: response.status, text: text } })
          })
          .then(function (outcome) { setReport({ name: name, text: outcome.text }) })
          .catch(function (err) { setReport({ name: name, text: '读取失败：' + String((err && err.message) || err) }) })
      }

      // ---------- 耗时预估（窗口数模型 × 实测吞吐） ----------
      var perf = status && status.status ? status.status.performance : null
      var measuredRate = perf && perf.windowsPerSecond ? Number(perf.windowsPerSecond) : 0
      var effectiveStride = form.windowStride !== undefined ? Number(form.windowStride) : 256
      var estimate = null
      if (dropped.length > 0) {
        var totalWindows = 0
        for (var di = 0; di < dropped.length; di++) {
          var chars = Math.min(dropped[di].size || 0, 200000)
          var tokens = Math.floor(chars * 0.368)
          totalWindows += tokens <= 510 ? 1 : Math.ceil((tokens - 510) / Math.max(1, effectiveStride)) + 1
        }
        var rate = measuredRate || 3.5
        estimate = { windows: totalWindows, rate: rate, measured: measuredRate > 0, seconds: totalWindows / rate }
      }

      var llmOn = Boolean(form.llmEnabled)
      var deliveryMode = form.llmDeliveryMode || 'truncate'

      // 模型侧步长不暴露给面板；仍从状态接口取有效值，用于大文件耗时预估。
      var modelStride = form.windowStride === undefined || form.windowStride === null
        ? 256 : Number(form.windowStride)

      var summary = result && result.summary ? result.summary : null
      var sortedResults = result && Array.isArray(result.results)
        ? result.results.slice().sort(function (a, b) {
          var ai = DECISION_ORDER.indexOf(a.final_decision)
          var bi = DECISION_ORDER.indexOf(b.final_decision)
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
        })
        : []

      var envInfo = status && status.environment ? status.environment : null
      var engineInfo = status && status.status ? status.status : null
      var envPreparing = Boolean(envInfo) && !engineInfo && envInfo.state !== 'failed'
      var reportDir = (engineInfo && engineInfo.reportDir)
        || (status && status.settings && status.settings.reportDir)
        || (result && result.config && result.config.reportDir)
        || ''
      var devicePolicy = (engineInfo && engineInfo.devicePolicy) || null
      var setupScript = (status && status.setupScript) || '<插件目录>/setup.mjs'
      var selfUpdate = (status && status.selfUpdate) || null
      var pluginScan = (status && status.pluginScan) || null
      var pluginScanRunning = Boolean(pluginScan && pluginScan.running)
      var torchJob = (status && status.torchJob) || null
      var torchRunning = Boolean(torchJob && torchJob.state === 'running')
      var torchState = (torchJob && torchJob.state) || 'idle'
      var gpuInfo = (status && status.gpuTorch) || null
      // 有 NVIDIA 显卡、但 torch 没启用 CUDA（装的是 CPU 版）→ 提示并允许一键重装。
      // 例外：显卡算力低于 CUDA 要求（如 GTX 1060 5GB / 6.1）时，强制 CPU 是预期行为——
      // CPU 版 torch 已是最优，不再反复提示重装。
      var gpuCap = gpuInfo && Array.isArray(gpuInfo.computeCap) ? gpuInfo.computeCap : null
      var gpuCudaEligible = Boolean(gpuInfo && gpuInfo.cudaEligible)
        || (gpuCap ? (gpuCap[0] > 7 || (gpuCap[0] === 7 && gpuCap[1] >= 5)) : false)
      var gpuName = (gpuInfo && gpuInfo.gpuName) || (devicePolicy && devicePolicy.gpuName) || ''
      var gpuTorchHint = engineInfo && engineInfo.cudaAvailable === false && gpuName && gpuCudaEligible
        ? gpuName
        : ''
      var engineReady = Boolean(engineInfo)
      var envBusy = Boolean(envInfo) && !engineReady && envInfo.state !== 'failed'
      var envFailed = Boolean(envInfo) && !engineReady && envInfo.state === 'failed'

      var statusText = engineInfo
        ? '引擎就绪：' + engineInfo.device
          + ' ｜ 模型 ' + (engineInfo.loaded ? '已加载' : '待加载')
          + ' ｜ 阈值 ' + engineInfo.gate.allowThreshold + '/' + engineInfo.gate.blockThreshold
          + ' ｜ 云端复核 ' + (engineInfo.llm.enabled ? (engineInfo.llm.configured ? '可用' : '已启用但无凭据') : '关闭')
        : (envFailed ? '环境准备失败' : (envBusy ? '首次运行：正在准备引擎与依赖…' : '状态读取中…'))

      // 环境准备中自动刷新（装完后无需手动点「刷新状态」）
      useEffect(function () {
        if (!envPreparing) return undefined
        var timer = setInterval(refreshStatus, 4000)
        return function () { clearInterval(timer) }
      }, [envPreparing])

      function renderPage() {
        return jsx('div', {
          style: S.page,
        children: jsxs(Fragment, {
          children: [
            // ---------- 顶部 ----------
            jsxs('div', {
              style: S.head,
              children: [
                jsx('h2', { style: S.title, children: 'CalibGuard 文件安全审计' }),
                jsx('span', { style: S.badge, children: statusText }),
                jsx('button', { style: S.button, onClick: refreshStatus, children: '刷新状态' }),
              ],
            }),
            statusError ? jsx('div', { style: S.err, children: statusError }) : null,
            selfUpdate && selfUpdate.available
              ? jsxs('div', {
                style: S.card,
                children: [
                  jsx('div', { style: S.cardTitle, children: '发现新版本 v' + selfUpdate.latestVersion + '（当前 v' + selfUpdate.currentVersion + '）' }),
                  jsx('div', {
                    style: S.muted,
                    children: 'CalibGuard 不会静默升级。请更新插件：设置 → 添加插件 → 输入 dsh-calibguard → 重启 DSH'
                      + '（或使用下面的命令）。是否升级由你决定；也可以跳过此版本或不再询问。',
                  }),
                  jsx('pre', { style: Object.assign({}, S.pre, { marginTop: 8 }), children: selfUpdate.upgrade.command }),
                  jsxs('div', {
                    style: S.row,
                    children: [
                      jsx('button', {
                        style: S.buttonPrimary,
                        onClick: function () { if (typeof window !== 'undefined') window.open(selfUpdate.upgrade.releasesUrl, '_blank', 'noopener') },
                        children: '打开 Release 页',
                      }),
                      jsx('button', {
                        style: S.button,
                        onClick: function () { if (typeof window !== 'undefined') window.open(selfUpdate.upgrade.npmUrl, '_blank', 'noopener') },
                        children: '打开 npm 页',
                      }),
                      jsx('button', { style: S.button, onClick: function () { dismissSelfUpdate('version') }, children: '跳过此版本' }),
                      jsx('button', { style: S.button, onClick: function () { dismissSelfUpdate('forever') }, children: '以后不再询问' }),
                    ],
                  }),
                ],
              })
              : null,
            engineInfo && devicePolicy && devicePolicy.reason
              ? jsx('div', {
                style: S.muted,
                children: '推理设备：' + engineInfo.device
                  + (devicePolicy.gpuName ? '（' + devicePolicy.gpuName + '）' : '')
                  + ' ｜ ' + devicePolicy.reason
                  + (devicePolicy.gpuName && !gpuCudaEligible
                    ? '（该显卡算力低于 CUDA 加速要求，CPU 版 torch 已是最优，无需重装）'
                    : ''),
              })
              : null,
            gpuTorchHint && torchState !== 'running'
              ? jsxs('div', {
                style: S.card,
                children: [
                  jsx('div', { style: S.cardTitle, children: '检测到 NVIDIA ' + gpuTorchHint + '，但当前 torch 是 CPU 版' }),
                  jsx('div', {
                    style: S.muted,
                    children: 'CPU 版与 GPU 版 torch 不能共存于同一个 venv，重装会先卸载当前的再装 CUDA（cu128）版'
                      + '（约 2.5 GB，下载走 PyTorch 官方源）。装完桥接会自动重启，无需重启 DSH。',
                  }),
                  jsxs('div', {
                    style: S.row,
                    children: [
                      jsx('button', {
                        style: S.buttonPrimary,
                        onClick: function () { installTorch('cuda') },
                        children: '一键重装 GPU 版 torch（约 2.5 GB）',
                      }),
                      jsx('button', {
                        style: S.button,
                        onClick: function () { installTorch('auto') },
                        children: '按自动定档重装',
                      }),
                      torchMsg ? jsx('span', { style: S.muted, children: torchMsg }) : null,
                    ],
                  }),
                  torchState === 'done'
                    ? jsx('div', {
                      style: { color: C.allow, fontSize: 12, marginTop: 6 },
                      children: 'torch 重装完成（面板已自动刷新；若顶部仍显示 CPU，点「刷新状态」或重启 DSH 即可）',
                    })
                    : null,
                  torchState === 'failed'
                    ? jsx('div', {
                      style: { color: C.error, fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 6 },
                      children: '重装失败：' + ((torchJob && (torchJob.error || torchJob.message)) || '详见日志')
                        + '\n手动方式：node "' + setupScript + '" --reinstall-torch --force-cuda',
                    })
                    : null,
                  jsx('div', {
                    style: S.note,
                    children: '不想用面板也可以手动运行：node "' + setupScript + '" --reinstall-torch --force-cuda',
                  }),
                ],
              })
              : null,
            torchRunning
              ? jsxs('div', {
                style: S.card,
                children: [
                  jsx('div', { style: S.cardTitle, children: '正在重装 torch…' }),
                  jsx('div', { style: S.muted, children: (torchJob && (torchJob.step || torchJob.message)) || '准备中…' }),
                  torchJob && torchJob.tail && torchJob.tail.length > 0
                    ? jsx('pre', {
                      style: Object.assign({}, S.pre, { maxHeight: 140, marginTop: 8 }),
                      children: torchJob.tail.slice(-5).join('\n'),
                    })
                    : null,
                ],
              })
              : null,

            // ---------- 首次运行：自动准备环境（对齐 CG_GUI 首启装环境） ----------
            envInfo && !engineReady
              ? jsxs('div', {
                style: Object.assign({}, S.card, envFailed ? { borderColor: C.error } : null),
                children: [
                  jsx('div', {
                    style: S.cardTitle,
                    children: envFailed ? '环境准备失败' : '首次运行：正在自动准备引擎与依赖',
                  }),
                  jsx('div', {
                    style: S.muted,
                    children: envFailed
                      ? (envInfo.error || status.error || '详见日志与下方的安装输出')
                      : '首次运行会下载模型权重（约 442 MB，自动镜像回退）并安装 Python 依赖（1–3 GB），可能需要 10–20 分钟。'
                        + '完成后点「刷新状态」即可开始审计。进度也写在宿主日志的 [calibguard] 行。',
                  }),
                  envBusy && envInfo.message
                    ? jsx('div', { style: { marginTop: 6, fontSize: 12 }, children: '当前步骤：' + envInfo.message })
                    : null,
                  envFailed
                    ? jsx('div', {
                      style: S.note,
                      children: '可手动重试：在本插件目录运行 `node setup.mjs`（或 `node setup.mjs --help` 看更多参数），'
                        + '完成后点「刷新状态」。',
                    })
                    : null,
                  envInfo.tail && envInfo.tail.length > 0
                    ? jsx('pre', {
                      style: Object.assign({}, S.pre, { maxHeight: 160, marginTop: 8 }),
                      children: envInfo.tail.slice(-6).join('\n'),
                    })
                    : null,
                  jsxs('div', {
                    style: S.row,
                    children: [
                      jsx('button', { style: S.button, onClick: refreshStatus, children: '刷新状态' }),
                    ],
                  }),
                ],
              })
              : null,

            // ---------- 设置（照 CG_GUI） ----------
            jsxs('div', {
              style: S.card,
              children: [
                jsx('div', { style: S.cardTitle, children: '设置' }),
                jsxs('label', {
                  style: S.check,
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      checked: llmOn,
                      onChange: function (event) { setField('llmEnabled', event.target.checked) },
                    }),
                    ' 使用云端 LLM 复核灰区文件',
                  ],
                }),
                jsx('div', {
                  style: S.note,
                  children: '关闭后不发起任何云端调用，灰区文件按本地模型在 0.5 处判定（>0.5 拦截，否则放行）。',
                }),

                jsxs('div', {
                  style: Object.assign({}, S.group, llmOn ? null : S.groupOff),
                  children: [
                    jsxs('label', {
                      style: S.field,
                      children: [
                        jsx('span', { style: S.label, children: '凭据名（保存位置的名字，不是密钥）' }),
                        jsx('input', {
                          style: S.input,
                          type: 'text',
                          autoComplete: 'off',
                          placeholder: credential.ref || 'DEEPSEEK_API_KEY',
                          value: credName,
                          disabled: !llmOn,
                          onChange: function (event) { setCredName(event.target.value) },
                        }),
                      ],
                    }),
                    jsxs('label', {
                      style: S.field,
                      children: [
                        jsx('span', { style: S.label, children: 'API Key' }),
                        jsx('input', {
                          style: S.input,
                          type: 'password',
                          autoComplete: 'off',
                          placeholder: credential.configured
                            ? '已配置（留空表示不修改）'
                            : '未配置，填入后点「保存」写入 DSH 凭据库',
                          value: apiKey,
                          disabled: !llmOn,
                          onChange: function (event) { setApiKey(event.target.value) },
                        }),
                      ],
                    }),
                    jsxs('label', {
                      style: S.field,
                      children: [
                        jsx('span', { style: S.label, children: 'Base URL' }),
                        jsx('input', {
                          style: S.input,
                          type: 'text',
                          autoComplete: 'off',
                          placeholder: 'https://api.deepseek.com',
                          value: form.llmBaseUrl || '',
                          disabled: !llmOn,
                          onChange: function (event) { setField('llmBaseUrl', event.target.value) },
                        }),
                      ],
                    }),
                    jsxs('label', {
                      style: S.field,
                      children: [
                        jsx('span', { style: S.label, children: '模型名称' }),
                        jsx('input', {
                          style: S.input,
                          type: 'text',
                          autoComplete: 'off',
                          placeholder: 'deepseek-chat',
                          value: form.llmModel || '',
                          disabled: !llmOn,
                          onChange: function (event) { setField('llmModel', event.target.value) },
                        }),
                      ],
                    }),
                    jsxs('label', {
                      style: S.field,
                      children: [
                        jsx('span', { style: S.label, children: '送审内容' }),
                        jsxs('select', {
                          style: S.input,
                          value: form.llmContentSource || 'evidence',
                          disabled: !llmOn,
                          onChange: function (event) { setField('llmContentSource', event.target.value) },
                          children: [
                            jsx('option', { value: 'evidence', children: '精炼证据（危险API / 网络行为 / 凭据访问等摘要）' }),
                            jsx('option', { value: 'raw', children: '文件原文（预处理后的全文文本）' }),
                          ],
                        }),
                      ],
                    }),
                    jsxs('label', {
                      style: S.field,
                      children: [
                        jsx('span', { style: S.label, children: '投递方式' }),
                        jsxs('select', {
                          style: S.input,
                          value: deliveryMode,
                          disabled: !llmOn,
                          onChange: function (event) { setField('llmDeliveryMode', event.target.value) },
                          children: [
                            jsx('option', { value: 'truncate', children: '截断（只送前 N 个字符）' }),
                            jsx('option', { value: 'window', children: '滑窗（分片逐窗送审，结果取最严重）' }),
                            jsx('option', { value: 'all', children: '一次性全部上传' }),
                          ],
                        }),
                      ],
                    }),
                    deliveryMode === 'truncate'
                      ? jsxs('label', {
                        style: S.field,
                        children: [
                          jsx('span', { style: S.label, children: '截断大小（字符）' }),
                          jsx('input', {
                            style: S.input,
                            type: 'number',
                            min: 1,
                            step: 100,
                            value: form.llmTruncateChars === undefined ? '' : form.llmTruncateChars,
                            disabled: !llmOn,
                            onChange: function (event) { setField('llmTruncateChars', toNumberOrUndefined(event.target.value)) },
                          }),
                        ],
                      })
                      : null,
                    deliveryMode === 'window'
                      ? jsxs(Fragment, {
                        children: [
                          jsxs('label', {
                            style: S.field,
                            children: [
                              jsx('span', { style: S.label, children: '滑窗大小（字符）' }),
                              jsx('input', {
                                style: S.input,
                                type: 'number',
                                min: 1,
                                step: 100,
                                value: form.llmWindowChars === undefined ? '' : form.llmWindowChars,
                                disabled: !llmOn,
                                onChange: function (event) { setField('llmWindowChars', toNumberOrUndefined(event.target.value)) },
                              }),
                            ],
                          }),
                          jsxs('label', {
                            style: S.field,
                            children: [
                              jsx('span', { style: S.label, children: '滑窗重叠（字符）' }),
                              jsx('input', {
                                style: S.input,
                                type: 'number',
                                min: 0,
                                step: 50,
                                value: form.llmWindowOverlap === undefined ? '' : form.llmWindowOverlap,
                                disabled: !llmOn,
                                onChange: function (event) { setField('llmWindowOverlap', toNumberOrUndefined(event.target.value)) },
                              }),
                            ],
                          }),
                          jsx('div', {
                            style: S.note,
                            children: '重叠越大，切出的分段越多、云端调用次数也越多（重叠用来避免关键证据恰好被切在边界上）。',
                          }),
                        ],
                      })
                      : null,
                  ],
                }),

                jsxs('div', {
                  style: S.group,
                  children: [
                    jsx('div', { style: S.label, children: '灰区范围（校准后恶意概率）' }),
                    jsxs('div', {
                      style: S.range,
                      children: [
                        jsx('input', {
                          style: Object.assign({}, S.input, { width: 90 }),
                          type: 'number', min: 0, max: 1, step: 0.01,
                          value: form.allowThreshold === undefined ? '' : form.allowThreshold,
                          onChange: function (event) { setField('allowThreshold', toNumberOrUndefined(event.target.value)) },
                        }),
                        jsx('span', { style: S.muted, children: '~' }),
                        jsx('input', {
                          style: Object.assign({}, S.input, { width: 90 }),
                          type: 'number', min: 0, max: 1, step: 0.01,
                          value: form.blockThreshold === undefined ? '' : form.blockThreshold,
                          onChange: function (event) { setField('blockThreshold', toNumberOrUndefined(event.target.value)) },
                        }),
                      ],
                    }),
                    jsx('div', { style: S.note, children: '低于下限直接放行、高于上限直接拦截；中间地带才提交云端复核。' }),
                  ],
                }),

                jsxs('div', {
                  style: S.group,
                  children: [
                    jsx('div', { style: S.label, children: '高级（CG_GUI 没有的项：DSH 侧新增）' }),
                    jsxs('div', {
                      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 },
                      children: [
                        jsxs('label', {
                          style: S.field,
                          children: [
                            jsx('span', { style: S.label, children: '目录文件上限（1~200，默认 20）' }),
                            jsx('input', {
                              style: S.input, type: 'number', min: 1, max: 200, step: 1,
                              value: form.maxFiles === undefined ? '' : form.maxFiles,
                              onChange: function (event) { setField('maxFiles', toNumberOrUndefined(event.target.value)) },
                            }),
                          ],
                        }),
                      ],
                    }),
                    jsx('div', {
                      style: S.note,
                      children: '只限制「给一个目录时递归展开多少个文件」——防止误传 node_modules/素材包把审计拖到失控；'
                        + '你显式拖入或粘贴的文件全部都会审（单次上传上限 50 个）。被截断时结果里会明确提示"仅审计了前 N 个"。',
                    }),
                    jsx('div', {
                      style: S.note,
                      children: '模型侧窗口（决定推理耗时）不在此暴露：默认 512 token 窗 / 重叠 254 token，'
                        + '判断优先。需要给大文件提速时，让 AI 用工具参数 window_stride=510 审一次，'
                        + '或在插件配置里设 windowStride（面板与共享设置不管理该项）。',
                    }),
                  ],
                }),

                jsx('div', {
                  style: S.note,
                  children: '设置保存在本地 ' + (settingsFile || '$DSH_HOME/calibguard-settings.json')
                    + '（GUI 与 AI 工具共用）；API Key 写入 DSH 凭据库，不落此文件。'
                    + '「凭据名」只是保存位置的名字（默认 DEEPSEEK_API_KEY，也会记住你填的名字）；'
                    + 'API Key 优先写 DSH 凭据库，当前 DSH 版本不支持时自动保存到本机文件。'
                    + '审计结果（JSON + Markdown）保存在引擎的 reports 目录，见下方「审计结果」。',
                }),
                jsxs('div', {
                  style: S.row,
                  children: [
                    jsx('span', { style: S.muted, children: settingsMsg }),
                    jsx('button', { style: S.button, onClick: resetSettings, children: '重置' }),
                    jsx('button', { style: S.buttonPrimary, onClick: saveSettings, children: '保存' }),
                  ],
                }),
              ],
            }),

            // ---------- 审计 ----------
            jsxs('div', {
              style: S.card,
              children: [
                jsx('div', { style: S.cardTitle, children: '审计' }),
                jsx('div', {
                  style: Object.assign({}, S.drop, dragging ? S.dropActive : null),
                  onDragOver: onDragOver,
                  onDragLeave: onDragLeave,
                  onDrop: onDrop,
                  onClick: function () { if (fileInput.current) fileInput.current.click() },
                  children: jsxs(Fragment, {
                    children: [
                      jsx('div', { style: { fontSize: 14, marginBottom: 4, color: C.text }, children: '把文件拖到这里，或点击选择' }),
                      jsx('div', { style: S.muted, children: '压缩包会在内存中解包后逐文件审计；文件只写到系统临时目录，审计完即删' }),
                      jsx('input', { ref: fileInput, type: 'file', multiple: true, style: { display: 'none' }, onChange: pickFiles }),
                    ],
                  }),
                }),
                estimate && estimate.seconds > 12
                  ? jsx('div', {
                    style: { color: C.suspicious, fontSize: 12, marginTop: 8 },
                    children: '预计 ' + estimate.windows + ' 个滑窗，约 ' + Math.round(estimate.seconds) + ' 秒'
                      + '（按 ' + estimate.rate + ' 窗口/秒' + (estimate.measured ? '，实测值' : '，默认估算') + '）'
                      + '。这是模型侧全文滑窗的固定成本；想快就少审/拆小文件。',
                  })
                  : null,
                dropped.length > 0
                  ? jsxs('div', {
                    style: S.row,
                    children: [
                      jsx('span', { style: S.muted, children: '待审计文件：' }),
                      jsx(Fragment, {
                        children: dropped.map(function (file, index) {
                          return jsx('span', {
                            style: S.chip,
                            children: jsxs(Fragment, {
                              children: [
                                file.name + '（' + Math.round(file.size / 1024) + 'KB）',
                                jsx('span', {
                                  style: { cursor: 'pointer', opacity: 0.7 },
                                  onClick: function () {
                                    setDropped(function (current) { return current.filter(function (_item, i) { return i !== index }) })
                                  },
                                  children: '×',
                                }),
                              ],
                            }),
                          }, file.name + index)
                        }),
                      }),
                      jsx('button', { style: S.button, onClick: function () { setDropped([]) }, children: '清空' }),
                    ],
                  })
                  : null,
                dropped.length > 50
                  ? jsx('div', {
                    style: { color: C.error, fontSize: 12, marginTop: 6 },
                    children: '单次最多上传 50 个文件（当前 ' + dropped.length + ' 个）：请分批，或改用「粘贴宿主机路径」给目录。',
                  })
                  : null,
                jsx('div', { style: S.label, children: '也可以直接粘贴宿主机路径（每行一个，文件或目录）' }),
                jsx('textarea', {
                  style: S.textarea,
                  placeholder: 'D:\\downloads\\setup.py\nD:\\downloads\\vendor',
                  value: pathsText,
                  onChange: function (event) { setPathsText(event.target.value) },
                }),
                jsxs('div', {
                  style: S.row,
                  children: [
                    jsx('button', {
                      style: Object.assign({}, S.buttonPrimary,
                        busy || !engineReady ? { opacity: 0.6, cursor: 'default' } : null),
                      onClick: busy || !engineReady ? function () {} : run,
                      children: busy
                        ? '审计中…' + (engineInfo && engineInfo.loaded === false ? '（首次会加载模型）' : '')
                        : (!engineReady ? '环境准备完成后可审计' : '开始审计'),
                    }),
                    jsx('span', { style: S.muted, children: '使用上面「设置」里保存的参数（与 AI 工具一致）' }),
                  ],
                }),
                engineReady && reportDir
                  ? jsx('div', {
                    style: S.muted,
                    children: '审计结果（JSON + Markdown）保存到：' + reportDir,
                  })
                  : null,
              ],
            }),

            error ? jsx('div', { style: S.err, children: error }) : null,

            // ---------- 结果 ----------
            result
              ? jsxs('div', {
                style: S.row,
                children: [
                  jsx('div', { style: S.cardTitle, children: '审计结果' }),
                  jsx('button', { style: S.button, onClick: clearResult, children: '清空结果' }),
                ],
              })
              : null,
            result && reportDir
              ? jsx('div', {
                style: S.muted,
                children: '结果文件保存在：' + reportDir
                  + '（每次审计生成 JSON + Markdown；点条目里的「查看 Markdown 报告」可直接打开）',
              })
              : null,
            summary
              ? jsxs('div', {
                style: S.summary,
                children: [
                  jsx('span', { style: S.pill, children: '共 ' + summary.total + ' 个文件' }),
                  jsx('span', { style: Object.assign({}, S.pill, { color: C.block, borderColor: C.block }), children: '拦截 ' + summary.block }),
                  jsx('span', { style: Object.assign({}, S.pill, { color: C.manual, borderColor: C.manual }), children: '转人工 ' + summary.manual_review }),
                  jsx('span', { style: Object.assign({}, S.pill, { color: C.suspicious, borderColor: C.suspicious }), children: '可疑 ' + summary.suspicious }),
                  jsx('span', { style: Object.assign({}, S.pill, { color: C.allow, borderColor: C.allow }), children: '放行 ' + summary.allow }),
                  summary.error ? jsx('span', { style: Object.assign({}, S.pill, { color: C.error, borderColor: C.error }), children: '异常 ' + summary.error }) : null,
                  jsx('span', { style: S.muted, children: '用时 ' + (result.elapsedMs / 1000).toFixed(1) + 's ｜ 阈值 '
                    + result.config.allowThreshold + '/' + result.config.blockThreshold
                    + ' ｜ 送审 ' + result.config.llmDeliveryMode + '（' + result.config.llmContentSource + '）' }),
                ],
              })
              : null,
            result && result.truncated
              ? jsx('div', { style: S.muted, children: '注意：文件数超过上限，仅审计了前 ' + summary.total + ' 个' })
              : null,
            result
              ? jsx('div', {
                children: jsx(Fragment, {
                  children: sortedResults.map(function (item, index) {
                    return jsx(ResultItem, { key: item.file_path + index, item: item, onOpenReport: openReport })
                  }),
                }),
              })
              : null,

            // ---------- 报告 ----------
            report
              ? jsxs('div', {
                style: S.card,
                children: [
                  jsxs('div', {
                    style: S.row,
                    children: [
                      jsx('strong', { children: '报告 ' + report.name }),
                      jsx('button', { style: S.button, onClick: function () { setReport(null) }, children: '关闭' }),
                    ],
                  }),
                  jsx('pre', { style: S.pre, children: report.text }),
                ],
              })
              : null,

            // ---------- 高级 / 其他设置（默认折叠） ----------
            jsxs('details', {
              style: Object.assign({}, S.card, { marginTop: 12 }),
              children: [
                jsx('summary', {
                  style: { cursor: 'pointer', fontSize: 13, color: C.muted, userSelect: 'none' },
                  children: '高级 / 其他设置（其他插件扫描、本插件更新检查、文件位置）',
                }),
                jsx('div', { style: { marginTop: 8, fontSize: 12, color: C.muted }, children: '以下都是可选项，不清楚可以保持默认。' }),

                jsx('div', { style: Object.assign({}, S.label, { marginTop: 8 }), children: '其他 DSH 插件扫描' }),
                jsx('div', {
                  style: S.muted,
                  children: '安装/更新别的 DSH 插件后自动扫一遍（只扫 dsh.profile.bundles 里的其他插件，'
                    + '跳过自己与 @deepseek-ai/*；已删除的忽略）。',
                }),
                jsxs('div', {
                  style: S.row,
                  children: [
                    jsx('span', { style: S.label, children: '频率' }),
                    jsx('select', {
                      style: S.input,
                      value: form.pluginScanMode || 'update',
                      onChange: function (event) { setField('pluginScanMode', event.target.value) },
                      children: [
                        ['off', '不扫描'], ['update', '插件列表更新时'], ['weekly', '每周'], ['monthly', '每月'],
                        ['quarterly', '每季度'], ['halfyearly', '每半年'],
                      ].map(function (item) {
                        return jsx('option', { value: item[0], children: item[1] }, item[0])
                      }),
                    }),
                    jsx('span', { style: S.label, children: '单插件最多文件' }),
                    jsx('input', {
                      style: Object.assign({}, S.input, { width: 88 }),
                      type: 'number',
                      min: 1,
                      max: 500,
                      value: form.pluginScanMaxFiles || 100,
                      onChange: function (event) { setField('pluginScanMaxFiles', Number(event.target.value || 100)) },
                    }),
                  ],
                }),
                jsxs('div', {
                  style: S.row,
                  children: [
                    jsx('button', { style: S.button, onClick: function () { scanPlugins('all') }, children: '立即扫描全部' }),
                    jsx('button', { style: S.button, onClick: function () { scanPlugins('changed') }, children: '只扫新装/更新' }),
                    pluginScanRunning ? jsx('span', { style: S.muted, children: '扫描中…' }) : null,
                    pluginScanMsg ? jsx('span', { style: S.muted, children: pluginScanMsg }) : null,
                  ],
                }),
                pluginScan && pluginScan.lastScanAt
                  ? jsx('div', {
                    style: S.muted,
                    children: '上次扫描：' + new Date(pluginScan.lastScanAt).toLocaleString()
                      + '（' + (pluginScan.lastMode || '') + '，' + (pluginScan.pluginsCount || 0) + ' 个插件）'
                      + (pluginScan.nextDueAt ? '；下次：' + new Date(pluginScan.nextDueAt).toLocaleString() : ''),
                  })
                  : null,
                pluginScan && pluginScan.error ? jsx('div', { style: S.err, children: pluginScan.error }) : null,
                pluginScan && Array.isArray(pluginScan.results) && pluginScan.results.length > 0
                  ? jsx('div', {
                    style: { marginTop: 6 },
                    children: pluginScan.results.map(function (item) {
                      var color = { block: C.block, manual_review: C.manual, suspicious: C.suspicious, allow: C.allow, error: C.error }[item.worst] || C.muted
                      var label = { block: '拦截', manual_review: '转人工', suspicious: '可疑', allow: '放行', error: '异常' }[item.worst] || item.worst
                      return jsx('div', {
                        style: S.item,
                        children: jsxs(Fragment, {
                          children: [
                            jsxs('div', {
                              style: S.itemHead,
                              children: [
                                jsx('span', { style: Object.assign({}, S.pill, { color: color, borderColor: color }), children: label }),
                                jsx('span', { style: S.path, children: item.name + (item.version ? '@' + item.version : '') }),
                                jsx('span', { style: S.meta, children: '共 ' + item.total + ' 个文件' }),
                              ],
                            }),
                            jsx('div', {
                              style: S.meta,
                              children: '拦截 ' + item.block + ' ｜ 转人工 ' + item.manual_review + ' ｜ 可疑 ' + item.suspicious + ' ｜ 放行 ' + item.allow,
                            }),
                          ],
                        }),
                      }, item.name)
                    }),
                  })
                  : null,

                jsx('div', { style: Object.assign({}, S.label, { marginTop: 14 }), children: '本插件更新检查（只提示，不静默升级）' }),
                jsxs('div', {
                  style: S.row,
                  children: [
                    jsx('span', { style: S.label, children: '检查频率' }),
                    jsx('select', {
                      style: S.input,
                      value: form.selfUpdateCheck || 'startup',
                      onChange: function (event) { setField('selfUpdateCheck', event.target.value) },
                      children: [
                        ['off', '关闭'], ['startup', '每次启动'], ['daily', '每天'], ['weekly', '每周'],
                      ].map(function (item) {
                        return jsx('option', { value: item[0], children: item[1] }, item[0])
                      }),
                    }),
                    jsx('button', { style: S.button, onClick: checkSelfUpdate, children: '立即检测' }),
                    selfUpdate && selfUpdate.available
                      ? jsx('button', { style: S.buttonPrimary, onClick: function () { if (typeof window !== 'undefined') window.open(selfUpdate.upgrade.releasesUrl, '_blank', 'noopener') }, children: '有新版本，去升级' })
                      : null,
                  ],
                }),
                jsx('div', {
                  style: S.muted,
                  children: '当前版本 v' + ((selfUpdate && selfUpdate.currentVersion) || '?')
                    + (selfUpdate && selfUpdate.latestVersion ? ' ｜ npm 最新 v' + selfUpdate.latestVersion : '')
                    + (selfUpdate && selfUpdate.checkedAt ? ' ｜ 上次检查 ' + new Date(selfUpdate.checkedAt).toLocaleString() : '')
                    + (selfUpdate && selfUpdate.neverAsk ? ' ｜ 已设置「以后不再询问」' : '')
                    + (selfUpdate && selfUpdate.skippedVersion ? ' ｜ 已跳过 v' + selfUpdate.skippedVersion : ''),
                }),
                selfUpdate && selfUpdate.lastError
                  ? jsx('div', { style: S.err, children: '检查失败：' + selfUpdate.lastError })
                  : null,

                jsx('div', {
                  style: Object.assign({}, S.note, { marginTop: 10 }),
                  children: '文件位置：设置 ' + (settingsFile || '$DSH_HOME/calibguard-settings.json')
                    + ' ｜ 插件扫描状态 ' + ((pluginScan && pluginScan.stateFile) || '$DSH_HOME/calibguard-plugin-scan.json')
                    + ' ｜ 更新状态 ' + ((selfUpdate && selfUpdate.stateFile) || '$DSH_HOME/calibguard-self-update.json')
                    + ' ｜ 报告 ' + (reportDir || '<engineRoot>/reports'),
                }),
              ],
            }),
          ],
        }),
      })
      }

      return renderPage()
    }

    // ============================== 插件入口 ==============================

    var inject = ['slots']

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots) return
        try {
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: function () { return PANEL_LABEL } },
              Glyph,
            )
          })
        } catch (error) {
          console.warn('[calibguard] 注册侧边栏图标失败', error)
        }
        try {
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)
          })
        } catch (error) {
          console.warn('[calibguard] 注册主面板失败', error)
        }
      } catch (error) {
        console.warn('[calibguard] UI 初始化失败（不影响其余功能）', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
