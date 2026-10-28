// test/host-service.test.js — 宿主服务路径（不依赖 slot props）的回归测试。
//
// 背景：dsh 0.2.0-rc.2 在 `conversation.session.header.actions` 上调用
// `renderSlot(..., {})`（dsh-client-ui-conversation/lib/client.js:16502），owner props 为空；
// 第三方 header（如 dsh-better-sidebar）接管 header 区时 props 形状也可能完全不同。
// 1.3.1 只从 slot props 取 useChat/useSession/useSessions，props 一旦缺席面板就永远空态。
// 本文件锁定第二条数据路径：插件在 apply() 时捕获 cordis 服务（sessions / uiSession），
// 组件经 bridge 读「主视图绑定」的 chat 快照。断言：
//   1) props 全空时仍能渲染大纲；
//   2) props 全空时两轮渲染的 hook 序列完全一致（Rules of Hooks，崩溃前提）；
//   3) 服务缺失/恶意服务/垃圾 props 只降级为空态，绝不抛错；
//   4) 服务路径与 props 路径的优先级（props hook 存在时仍以 props 为准）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client.js')

function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

function makeDomStub() {
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollTo() {}, focus() {}, contains: () => false, textContent: '',
    dataset: {}, tagName: 'DIV',
  })
  const document = {
    body: el(), head: el(), documentElement: el(),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: el, createTextNode: () => ({}),
    addEventListener() {}, removeEventListener() {},
  }
  const window = {
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout, clearTimeout,
  }
  return { window, document, navigator: { language: 'en-US', languages: ['en-US'] } }
}

/** 记录 hook 调用序列、useMemo 按 deps 跳过回调的最小 React 桩。
 *  mark 里带 `@cursor#depth`：depth 用于把「槽位组件自己的 hook」和子组件 hook 分开。 */
function makeRecordingReact() {
  const slots = []
  const api = {
    cursor: 0,
    depth: 0,
    marks: [],
    runEffects: false,
    cleanups: [],
    resetRender() { api.cursor = 0; api.depth = 0; api.marks = [] },
    flushCleanups() {
      for (const cleanup of api.cleanups.splice(0)) {
        try { cleanup() } catch (_) { /* 清理失败不影响断言 */ }
      }
    },
    mark(tag) { api.marks.push(`${tag}@${api.cursor}#${api.depth}`) },
    React: null,
  }
  api.React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        const name = type.name || 'anonymous'
        api.mark(`enter:${name}`)
        api.depth += 1
        try {
          return type(props ?? {})
        } finally {
          api.depth -= 1
          api.mark(`leave:${name}`)
        }
      }
      return { type, props: props ?? {}, children }
    },
    Fragment: Symbol('dsh-conv-test-fragment'),
    useState(v) {
      api.mark('useState')
      api.cursor += 1
      return [v, () => {}]
    },
    useReducer(_reducer, initial) {
      api.mark('useReducer')
      api.cursor += 1
      return [initial, () => {}]
    },
    useRef(v) {
      api.mark('useRef')
      const slot = api.cursor < slots.length && slots[api.cursor] ? slots[api.cursor] : { current: v }
      slots[api.cursor] = slot
      api.cursor += 1
      return slot
    },
    useEffect(fn) {
      api.mark('useEffect')
      api.cursor += 1
      // 诊断日志在 effect 里；默认不执行（保持既有测试的纯渲染语义），需要时由测试打开。
      if (api.runEffects === true && typeof fn === 'function') {
        const cleanup = fn()
        if (typeof cleanup === 'function') api.cleanups.push(cleanup)
      }
    },
    useCallback(fn) { api.mark('useCallback'); api.cursor += 1; return fn },
    useMemo(fn, deps) {
      const myIndex = api.cursor
      const prev = slots[myIndex]
      const same = !!prev && !!prev.deps && !!deps
        && prev.deps.length === deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))
      api.mark('useMemo')
      if (same) { api.cursor = myIndex + 1; return prev.value }
      const value = fn()
      slots[myIndex] = { deps, value }
      api.cursor = Math.max(api.cursor, myIndex + 1)
      return value
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      api.mark('useSyncExternalStore')
      api.cursor += 1
      return getSnapshot()
    },
  }
  return api
}

function loadClient(React, consoleFace) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const dom = makeDomStub()
  let registered = null
  dom.window.__ModuleLoader__ = { load: (mod) => { registered = mod } }
  const quietConsole = consoleFace ?? { log() {}, info() {}, warn() {}, error() {} }
  const factory = new Function('window', 'document', 'navigator', 'localStorage', 'console', src)
  factory(dom.window, dom.document, dom.navigator, makeLocalStorage(), quietConsole)
  assert.ok(registered, 'client.js must register itself via window.__ModuleLoader__.load')
  const requireStub = (id) => {
    if (id === 'react') return React
    throw new Error(`client.js must not require "${id}"`)
  }
  return registered.factory(requireStub)
}

/** 从迷你渲染器产出的元素树里收集全部文本。 */
function collectText(node, out) {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out }
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

const CHAT_ROWS = [
  { kind: 'user', key: 'u1', text: 'question from the service' },
  { kind: 'assistant', key: 'a1', text: '## heading from the service' },
]

function makeChatSnapshot(rows) {
  return { legacy: { nodes: rows } }
}

function makeSessionStub(snapshot) {
  return {
    getSnapshot: () => snapshot ?? { hasMore: false, loadingOlder: false },
    subscribe: () => () => {},
    loadOlder: async () => {},
  }
}

/**
 * 假宿主：uiSession.current 是主视图绑定 { key, hooks: { chat, session } }。
 * 与宿主 dsh-client-ui-session 的 materialize() 产物同形（只保留本插件读的字段）。
 */
function makeHost(overrides = {}) {
  const key = overrides.key === undefined ? 's1' : overrides.key
  const chat = overrides.chat === undefined ? makeChatSnapshot(CHAT_ROWS) : overrides.chat
  const session = overrides.session === undefined ? makeSessionStub() : overrides.session
  const binding = {
    key,
    props: { sessionId: key },
    hooks: { chat: { getSnapshot: () => chat, subscribe: () => () => {} }, session },
  }
  const services = {
    uiSession: {
      current: {
        getSnapshot: () => binding,
        subscribe: () => () => {},
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          ids: [key],
          byId: { [key]: { id: key, retainedBy: { mainView: 1 } } },
          phase: 'ready',
        }),
        subscribe: () => () => {},
      },
      binding: (id) => (id === key ? { session } : undefined),
    },
  }
  return {
    read(name) {
      if (overrides.throwOnRead !== undefined && overrides.throwOnRead === name) throw new Error('boom')
      return services[name]
    },
  }
}

/** 走真实 apply() 注册路径，返回槽位组件（owner props 由宿主决定，这里给 {}）。 */
function mountViaApply(api, host) {
  let component = null
  const ctx = {
    slots: {
      inject(_key, callback) { callback() },
      register(_options, comp) { component = comp; return () => {} },
    },
    reflect: { get: (name) => host.read(name) },
  }
  api.apply(ctx)
  assert.equal(typeof component, 'function', 'apply() must register the slot component')
  return component
}

/** 只返回槽位组件自己的 hook（depth 1），排除子组件（占位/面板）的 hook。 */
function ownHooks(marks, name) {
  // 标记形如 `enter:Name@cursor#depth`，所以只能按前缀匹配。
  const enter = marks.findIndex((mark) => mark.startsWith(`enter:${name}@`))
  let leave = -1
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].startsWith(`leave:${name}@`)) { leave = i; break }
  }
  if (enter === -1 || leave === -1) return []
  // 注册进 apply() 的组件是外面那层箭头函数，所以槽位组件的 depth 由 enter 标记自己推出来。
  const depth = Number(marks[enter].split('#')[1]) + 1
  return marks.slice(enter + 1, leave)
    .filter((mark) => !mark.startsWith('enter:') && !mark.startsWith('leave:'))
    .filter((mark) => mark.endsWith(`#${depth}`))
}

/** 服务还在、但当前会话绑定尚未出现的宿主（首屏刷新早期）。 */
function makePendingHost() {
  return {
    read(name) {
      if (name === 'uiSession') {
        return { current: { getSnapshot: () => ({}), subscribe: () => () => {} } }
      }
      if (name === 'sessions') {
        return {
          list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} },
          binding: () => undefined,
        }
      }
      return undefined
    },
  }
}

test('readHostService prefers the cordis reflect layer and never throws', () => {
  const { readHostService } = loadClient(makeRecordingReact().React).internals
  const reflected = { tag: 'reflected' }
  const ctx = {
    reflect: { get: (name) => (name === 'sessions' ? reflected : undefined) },
    sessions: { tag: 'property' },
  }
  assert.equal(readHostService(ctx, 'sessions'), reflected, 'reflect layer wins when it has a value')
  assert.equal(readHostService(ctx, 'uiSession'), ctx.uiSession, 'falls back to the property when absent')
  assert.equal(readHostService(ctx, 'missing'), undefined)
  assert.equal(readHostService(null, 'sessions'), undefined)
  const hostile = {
    get reflect() { throw new Error('no reflect') },
    get sessions() { throw new Error('no sessions') },
  }
  assert.equal(readHostService(hostile, 'sessions'), undefined, 'throwing contexts degrade to undefined')
})

test('mainSessionIdOf follows the host main-view retention and degrades safely', () => {
  const { mainSessionIdOf } = loadClient(makeRecordingReact().React).internals
  const sessions = { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }
  assert.equal(mainSessionIdOf(sessions, {
    ids: ['a', 'b'],
    byId: { a: { retainedBy: { mainView: 1 } }, b: { retainedBy: { mainView: 2 } } },
  }), 'b', 'the session retained by the main view wins')
  assert.equal(mainSessionIdOf(sessions, {
    ids: ['a'], byId: { a: { retainedBy: { mainView: 1 } } },
  }), 'a')
  assert.equal(mainSessionIdOf(sessions, { ids: [], byId: {} }), undefined)
  assert.equal(mainSessionIdOf(undefined, undefined), undefined)
  assert.equal(mainSessionIdOf(sessions, null), undefined, 'no list store, no id')
  assert.equal(mainSessionIdOf({ list: { getSnapshot: () => null } }, undefined), undefined)
})

test('safeNodesOf normalises every junk value to an array', () => {
  const { safeNodesOf } = loadClient(makeRecordingReact().React).internals
  const rows = [{ kind: 'user', text: 'x' }]
  assert.deepEqual(safeNodesOf({ legacy: { nodes: rows } }), rows)
  assert.deepEqual(safeNodesOf(rows), rows)
  for (const junk of [null, undefined, 42, 'text', {}, { legacy: null }, () => rows]) {
    assert.deepEqual(safeNodesOf(junk), [], `expected [] for ${String(junk)}`)
  }
})

test('the slot renders the outline from host services with completely empty owner props', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const component = mountViaApply(api, makeHost())
  rec.resetRender()
  const tree = component({}) // 宿主 renderSlot(..., {}) 的真实形状
  const text = collectText(tree, []).join('\n')
  assert.ok(text.includes('question from the service'), 'user rows must come from uiSession.hooks.chat')
  assert.ok(text.includes('heading from the service'), 'assistant headings must come from the same snapshot')
  assert.ok(text.includes('Questions · Outline'), 'the always-on header button must render too')
})

test('hook sequence stays identical across renders on the service path (rules of hooks)', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const component = mountViaApply(api, makeHost())
  rec.resetRender()
  component({})
  const first = [...rec.marks]
  rec.resetRender()
  component({})
  const second = [...rec.marks]
  assert.ok(first.some((m) => m.startsWith('useSyncExternalStore')), 'service hooks must actually run')
  assert.deepEqual(second, first, 'host service availability must not change the hook sequence')
})

test('garbage slot props from a third-party header cannot take down the slot', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const component = mountViaApply(api, makeHost())
  rec.resetRender()
  const tree = component({
    useChat: 'not-a-hook',
    useSession: 42,
    useSessions: null,
    sessionId: 17,
    sessions: { binding: 'nope', list: 3 },
    store: { subscribe: null },
  })
  const text = collectText(tree, []).join('\n')
  assert.ok(text.includes('question from the service'), 'service path must survive garbage props')
})

test('absent or hostile host services degrade to the empty state instead of throwing', () => {
  // 1) 完全没有宿主桥（旧宿主 / 独立渲染）
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const noHostComponent = mountViaApply(api, { read: () => undefined })
  rec.resetRender()
  const emptyTree = noHostComponent({})
  const emptyText = collectText(emptyTree, []).join('\n')
  assert.ok(emptyText.includes('No outline yet'), 'missing services must render the empty state')

  // 2) 读服务就抛错
  const rec2 = makeRecordingReact()
  const api2 = loadClient(rec2.React)
  const throwComponent = mountViaApply(api2, { read: () => { throw new Error('boom') } })
  rec2.resetRender()
  const throwText = collectText(throwComponent({}), []).join('\n')
  assert.ok(throwText.includes('No outline yet'), 'a throwing bridge must render the empty state')

  // 3) 快照读取本身抛错
  const rec3 = makeRecordingReact()
  const api3 = loadClient(rec3.React)
  const hostileHost = {
    read(name) {
      if (name === 'uiSession') {
        return { current: { getSnapshot: () => { throw new Error('snapshot') }, subscribe: () => () => {} } }
      }
      return undefined
    },
  }
  const hostileComponent = mountViaApply(api3, hostileHost)
  rec3.resetRender()
  const hostileText = collectText(hostileComponent({}), []).join('\n')
  // 服务在、但快照读不出来 ⇒ 视为“未就绪”：先占位，超时后照常挂载空态（effect 在真实 React 里跑）。
  assert.ok(hostileText.includes('Reading conversation…'),
    'a throwing snapshot source must degrade to the placeholder, never throw')
})

test('slot props hooks still win when a host injects them', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const component = mountViaApply(api, makeHost())
  // 宿主若仍注入 useChat（旧契约），以 slot props 的快照为准（与 1.3.1 一致）。
  const propRows = [{ kind: 'user', key: 'u2', text: 'question from props' }]
  rec.resetRender()
  const tree = component({ useChat: () => makeChatSnapshot(propRows) })
  const text = collectText(tree, []).join('\n')
  assert.ok(text.includes('question from props'), 'props-provided snapshots keep precedence')
})

test('panelMountStateOf only defers mounting while the host service is waiting', () => {
  const { panelMountStateOf } = loadClient(makeRecordingReact().React).internals
  assert.equal(panelMountStateOf(undefined, false), 'mount', 'no host bridge: keep the legacy direct mount')
  assert.equal(panelMountStateOf({ available: false, ready: false }, false), 'mount')
  assert.equal(panelMountStateOf({ available: true, ready: false }, false), 'pending')
  assert.equal(panelMountStateOf({ available: true, ready: false }, true), 'mount', 'timeout falls back to the empty panel')
  assert.equal(panelMountStateOf({ available: true, ready: true }, false), 'mount')
})

test('pinned panel renders a placeholder (not the panel) until session data is ready', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const component = mountViaApply(api, makePendingHost())
  rec.resetRender()
  const tree = component({})
  const text = collectText(tree, []).join('\n')
  assert.ok(text.includes('Reading conversation…'), 'the placeholder must explain why the panel is empty')
  assert.ok(text.includes('Questions · Outline'), 'the always-on header button must render before data arrives')
  assert.ok(!text.includes('No outline yet'), 'the panel component itself must not mount while pending')
  const pending = tree.children?.[0]?.[1]
  assert.equal(pending?.props?.['aria-busy'], 'true', 'the placeholder must be announced as busy')
})

test('the slot keeps the same hook sequence when data moves from pending to ready', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  rec.resetRender()
  mountViaApply(api, makePendingHost())({})
  const pending = ownHooks([...rec.marks], 'HistoryOutlineSlot')
  rec.resetRender()
  mountViaApply(api, makeHost())({})
  const ready = ownHooks([...rec.marks], 'HistoryOutlineSlot')
  assert.ok(pending.length > 0, 'the slot must have rendered hooks for a meaningful comparison')
  assert.deepEqual(ready, pending, 'the mount gate must not add or remove hooks between readiness states')
})

test('the rendered panel logs the raw snapshot contract and probes the DOM contract exactly once', () => {
  const logs = []
  const capture = {
    log() {},
    info: (...args) => logs.push(args.map(String).join(' ')),
    warn: (...args) => logs.push(args.map(String).join(' ')),
    error() {},
  }
  const rec = makeRecordingReact()
  const api = loadClient(rec.React, capture)
  const component = mountViaApply(api, makeHost())
  rec.runEffects = true

  rec.resetRender()
  component({})
  const shapeLines = logs.filter((line) => line.includes('session snapshot shape:'))
  assert.equal(shapeLines.length, 1, `expected exactly one shape log, got: ${shapeLines.join(' | ')}`)
  // 报的必须是宿主给的原始形状（legacy.nodes），不是归一后的数组。
  assert.ok(shapeLines[0].includes('legacy.nodes (2 rows)'), shapeLines[0])
  assert.equal(logs.filter((line) => line.includes('DOM contract')).length, 1)

  rec.resetRender()
  component({})
  assert.equal(logs.filter((line) => line.includes('session snapshot shape:')).length, 1, 'shape log is one-shot')
  assert.equal(logs.filter((line) => line.includes('DOM contract')).length, 1, 'DOM log is one-shot')
  rec.flushCleanups()
})
