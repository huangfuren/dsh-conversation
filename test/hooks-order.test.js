// test/hooks-order.test.js — HistoryOutlinePanelInner 的 Rules of Hooks 回归测试。
//
// 背景（1.3.1 槽位崩溃根因）：组件曾在 currentSessionNodes 的 useMemo 回调里"条件"调用
// 宿主注入的 useSessions —— 它是真正的 React hook。挂载轮（hookNodes 为空、回退分支执行）
// 它连同 use-sync-external-store shim 内部的 useRef/useMemo/useSyncExternalStore/useEffect
// 一起被追加进 hook 链；下一轮渲染（插件自身 effect 的 bump() 必然触发一次）memo 因 deps
// 未变跳过回调，这些内部 hook 从链上消失，后续 hook 与上一轮错位配对，React 在比较 memo
// deps 时对 undefined 读 .length 抛 TypeError —— 宿主槽位边界捕获后，整个槽位入口（含
// 常驻「大纲」按钮）被替换为空节点。触发条件恰是"面板展开（pinned 默认 true）+ 刷新时
// 会话数据尚未就绪"，与"收起时刷新正常 / 无痕窗口无面板"实为同一机制。
//
// 测试用一个"按 deps 跳过 memo"的最小 React 桩（复现真实 React 的关键行为；上游桩的
// useMemo 永远执行回调，所以测不出这一类缺陷）驱动组件渲染两轮，断言两轮 hook 调用
// 序列完全一致。旧代码在本文件第一组断言上必红。
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
    dataset: {},
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
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setTimeout, clearTimeout,
  }
  return { window, document, navigator: { language: 'en-US', languages: ['en-US'] } }
}

/** 会记录 hook 调用序列、且 useMemo 按 deps 跳过回调的最小 React 桩。 */
function makeRecordingReact() {
  const slots = [] // 跨渲染持久的每个 hook 槽位（模拟 fiber 的 hook 链）
  const api = {
    cursor: 0,
    marks: [],
    resetRender() { api.cursor = 0; api.marks = [] },
    mark(tag) { api.marks.push(`${tag}@${api.cursor}`) },
    React: null,
  }
  api.React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type(props ?? {})
      return { type, props: props ?? {}, children }
    },
    Fragment: Symbol('dsh-conv-test-fragment'),
    useState(v) {
      api.mark('useState')
      const slot = api.cursor < slots.length ? slots[api.cursor] : { value: typeof v === 'function' ? v() : v }
      slots[api.cursor] = slot
      api.cursor += 1
      return [slot.value, () => {}]
    },
    useReducer(_reducer, initial) {
      api.mark('useReducer')
      const slot = api.cursor < slots.length ? slots[api.cursor] : { value: initial }
      slots[api.cursor] = slot
      api.cursor += 1
      return [slot.value, () => {}]
    },
    useRef(v) {
      api.mark('useRef')
      const slot = api.cursor < slots.length && slots[api.cursor] ? slots[api.cursor] : { current: v }
      slots[api.cursor] = slot
      api.cursor += 1
      return slot
    },
    useEffect() { api.mark('useEffect'); api.cursor += 1 },
    useCallback(fn) { api.mark('useCallback'); api.cursor += 1; return fn },
    useMemo(fn, deps) {
      // 记账规则：回调里若再调用 hook（正是被测缺陷的形态），嵌套 hook 占据后续槽位，
      // 本 memo 的槽位保持在进入时的索引——与真实 React 的 hook 链追加方式一致。
      const myIndex = api.cursor
      const prev = slots[myIndex]
      const same = !!prev && !!prev.deps && !!deps
        && prev.deps.length === deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))
      // 只记录 hook 的种类与位置：memo 命中(跳过回调)与未命中都是合法行为，
      // Rules of Hooks 关心的是"每轮调用了哪些 hook、按什么顺序"。
      api.mark('useMemo')
      if (same) { api.cursor = myIndex + 1; return prev.value }
      const value = fn()
      slots[myIndex] = { deps, value }
      api.cursor = Math.max(api.cursor, myIndex + 1)
      return value
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      api.mark('useSyncExternalStore')
      slots[api.cursor] = {}
      api.cursor += 1
      return getSnapshot()
    },
  }
  return api
}

/**
 * 宿主注入 hook 的桩：模仿 use-sync-external-store/with-selector 的行为 ——
 * 每次调用按序使用 useRef/useMemo/useSyncExternalStore/useEffect 四个 hook，
 * 且同一（快照 × selector 源码）的选择结果保持同一引用（真实 shim 的 memoize 语义，
 * 这正是让下一轮渲染跳过 memo、从而暴露 hook 链错位的关键）。
 */
function makeHostSelectorHook(rec, tag, getSnapshot) {
  const cache = new Map() // key: selector 源码;值: {snap, value}
  return (selector) => {
    rec.mark(`hosthook:${tag}`)
    rec.React.useRef(null)
    rec.React.useMemo(() => 1, [getSnapshot()])
    rec.React.useSyncExternalStore(() => () => {}, getSnapshot)
    rec.React.useEffect(() => {})
    const snap = getSnapshot()
    const key = String(selector)
    const hit = cache.get(key)
    if (hit && Object.is(hit.snap, snap)) return hit.value
    const value = selector(snap)
    cache.set(key, { snap, value })
    return value
  }
}

function loadClient(React) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const dom = makeDomStub()
  let registered = null
  dom.window.__ModuleLoader__ = { load: (mod) => { registered = mod } }
  const quietConsole = { log() {}, info() {}, warn() {}, error() {} }
  const factory = new Function('window', 'document', 'navigator', 'localStorage', 'console', src)
  factory(dom.window, dom.document, dom.navigator, makeLocalStorage(), quietConsole)
  assert.ok(registered, 'client.js must register itself via window.__ModuleLoader__.load')
  const requireStub = (id) => {
    if (id === 'react') return React
    throw new Error(`client.js must not require "${id}"`)
  }
  return registered.factory(requireStub)
}

const CHAT_LOADED = {
  legacy: { nodes: [
    { kind: 'user', content: ['fallback-question'], time: 1 },
    { kind: 'assistant', content: ['## fallback-heading'], time: 2 },
  ] },
}

function makeProps(rec, { chatSnapshot, withUseChat }) {
  const sessionsSnapshot = { current: 's1' }
  return {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ pinned: true, left: null, top: null, view: 'panel', rail: true }),
      set: () => {},
    },
    sessionId: 's1',
    useChat: withUseChat ? makeHostSelectorHook(rec, 'useChat', () => chatSnapshot) : undefined,
    useSessions: makeHostSelectorHook(rec, 'useSessions', () => sessionsSnapshot),
    sessions: { binding: () => ({ session: { getSnapshot: () => chatSnapshot } }) },
  }
}

/** 渲染两轮（同 props），返回两轮的 hook 调用序列。 */
function renderTwice(Inner, props, rec) {
  rec.resetRender()
  Inner(props)
  const first = [...rec.marks]
  rec.resetRender()
  Inner(props)
  const second = [...rec.marks]
  return { first, second }
}

test('hook sequence is identical across renders while session data is absent (rules-of-hooks regression)', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  assert.equal(typeof api.internals.HistoryOutlinePanelInner, 'function',
    'internals must export HistoryOutlinePanelInner for hook-order tests')
  const Inner = api.internals.HistoryOutlinePanelInner
  const { first, second } = renderTwice(Inner, makeProps(rec, { chatSnapshot: undefined, withUseChat: true }), rec)
  assert.ok(first.some((m) => m.startsWith('hosthook:useSessions')),
    'fallback hook must actually run on the mount render (guards a vacuous pass)')
  assert.deepEqual(second, first,
    'the second render must call the exact same hooks in the same order as the mount render')
})

test('hook sequence is identical across renders with loaded session data', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const Inner = api.internals.HistoryOutlinePanelInner
  const { first, second } = renderTwice(Inner, makeProps(rec, { chatSnapshot: CHAT_LOADED, withUseChat: true }), rec)
  assert.ok(first.some((m) => m.startsWith('hosthook:useChat')), 'primary hook must run')
  assert.deepEqual(second, first)
})

/** 从迷你渲染器产出的元素树里收集全部文本。 */
function collectText(node, out) {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out }
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

test('fallback outline renders via useSessions when useChat is absent, and stays empty when data is absent', () => {
  const rec = makeRecordingReact()
  const api = loadClient(rec.React)
  const Inner = api.internals.HistoryOutlinePanelInner

  // 正向：useChat 缺席时，回退路径仍要把当前会话的大纲渲染出来。
  rec.resetRender()
  const loadedTree = Inner(makeProps(rec, { chatSnapshot: CHAT_LOADED, withUseChat: false }))
  const loadedText = collectText(loadedTree, []).join('\n')
  assert.ok(loadedText.includes('fallback-question'),
    'the user question must appear in the panel through the useSessions fallback')
  assert.ok(loadedText.includes('fallback-heading'), 'assistant headings must appear too')

  // 反向：数据缺席时渲染空态，而不是把上一会话的内容带出来。
  const rec2 = makeRecordingReact()
  const api2 = loadClient(rec2.React)
  rec2.resetRender()
  const emptyTree = api2.internals.HistoryOutlinePanelInner(makeProps(rec2, { chatSnapshot: undefined, withUseChat: false }))
  const emptyText = collectText(emptyTree, []).join('\n')
  assert.ok(emptyText.includes('No outline yet'), 'the empty state must render')
  assert.ok(!emptyText.includes('fallback-question'), 'no stale outline rows may render while data is absent')
})
