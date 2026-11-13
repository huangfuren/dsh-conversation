// test/portal.test.js — 面板 portal 到 document.body 的回归（issue #5）。
//
// 事故：宿主 0.2.2-rc.1 给会话标题栏 .titleRow 声明 container-type: inline-size。
// 按 CSS 规范它隐含 layout containment —— 该元素成为所有 position: fixed 后代的
// 包含块，并建立层叠上下文。面板此前作为 fixed 元素直接渲染在
// conversation.session.header.actions 槽位里（header > .titleRow > .headerActions >
// 槽位 > 面板），fixed 定位从「相对视口」退化为「相对标题栏」，面板被钉在标题栏
// 区域，z-index: 1000 只在标题栏层内生效，标题栏以下被会话正文层盖住。
//
// 和 glass.test.js 同理：元素树是对的（面板确实被渲染了），错的是 CSS 包含块
// 语义，所以这里两条腿走路：
//   A. 渲染结构：面板走 createPortal(…, document.body)，按钮留在槽位；
//   B. CSS 结构：面板与预览浮层必须保持 fixed（portal 之后相对视口定位）。
// 复现: node --test test/portal.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client.js')
const src0 = fs.readFileSync(CLIENT, 'utf8').replace(/\r\n/g, '\n')

/** 取出某条 CSS 规则的声明块正文（剥掉注释）。 */
function cssRule(selector) {
  const needle = selector + ' {'
  const at = src0.indexOf(needle)
  assert.ok(at >= 0, `CSS 规则 ${selector} 必须存在`)
  const end = src0.indexOf('\n      }', at)
  assert.ok(end > at, `CSS 规则 ${selector} 必须有闭合括号`)
  return src0.slice(at + needle.length, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

function makeLocalStorage() {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), clear: () => map.clear() }
}

function makeDomStub(bodyNode) {
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollTo() {}, focus() {}, contains: () => false, textContent: '', dataset: {},
  })
  return {
    window: {
      innerWidth: 1440, innerHeight: 900,
      getComputedStyle: () => ({ position: 'static', columnGap: '0px', gap: '0px', marginLeft: '0px' }),
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {}, removeEventListener() {},
      requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: () => {},
      setTimeout, clearTimeout, setInterval, clearInterval,
    },
    document: {
      body: bodyNode === undefined ? el() : bodyNode, head: el(), documentElement: el(),
      querySelector: () => null, querySelectorAll: () => [],
      createElement: el, createTextNode: () => ({}),
      addEventListener() {}, removeEventListener() {},
    },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  }
}

/** React 树桩：createElement 保留完整元素树（渲染形态断言用）。
 *  Component 是 client.js 里 PanelBoundary 的基类；这里只要存在即可。 */
class Component {
  constructor(props) { this.props = props || {}; this.state = {} }
  setState(next) { this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state, this.props) : next) }
  render() { return null }
}
const reactTree = {
  Component,
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.length <= 1 ? (children[0] ?? null) : children }
  },
  Fragment: Symbol('dsh-conv-portal-fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useReducer: (_r, init) => [init, () => {}],
  useSyncExternalStore: (_s, get) => get(),
}

/** createPortal 探针：记录调用并返回可识别的 portal 元素。 */
function fakePortalApi() {
  const calls = []
  const api = {
    createPortal(children, container, key) {
      calls.push({ children, container, key })
      return { $$portal: true, children, container, key }
    },
  }
  api.calls = calls
  return api
}

/** 加载 client.js。reactDom 传 undefined ⇒ require("react-dom") 抛错（宿主未注入）；
 *  传实现 ⇒ 正常返回。bodyNode 透传给 document.body。 */
function loadClient({ reactDom, bodyNode } = {}) {
  const dom = makeDomStub(bodyNode)
  let registered = null
  dom.window.__ModuleLoader__ = { load: (mod) => { registered = mod } }
  const quietConsole = { log() {}, info() {}, warn() {}, error() {} }
  const factory = new Function('window', 'document', 'navigator', 'localStorage', 'console', src0)
  factory(dom.window, dom.document, dom.navigator, makeLocalStorage(), quietConsole)
  assert.ok(registered, 'client.js must register itself via window.__ModuleLoader__.load')
  const requireStub = (id) => {
    if (id === 'react') return reactTree
    if (id === 'react-dom') {
      if (reactDom === undefined) throw new Error(`client.js must not require "${id}"`)
      return reactDom
    }
    throw new Error(`client.js must not require "${id}"`)
  }
  const mod = registered.factory(requireStub)
  return { mod, document: dom.document }
}

/** 沿元素树找第一个满足谓词的节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (predicate(node)) return node
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  for (const kid of kids) {
    const hit = findNode(kid, predicate)
    if (hit !== null) return hit
  }
  return null
}

const SLOT_STORE = {
  subscribe() { return () => {} },
  getSnapshot: () => ({ pinned: true, opacity: 1, blur: 0 }),
  set() {},
}

/** pinned 由快照控制；host 缺席 ⇒ useHostReadiness.available=false ⇒ panelMountStateOf 恒 "mount"。 */
function renderSlot(internals, pinned = true) {
  const store = pinned ? SLOT_STORE : { ...SLOT_STORE, getSnapshot: () => ({ pinned: false, opacity: 1, blur: 0 }) }
  return internals.HistoryOutlineSlot({
    store,
    t: (k) => k,
    host: undefined,
  })
}

// ── A. 渲染结构：面板走 portal，按钮留在槽位 ──────────────────────────

test('宿主提供 react-dom：面板包在 createPortal(…, document.body) 里，key=conv-panel-portal', () => {
  const api = fakePortalApi()
  const { mod, document } = loadClient({ reactDom: api })
  const tree = renderSlot(mod.internals, true)

  const portal = findNode(tree, (n) => n && n.$$portal === true)
  assert.ok(portal, '渲染树里必须出现 portal 元素')
  assert.equal(api.calls.length, 1, 'createPortal 恰好调一次（面板/占位互斥，同一位）')
  assert.equal(api.calls[0].container, document.body, 'portal 容器必须是 document.body')
  assert.equal(api.calls[0].key, 'conv-panel-portal')

  // portal 的孩子是 PanelBoundary 包着的面板（错误边界不丢）。
  // PanelBoundary 自带 render（遮蔽基类），用错误边界标记 componentDidCatch 识别。
  const inner = findNode(portal.children, (n) => n && typeof n.type === 'function'
    && n.type.prototype && typeof n.type.prototype.componentDidCatch === 'function')
  assert.ok(inner, 'portal 内层必须是 PanelBoundary（class 组件）包裹的面板')
})

test('按钮是 Fragment 的直接孩子，不在 portal 里（titleRow 容器查询依赖它留在槽位）', () => {
  const api = fakePortalApi()
  const { mod } = loadClient({ reactDom: api })
  const tree = renderSlot(mod.internals, true)

  const btn = findNode(tree, (n) => n && n.type === 'button')
  assert.ok(btn, '按钮必须渲染')
  assert.ok(String(btn.props.className || '').includes('dsh-conv-header-btn'), '按钮类名不变')

  // 按钮与 portal 是同级兄弟：portal 元素的孩子链里不得出现按钮
  const portal = findNode(tree, (n) => n && n.$$portal === true)
  const btnInsidePortal = portal ? findNode(portal.children, (n) => n && n.type === 'button') : null
  assert.equal(btnInsidePortal, null, '按钮必须留在槽位内，不随面板 portal')
})

test('pinned=false：只渲染按钮，不出现 portal', () => {
  const api = fakePortalApi()
  const { mod } = loadClient({ reactDom: api })
  const tree = renderSlot(mod.internals, false)

  const portal = findNode(tree, (n) => n && n.$$portal === true)
  assert.equal(portal, null, '收起态不得 portal 面板')
  const btn = findNode(tree, (n) => n && n.type === 'button')
  assert.ok(btn, '收起态按钮仍在')
})

test('面板与首屏占位共用同一个 portal 调用位（panelElement 单点出槽）', () => {
  // 结构断言：panelElement 的两个分支（PanelBoundary 面板 / HistoryOutlinePlaceholder
  // 占位）都汇入同一个 withBodyPortal 调用 —— 占位与面板同壳同位，portals 必须同位。
  const m = src0.match(/const panelElement = mountPanel\s*\?[\s\S]*?:[\s\S]*?;\s*\n/)
  assert.ok(m, 'panelElement 必须集中定义（面板 + 占位两分支）')
  assert.ok(m[0].includes('HistoryOutlinePanelInner'), '分支 1 是面板')
  assert.ok(m[0].includes('HistoryOutlinePlaceholder'), '分支 2 是首屏占位')
  assert.match(src0, /withBodyPortal\(panelElement, "conv-panel-portal"\)/,
    '槽位里只留按钮，浮层经 withBodyPortal 出槽')
})

// ── B. 降级路径：宿主不给 react-dom 时回退槽位内渲染 ──────────────────

test('宿主不提供 react-dom：withBodyPortal 原样返回元素，不抛错', () => {
  const { mod } = loadClient({ reactDom: undefined })
  const el = { type: 'div' }
  assert.equal(mod.internals.withBodyPortal(el, 'k'), el, '必须原样返回（与 1.5.7 行为一致）')
})

test('降级渲染：面板元素直接留在槽位（旧宿主上的正确位置）', () => {
  const { mod } = loadClient({ reactDom: undefined })
  const tree = renderSlot(mod.internals, true)
  const portal = findNode(tree, (n) => n && n.$$portal === true)
  assert.equal(portal, null, '不得 portal')
  const inner = findNode(tree, (n) => n && typeof n.type === 'function'
    && n.type.prototype && typeof n.type.prototype.componentDidCatch === 'function')
  assert.ok(inner, '面板仍渲染在槽位内')
})

test('setPortalApi(null / 缺 createPortal 的对象) ⇒ withBodyPortal 原样返回', () => {
  const { mod } = loadClient({ reactDom: fakePortalApi() })
  const el = { type: 'div' }
  mod.internals.setPortalApi(null)
  assert.equal(mod.internals.withBodyPortal(el, 'k'), el)
  mod.internals.setPortalApi({ noCreatePortal: true })
  assert.equal(mod.internals.withBodyPortal(el, 'k'), el)
})

test('document.body 缺失（非浏览器环境）时不 portal', () => {
  const api = fakePortalApi()
  const { mod } = loadClient({ reactDom: api, bodyNode: null })
  const el = { type: 'div' }
  assert.equal(mod.internals.withBodyPortal(el, 'k'), el)
})

test('createPortal 自身抛错时不炸面板，原样返回元素', () => {
  const api = fakePortalApi()
  api.createPortal = () => { throw new Error('boom') }
  const { mod } = loadClient({ reactDom: api })
  const el = { type: 'div' }
  assert.equal(mod.internals.withBodyPortal(el, 'k'), el)
})

// ── C. CSS 结构：面板与预览浮层保持 fixed（portal 后相对视口定位）──────

test('面板本体保持 position: fixed + z-index: 1000', () => {
  const panel = cssRule('.dsh-conv-panel')
  assert.match(panel, /position:\s*fixed/)
  assert.match(panel, /z-index:\s*1000/)
})

test('预览浮层仍是 fixed（面板 portal 后它相对视口定位不被裁）', () => {
  assert.match(cssRule('.dsh-conv-preview'), /position:\s*fixed/)
})

test('client.js 只允许 require react 与 react-dom（新增依赖必须过评审）', () => {
  const ids = [...src0.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(ids)].sort(), ['react', 'react-dom'])
})
