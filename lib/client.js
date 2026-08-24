/* @dsh-external/dsh-mobile-remote — Client half（电脑端 Web GUI 面板）。
 * 手写 ModuleLoader bundle（无 tsdown）：
 *  - settings.plugins.tab 「手机远程」页面（地址 / 配对码 / 服务开关 / 撤销令牌）——主入口
 *  - sidebar.footer.action 📡 快捷按钮（浮层面板）
 * 数据经同源 POST /dsh-mobile-remote/panel*（loopback + Origin 校验）读取，无需跨端 RPC。
 */
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-mobile-remote', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

try {
  if (typeof document !== 'undefined') {
    document.title = document.title.replace(/\s*\|\s*MR.*$/, '') + ' | MR'
  }
} catch (e) {}

var React = require('react')

var inject = ['slots']

var PANEL_PATH = '/dsh-mobile-remote/panel'
var REVOKE_PATH = '/dsh-mobile-remote/panel/revoke'
var STOP_PATH = '/dsh-mobile-remote/panel/stop'
var START_PATH = '/dsh-mobile-remote/panel/start'

var listeners = []
var storeState = { open: false, data: null }
function emit() { for (var i = 0; i < listeners.length; i++) listeners[i]() }
function subscribe(l) { listeners.push(l); return function () { listeners = listeners.filter(function (x) { return x !== l }) } }

function useStore() {
  var pair = React.useState(storeState)
  React.useEffect(function () {
    var l = function () { pair[1](storeState) }
    listeners.push(l)
    return function () { listeners = listeners.filter(function (x) { return x !== l }) }
  }, [])
  return pair[0]
}

function setData(data) {
  storeState = Object.assign({}, storeState, { data: data })
  emit()
}

function fetchPanel() {
  fetch(PANEL_PATH, { method: 'POST' }).then(function (r) {
    return r.json()
  }).then(function (data) {
    setData(data)
  }).catch(function () {
    setData({ enabled: false, error: '无法连接手机服务器（请确认插件已启动）' })
  })
}

function panelAction(path) {
  return fetch(path, { method: 'POST' }).then(function (r) {
    return r.json()
  }).catch(function () {
    return { ok: false, error: '无法连接手机服务器' }
  })
}

var PANEL_STYLE = {
  position: 'fixed', right: '16px', bottom: '60px', width: '320px',
  maxWidth: 'calc(100vw - 32px)', background: '#161d2e', color: '#e8ecf5',
  border: '1px solid #2a3550', borderRadius: '14px', padding: '14px 16px',
  zIndex: 9999, fontFamily: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
  fontSize: '13px', lineHeight: '1.5', boxShadow: '0 8px 30px rgba(0,0,0,.55)',
}

var ROW = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }
var DIM = { color: '#8b95ad', fontSize: '12px' }
var BTN = {
  width: '100%', padding: '9px', borderRadius: '9px', fontSize: '12px', cursor: 'pointer',
  marginBottom: '8px',
}
var BTN_PRIMARY = Object.assign({}, BTN, { border: '1px solid rgba(79,140,255,.5)', background: 'rgba(79,140,255,.15)', color: '#4f8cff' })
var BTN_DANGER = Object.assign({}, BTN, { border: '1px solid rgba(255,93,108,.4)', background: 'rgba(255,93,108,.12)', color: '#ff5d6c' })

function T(text, style) { return React.createElement('div', style ? { style: style } : null, String(text)) }
function Btn(label, style, onClick) {
  return React.createElement('button', { style: style, onClick: onClick }, label)
}

function fmtUrl(u) { return String(u || '').replace(/^https?:\/\//, '') }

/** 面板主体内容（overlay 与设置页共用）。 */
function PanelContent() {
  var state = useStore()
  var d = state.data || {}
  var children = []

  if (d.error) {
    children.push(T('⚠ ' + d.error, { color: '#ff5d6c', fontSize: '12px', marginBottom: '10px' }))
  } else if (!d.enabled) {
    children.push(T('● 手机服务已关闭', { color: '#f5a623', fontSize: '12px', marginBottom: '10px' }))
  } else {
    children.push(T('● 手机服务运行中（端口 ' + (d.port || '?') + '）', { color: '#34c77b', fontSize: '12px', marginBottom: '10px' }))
  }

  children.push(T('手机访问地址（同一 Wi-Fi）', Object.assign({}, DIM, { margin: '6px 0 4px' })))
  var urls = (d.urls || []).map(function (u) {
    return React.createElement('li', { key: u, style: { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12px', color: '#4f8cff', padding: '3px 0', wordBreak: 'break-all' } }, fmtUrl(u))
  })
  if (urls.length === 0) {
    urls.push(React.createElement('li', { key: 'none', style: DIM }, '（未检测到局域网地址）'))
  }
  children.push(React.createElement('ul', { style: { listStyle: 'none', padding: '0', margin: '0 0 6px' } }, urls))
  var tailUrls = (d.tailscaleUrls || []).map(function (u) {
    return React.createElement('li', {
      key: u,
      style: { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12px', color: '#34c77b', padding: '3px 0', wordBreak: 'break-all' },
    }, '🌐 外网（Tailscale） ' + fmtUrl(u))
  })
  if (tailUrls.length > 0) {
    children.push(T('出门在外也能连（无需同一 Wi-Fi）', Object.assign({}, DIM, { margin: '2px 0 4px' })))
    children.push(React.createElement('ul', { style: { listStyle: 'none', padding: '0', margin: '0 0 10px' } }, tailUrls))
  }

  var remainMs = (d.pinExpiresAt || 0) - Date.now()
  children.push(React.createElement('div', { style: { background: '#0f1420', border: '1px solid #2a3550', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px', textAlign: 'center' } }, [
    T('配对码', DIM),
    T(d.pin || '—', { fontSize: '26px', letterSpacing: '6px', fontWeight: '700', color: '#e8ecf5', margin: '2px 0' }),
    T(remainMs > 0 ? Math.max(1, Math.round(remainMs / 60000)) + ' 分钟后过期' : '已过期（下次配对自动刷新）', { color: '#f5a623', fontSize: '11px' }),
  ]))

  children.push(T('已配对设备：' + (d.tokenCount || 0) + ' 个令牌', Object.assign({}, DIM, { marginBottom: '10px' })))

  children.push(Btn('🗑 撤销全部令牌（踢出所有手机）', BTN_DANGER, function () {
    if (window.confirm('撤销后所有手机令牌立即失效，需重新输入新配对码。确定？')) {
      panelAction(REVOKE_PATH).then(fetchPanel)
    }
  }))

  children.push(Btn('↻ 刷新', Object.assign({}, BTN, { border: '1px solid #2a3550', background: '#1c2438', color: '#8b95ad' }), fetchPanel))

  return React.createElement('div', null, children)
}

/** 服务开关（设置页专用）。 */
function ServerSwitch() {
  var state = useStore()
  var d = state.data || {}
  var enabled = d.enabled === true
  return Btn(
    enabled ? '■ 关闭手机服务' : '▶ 启动手机服务',
    enabled ? Object.assign({}, BTN_DANGER, { marginBottom: '0' }) : Object.assign({}, BTN_PRIMARY, { marginBottom: '0' }),
    function () {
      panelAction(enabled ? STOP_PATH : START_PATH).then(function (r) {
        if (r && r.ok) {
          setData({ enabled: r.enabled === true })
        } else {
          setData({ enabled: false, error: (r && r.error) || '操作失败' })
        }
        setTimeout(fetchPanel, 400)
      })
    }
  )
}

/** 设置 → 插件 → 「手机远程」页。 */
function MobileRemoteTab() {
  React.useEffect(function () {
    fetchPanel()
    var timer = window.setInterval(fetchPanel, 10000)
    return function () { window.clearInterval(timer) }
  }, [])
  var children = []
  children.push(T('📡 手机远程遥控', { fontSize: '15px', fontWeight: '600', marginBottom: '4px' }))
  children.push(T('通过手机浏览器远程查看进度、审批与对话。', DIM))
  children.push(T('', { height: '4px' }))
  children.push(React.createElement(PanelContent, null))
  children.push(T('', { height: '10px' }))
  children.push(React.createElement(ServerSwitch, null))
  children.push(T('提示：手机浏览器打开上方地址，输入配对码即可远程查看进度、审批与对话。', Object.assign({}, DIM, { marginTop: '10px' })))
  return React.createElement('div', { style: { maxWidth: '480px', padding: '4px 0' } }, children)
}

/** 侧边栏快捷按钮浮层。 */
function OverlayPanel() {
  var state = useStore()
  if (!state.open) return null
  return React.createElement('div', { style: PANEL_STYLE }, [
    React.createElement('div', { style: ROW }, [
      T('📡 手机远程遥控', { fontSize: '14px', fontWeight: '600' }),
      React.createElement('button', {
        style: { background: 'none', border: 'none', color: '#8b95ad', fontSize: '14px', cursor: 'pointer', padding: '2px 6px' },
        onClick: function () { storeState = Object.assign({}, storeState, { open: false }); emit() },
      }, '✕'),
    ]),
    React.createElement(PanelContent, null),
  ])
}

function FooterButton() {
  var state = useStore()
  return React.createElement('button', {
    title: '手机远程遥控',
    'aria-label': '手机远程遥控',
    style: { background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', padding: '4px', borderRadius: '8px', lineHeight: '1' },
    onClick: function () {
      storeState = Object.assign({}, storeState, { open: !state.open })
      emit()
      if (!state.open) fetchPanel()
    },
  }, '📡')
}

function apply(ctx) {
  try {
    var disposes = []
    disposes.push(ctx.slots.inject('settings.plugins.tab', function () {
      return ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-mobile-remote.tab', order: 30, label: function () { return '手机远程' } },
        MobileRemoteTab
      )
    }, 'dsh-mobile-remote: settings tab'))

    disposes.push(ctx.slots.inject('sidebar.footer.action', function () {
      return ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-mobile-remote.footer', order: 90, label: function () { return '手机远程' } },
        FooterButton
      )
    }, 'dsh-mobile-remote: footer button'))

    disposes.push(ctx.slots.inject('shell.overlay', function () {
      return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-mobile-remote.overlay', order: 100 },
        OverlayPanel
      )
    }, 'dsh-mobile-remote: overlay panel'))

    var timer = window.setInterval(function () {
      if (storeState.open) fetchPanel()
    }, 10000)

    return function () {
      disposes.forEach(function (d) { try { d() } catch (e) {} })
      if (timer !== null) { window.clearInterval(timer); timer = null }
    }
  } catch (e) {
    try {
      document.title = document.title.replace(/\s*\|\s*MR.*$/, '') + ' | MR-ERR: ' + String((e && e.message) || e)
    } catch (e2) {}
    throw e
  }
}

module.exports = { inject: inject, apply: apply }
return module.exports; } });
