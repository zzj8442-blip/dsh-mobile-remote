/* dsh-mobile-remote 手机前端 —— 零依赖原生 JS。
 * 协议与桌面 Web GUI 一致：/api/<method> client-request 信封 + events.mux SSE 帧流。
 */
'use strict'

/* ────────────── 工具 ────────────── */
const $ = (sel) => document.querySelector(sel)
const uuid = () => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* 非安全上下文/老内核：走 fallback */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (t) => {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtAgo = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
const shortId = (id) => (id || '').slice(0, 8)

const TURN_END_TEXT = {
  success: '完成', error: '出错', 'max-tokens': '超出长度上限', interrupted: '被打断',
  aborted: '已中止', cancelled: '已取消', steer: '被新消息接管',
}

function toast(msg, ms) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms || 2600)
}

/* ────────────── 状态 ────────────── */
const TITLES_KEY = 'mr_titles_v1'
function loadTitles() {
  try {
    const raw = JSON.parse(localStorage.getItem(TITLES_KEY) || '{}')
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') store.titles.set(k, v)
  } catch { /* 缓存损坏忽略 */ }
}
function saveTitle(sessionId, title) {
  if (!sessionId || !title) return
  store.titles.set(sessionId, title)
  try {
    const obj = Object.fromEntries(store.titles.entries())
    // 控制容量：最多保留 300 条
    const keys = Object.keys(obj)
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete obj[k]
    localStorage.setItem(TITLES_KEY, JSON.stringify(obj))
  } catch { /* 存储满忽略 */ }
}

const store = {
  token: localStorage.getItem('mr_token') || '',
  view: 'login', // login | list | chat
  sessions: new Map(), // id -> {sessionId, updatedAt, running, blank, cwd, agentPreset, title}
  titles: new Map(), // id -> title（localStorage 持久化）
  titleFetched: new Set(), // 本次会话已尝试拉取标题的 id（避免重复请求）
  chat: null, // {sessionId, messages: [], queueCount, jobs: [], lastSeq}
  pendingApprovals: new Map(), // 全局未决审批 approvalId -> {...}
  pendingQuestions: new Map(), // 全局未决问题 rpcId -> {...}
  pendingTotal: 0, // 全局未处理审批+问题数
  esMux: null,
  esHost: null,
}
loadTitles()

/* ────────────── API ────────────── */
const API_TIMEOUT_MS = 20000

async function apiCall(method, payload) {
  const rpcId = uuid()
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), API_TIMEOUT_MS) : null
  let res
  try {
    res = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + store.token },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload || {} }),
      signal: ctrl ? ctrl.signal : undefined,
    })
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（20 秒无响应），请检查网络')
    throw new Error('无法连接电脑（' + e.message + '）')
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (res.status === 401) { handleUnauthorized(); throw new Error('unauthorized') }
  if (res.status === 403) throw new Error('该方法未对手机端开放')
  const data = await res.json()
  if (!data || data.type !== 'server-response') throw new Error('响应格式异常')
  const result = data.result
  if (!result.ok) {
    const err = result.error || {}
    const msg = err.message || err.code || '请求失败'
    throw new Error(msg + (err.code ? `（${err.code}）` : ''))
  }
  return result.value
}

async function respondValue(value, rpcId) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), API_TIMEOUT_MS) : null
  let res
  try {
    res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + store.token },
      body: JSON.stringify({ type: 'client-response', rpcId: rpcId || uuid(), result: { ok: true, value } }),
      signal: ctrl ? ctrl.signal : undefined,
    })
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络')
    throw new Error('无法连接电脑')
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (res.status === 401) { handleUnauthorized(); throw new Error('unauthorized') }
  return res.json()
}

/* ────────────── 认证 ────────────── */
function handleUnauthorized() {
  localStorage.removeItem('mr_token')
  store.token = ''
  closeStreams()
  showView('login')
  toast('令牌已失效，请重新配对')
}

async function doPair() {
  const pin = $('#pin-input').value.trim()
  if (!/^\d{6}$/.test(pin)) { showLoginError('请输入 6 位数字配对码'); return }
  let res
  try {
    res = await fetch('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
  } catch { showLoginError('无法连接电脑，请检查地址与网络'); return }
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data.ok && data.token) {
    store.token = data.token
    localStorage.setItem('mr_token', data.token)
    hideLoginError()
    await enterList()
  } else if (res.status === 429) {
    showLoginError('尝试次数过多，已锁定，请几分钟后再试')
  } else {
    showLoginError(data.error === 'bad-pin' ? `配对码错误（还可尝试 ${data.attemptsLeft} 次）` : '配对失败')
  }
}

/* ────────────── 视图切换 ────────────── */
function showView(v) {
  store.view = v
  $('#view-login').classList.toggle('hidden', v !== 'login')
  $('#view-list').classList.toggle('hidden', v !== 'list')
  $('#view-chat').classList.toggle('hidden', v !== 'chat')
}
function showLoginError(msg) { const el = $('#login-error'); el.textContent = msg; el.classList.remove('hidden') }
function hideLoginError() { $('#login-error').classList.add('hidden') }

/* ────────────── 事件流 ────────────── */
function openStreams() {
  closeStreams()
  const tok = encodeURIComponent(store.token)
  store.esMux = new EventSource('/api/events.mux?token=' + tok)
  store.esHost = new EventSource('/api/events.host?token=' + tok)
  store.esMux.onmessage = (ev) => { try { onFrame(JSON.parse(ev.data)) } catch {} }
  store.esMux.onerror = () => { /* EventSource 自动重连 */ }
  store.esMux.onopen = () => {
    if (store.view === 'chat' && store.chat) reloadChatHistory(true)
  }
  store.esHost.onmessage = (ev) => { try { onHostFrame(JSON.parse(ev.data)) } catch {} }
  store.esHost.onerror = () => {}
}
function closeStreams() {
  if (store.esMux) { store.esMux.close(); store.esMux = null }
  if (store.esHost) { store.esHost.close(); store.esHost = null }
}

function onHostFrame(frame) {
  const p = frame.payload || {}
  switch (p.type) {
    case 'host/session-status': {
      const s = store.sessions.get(p.sessionId)
      if (s) { s.running = p.running; renderList() }
      if (store.chat && store.chat.sessionId === p.sessionId) renderChatStatus()
      break
    }
    case 'host/session-added':
      store.sessions.set(p.sessionId, { sessionId: p.sessionId, updatedAt: Date.now(), running: false, blank: p.blank, cwd: p.cwd, agentPreset: p.agentPreset, title: store.titles.get(p.sessionId) })
      if (store.view === 'list') renderList()
      break
    case 'host/session-removed':
      store.sessions.delete(p.sessionId)
      if (store.view === 'list') renderList()
      break
    case 'host/agent-error':
      if (store.chat && store.chat.sessionId === p.sessionId) toast('⚠️ ' + (p.message || 'agent 出错'))
      break
  }
}

function onFrame(frame) {
  const p = frame.payload || {}
  switch (p.type) {
    case 'session/event':
      onSessionEvent(p.sessionId, p.event || {})
      break
    case 'approval/requested':
      store.pendingApprovals.set(p.approvalId, { rpcId: frame.rpcId, sessionId: p.sessionId, approvalId: p.approvalId, toolName: p.toolName, callId: p.callId, reason: p.reason })
      store.pendingTotal = store.pendingApprovals.size + store.pendingQuestions.size
      if (store.view === 'chat') renderPending()
      if (store.view === 'list') renderListPending()
      break
    case 'approval/resolved':
      store.pendingApprovals.delete(p.approvalId)
      store.pendingTotal = store.pendingApprovals.size + store.pendingQuestions.size
      if (store.view === 'chat') renderPending()
      if (store.view === 'list') renderListPending()
      break
    case 'question/requested':
      store.pendingQuestions.set(frame.rpcId, { sessionId: p.sessionId, rpcId: frame.rpcId, questions: p.questions || [] })
      store.pendingTotal = store.pendingApprovals.size + store.pendingQuestions.size
      if (store.view === 'chat') renderPending()
      if (store.view === 'list') renderListPending()
      break
    case 'question/resolved':
      store.pendingQuestions.delete(p.questionRpcId)
      store.pendingTotal = store.pendingApprovals.size + store.pendingQuestions.size
      if (store.view === 'chat') renderPending()
      if (store.view === 'list') renderListPending()
      break
    case 'session/queue':
      if (store.chat && store.chat.sessionId === p.sessionId) {
        store.chat.queueCount = (p.items || []).length
        renderQueueInfo()
      }
      break
    case 'session/jobs':
      if (store.chat && store.chat.sessionId === p.sessionId) {
        store.chat.jobs = p.jobs || []
        renderJobs()
      }
      break
  }
}

function onSessionEvent(sessionId, event) {
  // 标题缓存
  if (event.type === 'session/title' && event.data && event.data.title) {
    saveTitle(sessionId, event.data.title)
    const s = store.sessions.get(sessionId)
    if (s) { s.title = event.data.title; if (store.view === 'list') renderList() }
    if (store.chat && store.chat.sessionId === sessionId) $('#chat-title').textContent = event.data.title
  }
  if (!store.chat || store.chat.sessionId !== sessionId) return
  const chat = store.chat
  if (event.seq > (chat.lastSeq || 0)) chat.lastSeq = event.seq
  switch (event.type) {
    case 'user/message': {
      const msg = event.data || {}
      if (msg.source && msg.source.kind !== 'user' && msg.source.kind !== 'tool') return // 系统注入消息不显示
      appendMessage({
        kind: 'user', key: 'u:' + event.seq, text: blocksText(msg.content),
        hasImage: hasImageBlock(msg.content), imageBlocks: imageBlocksOf(msg.content),
        time: event.time, seq: event.seq,
      })
      break
    }
    case 'assistant/message': {
      const data = event.data || {}
      const key = `a:${data.turn}:${data.step}`
      const existing = chat.messages.find((m) => m.key === key)
      const content = (data.message && data.message.content) || []
      if (existing) {
        existing.text = blocksText(content)
        existing.streaming = false
        existing.toolCalls = toolCallsOf(content)
        renderMessageNode(existing)
      } else {
        appendMessage({
          kind: 'assistant', key, text: blocksText(content),
          toolCalls: toolCallsOf(content), time: event.time, seq: event.seq, streaming: false,
        })
      }
      break
    }
    case 'assistant/chunk': {
      const data = event.data || {}
      const chunk = data.chunk || {}
      if (chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
      const key = `a:${data.turn}:${data.step}`
      let node = chat.messages.find((m) => m.key === key)
      if (!node) {
        node = { kind: 'assistant', key, text: '', time: event.time, seq: event.seq, streaming: true }
        chat.messages.push(node)
      } else if (!node.streaming) {
        // 已有 finalized 消息又来 chunk（罕见）：作为新流式节点
        node = { kind: 'assistant', key, text: '', time: event.time, seq: event.seq, streaming: true }
        chat.messages.push(node)
      }
      node.streaming = true
      node.text += chunk.text
      scheduleChunkRender(node)
      break
    }
    case 'tool/call': {
      const d = event.data || {}
      let argsPreview = ''
      try {
        const args = JSON.parse(d.arguments || '{}')
        argsPreview = JSON.stringify(args)
        if (argsPreview.length > 120) argsPreview = argsPreview.slice(0, 120) + '…'
      } catch { argsPreview = '' }
      appendMessage({
        kind: 'tool', key: 't:' + d.callId, toolName: d.name, argsPreview,
        state: 'running', time: event.time, seq: event.seq,
      })
      break
    }
    case 'tool/result': {
      const d = event.data || {}
      const callId = d.message && d.message.source && d.message.source.callId
      const node = chat.messages.find((m) => m.key === 't:' + callId)
      if (node) {
        const first = (d.message && d.message.content && d.message.content[0]) || {}
        const text = typeof first.content === 'string' ? first.content : ''
        node.state = d.meta && d.meta.isError ? 'error' : 'done'
        node.resultPreview = text.slice(0, 100)
        renderMessageNode(node)
      }
      break
    }
    case 'turn/start':
      appendMessage({ kind: 'meta', key: 'turn:' + event.data.turn + ':start', text: '▶ 开始处理', time: event.time, seq: event.seq })
      break
    case 'turn/end': {
      const raw = event.data && event.data.reason
      const reason = raw && typeof raw === 'object' ? (raw.kind || raw.reason) : raw
      const label = TURN_END_TEXT[reason] || reason || '结束'
      appendMessage({ kind: 'meta', key: 'turn:' + (event.data && event.data.turn) + ':end', text: `■ 本轮${label}`, time: event.time, seq: event.seq })
      break
    }
  }
}

/* ────────────── 内容解析 ────────────── */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((b) => {
    if (!b || typeof b !== 'object') return ''
    if (b.type === 'text') return typeof b.text === 'string' ? b.text : ''
    if (b.type === 'image') return '📷 图片'
    if (b.type === 'tool-call') return ''
    if (b.type === 'tool-result') return ''
    return ''
  }).filter(Boolean).join('\n')
}
function hasImageBlock(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'image' && (b.data || b.attachmentId))
}
function imageBlocksOf(content) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'image' && (b.data || b.attachmentId)) : []
}
function toolCallsOf(content) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'tool-call').map((b) => b.name || 'tool') : []
}

/* ────────────── 会话列表 ────────────── */
async function enterList() {
  showView('list')
  openStreams()
  await refreshList()
}

async function refreshList() {
  try {
    const value = await apiCall('session.list', {})
    const items = value.items || []
    const now = new Map()
    for (const it of items) {
      const prev = store.sessions.get(it.sessionId)
      now.set(it.sessionId, {
        sessionId: it.sessionId, updatedAt: it.updatedAt, running: it.running === true,
        blank: it.blank === true, cwd: it.cwd, agentPreset: it.agentPreset,
        title: store.titles.get(it.sessionId) || (prev && prev.title),
      })
    }
    store.sessions = now
    renderList()
    lazyFetchTitles()
  } catch (e) {
    if (e.message !== 'unauthorized') toast('加载会话失败：' + e.message)
  }
}

/** 逐会话拉取标题（session/title 事件），本地缓存；只处理最近 N 个无标题会话，并发受限。 */
const TITLE_FETCH_LIMIT = 12
const TITLE_FETCH_CONCURRENCY = 3
async function fetchSessionTitle(sessionId) {
  try {
    const value = await apiCall('session.history', { sessionId })
    const events = value.events || []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i].event || events[i]
      if (ev.type === 'session/title' && ev.data && ev.data.title) {
        saveTitle(sessionId, ev.data.title)
        const s = store.sessions.get(sessionId)
        if (s) { s.title = ev.data.title; renderList() }
        return
      }
    }
  } catch { /* 失败静默，下次进入再试 */ }
}
function lazyFetchTitles() {
  const rows = [...store.sessions.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const pending = rows
    .filter((s) => !store.titles.get(s.sessionId) && !store.titleFetched.has(s.sessionId))
    .slice(0, TITLE_FETCH_LIMIT)
  if (pending.length === 0) return
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const s = pending[cursor]
      cursor += 1
      store.titleFetched.add(s.sessionId)
      await fetchSessionTitle(s.sessionId)
    }
  }
  for (let i = 0; i < Math.min(TITLE_FETCH_CONCURRENCY, pending.length); i++) worker()
}

function renderList() {
  const ul = $('#session-list')
  ul.innerHTML = ''
  const rows = [...store.sessions.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  if (rows.length === 0) {
    $('#list-empty').classList.remove('hidden')
  } else {
    $('#list-empty').classList.add('hidden')
  }
  for (const s of rows) {
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = 'dot' + (s.running ? ' running' : '')
    const main = document.createElement('div')
    main.className = 'sess-main'
    const t = document.createElement('div')
    t.className = 'sess-title'
    t.textContent = s.title || (s.cwd ? (s.cwd.split(/[\\/]/).pop() || '会话') + ' · ' + shortId(s.sessionId) : '会话 ' + shortId(s.sessionId))
    const m = document.createElement('div')
    m.className = 'sess-meta'
    const bits = []
    if (s.running) bits.push('● 运行中')
    if (s.blank) bits.push('空白')
    if (s.agentPreset) bits.push(s.agentPreset)
    if (s.cwd) bits.push(s.cwd)
    m.textContent = bits.join(' · ') || '—'
    main.append(t, m)
    const time = document.createElement('div')
    time.className = 'sess-time'
    time.textContent = fmtAgo(s.updatedAt)
    li.append(dot, main, time)
    li.addEventListener('click', () => openChat(s.sessionId))
    ul.appendChild(li)
  }
  renderListPending()
}

function renderListPending() {
  const el = $('#list-pending')
  if (store.pendingTotal > 0) {
    el.textContent = `⏳ 有 ${store.pendingTotal} 项审批/问题等待处理，打开对应会话查看`
    el.classList.remove('hidden')
  } else {
    el.classList.add('hidden')
  }
}

/* ────────────── 聊天页 ────────────── */
async function openChat(sessionId) {
  store.chat = { sessionId, messages: [], queueCount: 0, jobs: [], lastSeq: 0 }
  showView('chat')
  $('#chat-title').textContent = store.titles.get(sessionId) || '会话 ' + shortId(sessionId)
  $('#messages').innerHTML = ''
  renderPending()
  renderChatStatus()
  await reloadChatHistory(false)
}

async function reloadChatHistory(silent) {
  const chat = store.chat
  if (!chat) return
  // 加载提示
  if (!silent) {
    const box = $('#messages')
    if (box && box.children.length === 0) {
      const tip = document.createElement('div')
      tip.className = 'msg meta'
      tip.id = 'history-loading'
      tip.textContent = '正在加载历史消息…'
      box.appendChild(tip)
    }
  }
  try {
    // maxMessages 限制响应大小（慢链路上小响应更快到达）
    const value = await apiCall('session.history', { sessionId: chat.sessionId, maxMessages: 60 })
    const events = value.events || []
    // 提取标题
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i].event || events[i]
      if (ev.type === 'session/title' && ev.data && ev.data.title) {
        saveTitle(chat.sessionId, ev.data.title)
        $('#chat-title').textContent = ev.data.title
        break
      }
    }
    // 重建消息（跳过流式 chunk 的噪音：只取 user/message、assistant/message、tool/call、tool/result、turn 边界）
    const rebuilt = []
    const seqOf = (e) => (e.event || e).seq || 0
    events.sort((a, b) => seqOf(a) - seqOf(b))
    for (const entry of events) {
      const ev = entry.event || entry
      if (!ev || !ev.type) continue
      if (ev.type === 'user/message') {
        const msg = ev.data || {}
        if (msg.source && msg.source.kind !== 'user' && msg.source.kind !== 'tool') continue
        rebuilt.push({ kind: 'user', key: 'u:' + ev.seq, text: blocksText(msg.content), hasImage: hasImageBlock(msg.content), imageBlocks: imageBlocksOf(msg.content), time: ev.time, seq: ev.seq })
      } else if (ev.type === 'assistant/message') {
        const data = ev.data || {}
        const content = (data.message && data.message.content) || []
        rebuilt.push({ kind: 'assistant', key: `a:${data.turn}:${data.step}`, text: blocksText(content), toolCalls: toolCallsOf(content), time: ev.time, seq: ev.seq, streaming: false })
      } else if (ev.type === 'tool/call') {
        const d = ev.data || {}
        let argsPreview = ''
        try { const a = JSON.parse(d.arguments || '{}'); argsPreview = JSON.stringify(a); if (argsPreview.length > 120) argsPreview = argsPreview.slice(0, 120) + '…' } catch {}
        rebuilt.push({ kind: 'tool', key: 't:' + d.callId, toolName: d.name, argsPreview, state: 'running', time: ev.time, seq: ev.seq })
      } else if (ev.type === 'tool/result') {
        const d = ev.data || {}
        const callId = d.message && d.message.source && d.message.source.callId
        const node = rebuilt.find((m) => m.key === 't:' + callId)
        if (node) {
          const first = (d.message && d.message.content && d.message.content[0]) || {}
          node.state = d.meta && d.meta.isError ? 'error' : 'done'
          node.resultPreview = typeof first.content === 'string' ? first.content.slice(0, 100) : ''
        }
      } else if (ev.type === 'turn/start') {
        rebuilt.push({ kind: 'meta', key: 'turn:' + ev.data.turn + ':start', text: '▶ 开始处理', time: ev.time, seq: ev.seq })
      } else if (ev.type === 'turn/end') {
        const raw = ev.data && ev.data.reason
        const reason = raw && typeof raw === 'object' ? (raw.kind || raw.reason) : raw
        const label = TURN_END_TEXT[reason] || reason || '结束'
        rebuilt.push({ kind: 'meta', key: 'turn:' + (ev.data && ev.data.turn) + ':end', text: `■ 本轮${label}`, time: ev.time, seq: ev.seq })
      }
      if (ev.seq > (chat.lastSeq || 0)) chat.lastSeq = ev.seq
    }
    chat.messages = rebuilt
    trimMessages()
    renderMessages()
    renderChatStatus()
  } catch (e) {
    const loading = document.getElementById('history-loading')
    if (loading) loading.remove()
    if (!silent && e.message !== 'unauthorized') toast('加载历史失败：' + e.message)
  }
}

function trimMessages() {
  const chat = store.chat
  if (!chat) return
  if (chat.messages.length > 400) chat.messages = chat.messages.slice(-400)
}

const RENDER_LIMIT = 250

function renderMessages() {
  const chat = store.chat
  if (!chat) return
  const box = $('#messages')
  box.innerHTML = ''
  const msgs = chat.messages
  const showFrom = Math.max(0, msgs.length - RENDER_LIMIT)
  const frag = document.createDocumentFragment()
  if (showFrom > 0) {
    const fold = document.createElement('div')
    fold.className = 'msg meta'
    fold.textContent = `⋯ 更早的 ${showFrom} 条已折叠 ⋯`
    frag.appendChild(fold)
  }
  for (let i = showFrom; i < msgs.length; i++) frag.appendChild(buildMessageNode(msgs[i]))
  box.appendChild(frag)
  scrollToBottom()
}

/** 增量追加一条新消息（超渲染上限时回退全量重绘）。 */
function appendMessage(m) {
  const chat = store.chat
  if (!chat) return
  chat.messages.push(m)
  trimMessages()
  if (chat.messages.length > RENDER_LIMIT) {
    renderMessages()
    return
  }
  $('#messages').appendChild(buildMessageNode(m))
  scrollToBottom()
}

/** 流式渲染节流：同一帧内的多个 chunk 合并为一次 DOM 更新。 */
let chunkDirty = new Set()
let rafPending = false
function scheduleChunkRender(node) {
  chunkDirty.add(node)
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    const dirty = chunkDirty
    chunkDirty = new Set()
    for (const n of dirty) renderMessageNode(n)
    scrollToBottomIfNear()
  })
}

function scrollToBottomIfNear() {
  const box = $('#messages')
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) scrollToBottom()
}

function buildMessageNode(m) {
  const div = document.createElement('div')
  div.dataset.key = m.key
  if (m.kind === 'user') {
    div.className = 'msg user'
    div.textContent = m.text || '（空消息）'
    if (m.imageBlocks && m.imageBlocks.length) {
      for (const b of m.imageBlocks) {
        if (b.data && b.mediaType) {
          const img = document.createElement('img')
          img.src = `data:${b.mediaType};base64,${b.data}`
          div.appendChild(img)
        } else {
          const tag = document.createElement('div')
          tag.className = 'blk-label'
          tag.textContent = '📷 图片（附件）'
          div.appendChild(tag)
        }
      }
    }
  } else if (m.kind === 'assistant') {
    div.className = 'msg assistant' + (m.streaming ? ' streaming' : '')
    div.textContent = m.text || ''
    if (m.streaming) {
      const cursor = document.createElement('span')
      cursor.className = 'cursor'
      div.appendChild(cursor)
    }
    if (m.toolCalls && m.toolCalls.length) {
      const row = document.createElement('div')
      row.className = 'blk-label'
      row.textContent = '🔧 ' + m.toolCalls.join(', ')
      div.appendChild(row)
    }
  } else if (m.kind === 'tool') {
    div.className = 'msg tool'
    const icon = m.state === 'done' ? '✅' : m.state === 'error' ? '❌' : '⏳'
    const name = document.createElement('span')
    name.className = 'tn'
    name.textContent = `${icon} ${m.toolName || 'tool'}`
    div.appendChild(name)
    if (m.argsPreview) {
      div.appendChild(document.createTextNode(' ' + m.argsPreview))
    }
    if (m.resultPreview) {
      const r = document.createElement('div')
      r.textContent = m.resultPreview
      div.appendChild(r)
    }
  } else if (m.kind === 'meta') {
    div.className = 'msg meta'
    div.textContent = m.text
  }
  const t = document.createElement('div')
  t.className = 'time'
  t.textContent = fmtTime(m.time || Date.now())
  div.appendChild(t)
  return div
}

function renderMessageNode(m) {
  const box = $('#messages')
  // key 只含字母数字冒号点（u:123 / a:1:2 / t:callid / turn:1），安全转义后作属性选择器
  const safeKey = String(m.key).replace(/[^a-zA-Z0-9:.-]/g, '\\$&')
  const el = box.querySelector(`[data-key="${safeKey}"]`)
  if (el) {
    el.replaceWith(buildMessageNode(m))
  } else {
    box.appendChild(buildMessageNode(m))
  }
  scrollToBottomIfNear()
}

function scrollToBottom() {
  const box = $('#messages')
  box.scrollTop = box.scrollHeight
}

function renderChatStatus() {
  const chat = store.chat
  if (!chat) return
  const s = store.sessions.get(chat.sessionId)
  const running = s ? s.running === true : false
  $('#chat-status').textContent = running ? '● 运行中' : '空闲'
  $('#cancel-btn').classList.toggle('hidden', !running)
}

function renderJobs() {
  const chat = store.chat
  if (!chat) return
  const running = chat.jobs.filter((j) => j.status === 'running' || j.status === 'stopping')
  $('#chat-status').textContent = running.length
    ? `⏳ ${running[0].label || '后台任务'}…`
    : (store.sessions.get(chat.sessionId) && store.sessions.get(chat.sessionId).running ? '● 运行中' : '空闲')
  $('#cancel-btn').classList.toggle('hidden', !(store.sessions.get(chat.sessionId) && store.sessions.get(chat.sessionId).running))
}

function renderQueueInfo() {
  const chat = store.chat
  if (!chat) return
  $('#queue-info').textContent = chat.queueCount > 0 ? `排队中：${chat.queueCount} 条` : ''
}

function renderPending() {
  const chat = store.chat
  if (!chat) return
  const box = $('#chat-pending')
  const cards = $('#question-cards')
  box.innerHTML = ''
  cards.innerHTML = ''
  box.classList.add('hidden')
  cards.classList.add('hidden')
  // 审批卡片（按会话过滤）
  for (const a of store.pendingApprovals.values()) {
    if (a.sessionId !== chat.sessionId) continue
    const card = document.createElement('div')
    card.className = 'card approval'
    const h = document.createElement('h3')
    h.textContent = '🔐 需要审批'
    const tool = document.createElement('div')
    tool.className = 'tool'
    tool.textContent = a.toolName || '工具调用'
    card.append(h, tool)
    if (a.reason) {
      const r = document.createElement('div')
      r.className = 'reason'
      r.textContent = a.reason
      card.appendChild(r)
    }
    const btns = document.createElement('div')
    btns.className = 'card-btns'
    const allow = document.createElement('button')
    allow.className = 'btn-allow'
    allow.textContent = '允许一次'
    allow.addEventListener('click', async () => {
      try {
        const r = await respondValue({ sessionId: a.sessionId, approvalId: a.approvalId, outcome: 'allowed-once' }, a.rpcId)
        if (r && r.accepted === true) toast('已允许')
        else toast('响应失败：' + ((r && r.reason) || '未知'))
      } catch (e) { if (e.message !== 'unauthorized') toast(e.message) }
    })
    const reject = document.createElement('button')
    reject.className = 'btn-reject'
    reject.textContent = '拒绝'
    reject.addEventListener('click', async () => {
      try {
        const r = await respondValue({ sessionId: a.sessionId, approvalId: a.approvalId, outcome: 'rejected' }, a.rpcId)
        if (r && r.accepted === true) toast('已拒绝')
        else toast('响应失败：' + ((r && r.reason) || '未知'))
      } catch (e) { if (e.message !== 'unauthorized') toast(e.message) }
    })
    btns.append(allow, reject)
    card.appendChild(btns)
    box.appendChild(card)
    box.classList.remove('hidden')
  }
  // 问题卡片（按会话过滤）
  for (const q of store.pendingQuestions.values()) {
    if (q.sessionId !== chat.sessionId) continue
    for (const question of q.questions) {
      const card = document.createElement('div')
      card.className = 'card question'
      if (question.header) {
        const h = document.createElement('h3')
        h.textContent = question.header
        card.appendChild(h)
      }
      const body = document.createElement('div')
      body.className = 'reason'
      body.textContent = question.question || ''
      card.appendChild(body)
      if (question.detail) {
        const d = document.createElement('div')
        d.className = 'reason'
        d.textContent = question.detail
        card.appendChild(d)
      }
      const selected = new Set()
      const opts = document.createElement('div')
      opts.className = 'opts'
      for (const opt of (question.options || [])) {
        const b = document.createElement('button')
        b.className = 'opt'
        b.textContent = opt.label
        if (opt.description) {
          const desc = document.createElement('span')
          desc.className = 'desc'
          desc.textContent = opt.description
          b.appendChild(desc)
        }
        b.addEventListener('click', () => {
          if (question.multiSelect) {
            if (selected.has(opt.label)) { selected.delete(opt.label); b.classList.remove('sel') }
            else { selected.add(opt.label); b.classList.add('sel') }
          } else {
            selected.clear()
            opts.querySelectorAll('.opt').forEach((x) => x.classList.remove('sel'))
            selected.add(opt.label)
            b.classList.add('sel')
          }
        })
        opts.appendChild(b)
      }
      card.appendChild(opts)
      const send = document.createElement('button')
      send.className = 'btn-send'
      send.textContent = '提交回答'
      send.addEventListener('click', async () => {
        const answer = { id: question.id, selected: [...selected] }
        try {
          const r = await respondValue({
            sessionId: q.sessionId,
            answer: { answers: [answer] },
          }, q.rpcId)
          if (r && r.accepted === true) toast('已提交')
          else toast('提交失败：' + ((r && r.reason) || '未知'))
        } catch (e) { if (e.message !== 'unauthorized') toast(e.message) }
      })
      card.appendChild(send)
      cards.appendChild(card)
    }
  }
}

/* ────────────── 发送 / 取消 / 新建 ────────────── */
async function sendMessage() {
  const chat = store.chat
  const input = $('#msg-input')
  const text = input.value.trim()
  if (!chat || !text) return
  const mode = $('#steer-toggle').checked ? 'steer' : 'queue'
  input.value = ''
  autoGrow(input)
  try {
    await apiCall('session.prompt', { sessionId: chat.sessionId, mode, content: [{ type: 'text', text }] })
    toast('已发送 ✓' + (mode === 'steer' ? '（打断）' : '（排队）'))
  } catch (e) {
    if (e.message !== 'unauthorized') { toast('发送失败：' + e.message); input.value = text }
  }
}

async function cancelRun() {
  const chat = store.chat
  if (!chat) return
  try {
    await apiCall('session.cancel', { sessionId: chat.sessionId })
    toast('已请求取消')
  } catch (e) { if (e.message !== 'unauthorized') toast('取消失败：' + e.message) }
}

async function createSession() {
  try {
    const value = await apiCall('session.create', {})
    if (value && value.sessionId) openChat(value.sessionId)
    else toast('创建失败')
  } catch (e) { if (e.message !== 'unauthorized') toast('创建失败：' + e.message) }
}

/* ────────────── 输入框自适应 ────────────── */
function autoGrow(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

/* ────────────── 事件绑定 ────────────── */
$('#pair-btn').addEventListener('click', doPair)
$('#pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPair() })
$('#pin-input').addEventListener('input', () => hideLoginError())
$('#send-btn').addEventListener('click', sendMessage)
$('#msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage() }
})
$('#msg-input').addEventListener('input', (e) => autoGrow(e.target))
$('#cancel-btn').addEventListener('click', cancelRun)
$('#new-session-btn').addEventListener('click', createSession)
$('#back-btn').addEventListener('click', () => { store.chat = null; renderList(); enterList() })

/* ────────────── 启动 ────────────── */
function boot() {
  if (store.token) {
    showView('list')
    enterList().catch(() => {})
  } else {
    showView('login')
    setTimeout(() => $('#pin-input').focus(), 100)
  }
}
boot()
