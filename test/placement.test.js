// test/placement.test.js — 换档（紧凑/加宽/全屏）时的横向生长方向回归。
//
// 约定（用户定的观感）：贴左向右长、贴右向左长、居中两侧对称。
// 断言两层：纯函数 resolveResizedLeft 的边界算术，以及按钮点击后
// 真正落到 localStorage 并按新坐标渲染的完整链路 —— 只测前者的话，
// store.set 忘了带 left 这种接线错误照不出来。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

const CHROME_KEY = 'dsh-conversation:panel'
const PANEL = 320
const WIDE = 480
const FULL = 720

const SESSION = {
  current: 's1',
  hasMore: false,
  loadingOlder: false,
  nodes: [
    { id: 'n1', role: 'user', text: '第一条提问', children: [] },
    { id: 'n2', role: 'assistant', text: '## 小节\n回答', children: [] },
  ],
}

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }

  setState(patch) {
    this.state = Object.assign({}, this.state, patch)
  }
}

function createElement(type, props, ...children) {
  const p = Object.assign({}, props)
  if (children.length === 1) p.children = children[0]
  else if (children.length > 1) p.children = children
  if (typeof type === 'function') {
    const isClass = /^class[\s{]/.test(Function.prototype.toString.call(type))
    if (isClass) {
      const inst = new type(p)
      return typeof inst.render === 'function' ? inst.render() : null
    }
    return type(p)
  }
  return { type, props: p }
}

const React = {
  Component,
  Fragment: 'Fragment',
  createElement,
  useMemo: (fn) => fn(),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useReducer: (reducer, initial) => [reducer(undefined, initial), () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

function noopElement() {
  return {
    style: {}, dataset: {},
    appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
  }
}

/**
 * 建一个模块沙箱。chrome 直接以已存在的 localStorage 内容传入，
 * 模拟「用户上次拖过 / 没拖过」两种起点。
 */
function createSandbox(chromePatch, options = {}) {
  const map = new Map([[CHROME_KEY, JSON.stringify(chromePatch)]])
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    innerWidth: options.innerWidth === undefined ? 1200 : options.innerWidth,
    innerHeight: options.innerHeight === undefined ? 800 : options.innerHeight,
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { appendChild() {} },
      body: { appendChild() {} },
      createElement: noopElement,
      addEventListener() {}, removeEventListener() {},
    },
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
    },
  }
  sandbox.window = sandbox
  sandbox.window.__ModuleLoader__ = { load: (definition) => { sandbox.__definition = definition } }
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox)
  const mod = sandbox.__definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`client.js must not require "${id}"`)
  })
  sandbox.__module = mod
  sandbox.__saved = () => JSON.parse(map.get(CHROME_KEY))
  return sandbox
}

function flatten(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  if (node.props) flatten(node.props.children, out)
  return out
}

/** 渲染一次展开态面板，返回元素树。 */
function renderPanel(sandbox) {
  let entry = null
  sandbox.__module.apply({
    slots: { register: (_options, component) => { entry = component }, inject: () => {} },
    sessions: {},
  })
  assert.ok(entry, 'slot entry must be registered')
  return entry({
    sessions: { binding: () => ({ session: { getSnapshot: () => SESSION, loadOlder: async () => {} } }) },
    useSessions: (selector) => selector(SESSION),
    sessionId: 's1',
    t: undefined,
  })
}

function panelOf(tree) {
  return flatten(tree).find(
    (n) => n.props && typeof n.props.className === 'string'
      && n.props.className.split(/\s+/).includes('dsh-conv-panel'),
  )
}

/** 标题栏里的换档按钮：文案随档位变化（加宽 / 全屏 / 回到紧凑），按三种之一匹配。 */
const VIEW_LABELS = ['加宽面板', '全屏展开', '紧凑宽度']
function viewButtonOf(tree) {
  return flatten(tree).find(
    (n) => n.type === 'button' && n.props && VIEW_LABELS.includes(n.props['aria-label']),
  )
}

const resize = (sandbox) => sandbox.__module.internals.resolveResizedLeft

test('贴右：右缘不动，向左长（不留白 16px 边距去压右侧栏）', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 864, top: 72 })
  const left = resize(sandbox)(864, PANEL, WIDE, 1200)
  assert.equal(left, 704)
  assert.equal(left + WIDE, 864 + PANEL, 'right edge must stay put')
})

test('拖拽后离右缘只剩 30px 也算贴右，不改成两侧撑开', () => {
  // 用户松手时的抖动不该被解读成「他要放在中间」
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 850, top: 72 })
  const left = resize(sandbox)(850, PANEL, WIDE, 1200)
  assert.equal(left + WIDE, 850 + PANEL)
})

test('贴左：左缘不动，向右长', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 16, top: 72 })
  assert.equal(resize(sandbox)(16, PANEL, WIDE, 1200), 16)
})

test('居中：中心不动，两侧各长一半', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 400, top: 72 })
  const left = resize(sandbox)(400, PANEL, WIDE, 1200)
  assert.equal(left, 320)
  assert.equal(left + WIDE / 2, 400 + PANEL / 2, 'center must stay put')
})

test('居中但左侧装不下：差额全部转给右侧，不是压回去只长一边', () => {
  // 左边只剩 100，加宽要 400 ⇒ 左扩 100（用尽），右扩 300（补齐剩余）
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 100, top: 72 })
  const left = resize(sandbox)(100, PANEL, FULL, 1200)
  assert.equal(left, 0, 'left side must be fully used, not half of it')
  assert.equal(left + FULL - (100 + PANEL), 300, 'right side must absorb the shortfall')
})

test('居中但右侧装不下：差额全部转给左侧', () => {
  // 右边只剩 180，加宽要 400 ⇒ 右扩 180（用尽），左扩 220（补齐剩余）
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 700, top: 72 })
  const left = resize(sandbox)(700, PANEL, FULL, 1200)
  assert.equal(left + FULL, 1200, 'right space must be used up exactly')
  assert.equal(left, 480)
})

test('两侧都装不下时贴住左缘，宁可右缘溢出也不出负坐标', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 200, top: 72 })
  const left = resize(sandbox)(200, PANEL, FULL, 700)
  assert.equal(left, 0)
})

test('连续加宽到全屏仍贴住原右缘，不越界', () => {
  const sandbox = createSandbox({ pinned: true, view: 'wide', left: 704, top: 72 })
  const left = resize(sandbox)(704, WIDE, FULL, 1200)
  assert.equal(left + FULL, 704 + WIDE, 'right edge must survive the second step')
  assert.ok(left >= 0)
})

test('已越界的坐标被夹回窗口内', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 1000, top: 72 })
  const left = resize(sandbox)(1000, PANEL, FULL, 1200)
  assert.equal(left, 480)
  assert.ok(left + FULL <= 1200, 'panel must not hang outside the viewport')
})

test('窗口比面板还窄时贴住左缘，不再出现负坐标', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 100, top: 72 })
  assert.equal(resize(sandbox)(100, PANEL, FULL, 600), 0)
})

test('没有拖拽坐标 / 窗口宽度未知时不改坐标', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel' })
  const fn = resize(sandbox)
  assert.equal(fn(null, PANEL, WIDE, 1200), null, 'docked panel keeps its left/right anchor')
  assert.equal(fn(undefined, PANEL, WIDE, 1200), null)
  assert.equal(fn(Number.NaN, PANEL, WIDE, 1200), null)
  assert.equal(fn(400, PANEL, WIDE, 0), 400, 'unknown viewport means keep as-is')
})

test('点击加宽按钮：拖拽态写入新 left，重新渲染后右缘不动', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 864, top: 72 }, { innerWidth: 1200 })
  const button = viewButtonOf(renderPanel(sandbox))
  assert.ok(button, 'widen button must render')

  button.props.onClick()
  const saved = sandbox.__saved()
  assert.equal(saved.view, 'wide')
  assert.equal(saved.left, 704)

  const panel = panelOf(renderPanel(sandbox))
  assert.equal(panel.props.style.left, 704)
  assert.equal(panel.props.style.width, WIDE)
  assert.equal(panel.props.style.right, undefined, 'dragged panel must not fall back to the right anchor')
})

test('点击加宽按钮：从未拖拽时沿用停靠锚点，不凭空生成 left', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel' }, { innerWidth: 1200 })
  const button = viewButtonOf(renderPanel(sandbox))
  assert.ok(button, 'widen button must render')

  button.props.onClick()
  const saved = sandbox.__saved()
  assert.equal(saved.view, 'wide')
  assert.equal(saved.left, null)

  const panel = panelOf(renderPanel(sandbox))
  assert.equal(panel.props.style.right, 16)
  assert.equal(panel.props.style.left, undefined)
  assert.equal(panel.props.style.width, WIDE)
})

test('三轮循环回到紧凑档，贴右面板不累积漂移', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 864, top: 72 }, { innerWidth: 1200 })
  const click = () => viewButtonOf(renderPanel(sandbox)).props.onClick()

  click()
  assert.equal(sandbox.__saved().left, 704)
  click()
  const full = sandbox.__saved()
  assert.equal(full.view, 'full')
  assert.equal(full.left + FULL, 864 + PANEL)

  click()
  const back = sandbox.__saved()
  assert.equal(back.view, 'panel')
  assert.equal(back.left, 864, 'returning to compact must restore the original left edge')
})

// ---- 视口钳制：窗口拉窄后，拖拽坐标可能整块落在视口外（面板"点了不出来"） ----

test('窗口变窄后越界的拖拽坐标被夹回视口内', () => {
  // 真实事故现场：left 存自更宽的窗口，现在视口只有 1080
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 1386, top: 140 }, { innerWidth: 1080, innerHeight: 681 })
  const clamp = sandbox.__module.internals.clampPlacementToViewport
  const out = clamp({ width: PANEL, height: 480, left: 1386, top: 140 }, 1080, 681)
  assert.equal(out.left, 760, 'panel right edge must sit on the viewport edge')
  assert.equal(out.top, 140, 'legal top must be left alone')
  assert.equal(clamp({ width: PANEL, height: 480, left: 1386, top: 140 }, 1080, 681).left + PANEL, 1080)
})

test('top 越界时只保证露出标题栏', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel', left: 100, top: 700 }, { innerWidth: 1080, innerHeight: 681 })
  const clamp = sandbox.__module.internals.clampPlacementToViewport
  const out = clamp({ width: PANEL, height: 480, left: 100, top: 700 }, 1080, 681)
  assert.equal(out.top, 601, '80px of the panel must stay reachable')
  assert.equal(clamp({ width: PANEL, height: 480, left: 100, top: 700 }, 1080, 681).top, 681 - 80)
})

test('停靠态（right 锚点）与合法坐标都不被改动', () => {
  const sandbox = createSandbox({ pinned: true, view: 'panel' })
  const clamp = sandbox.__module.internals.clampPlacementToViewport
  const docked = { width: PANEL, height: 480, right: 16, top: 72 }
  const keptDock = clamp(docked, 1080, 681)
  assert.equal(keptDock.right, 16)
  assert.equal(keptDock.left, undefined, 'docked placement has no left to clamp')

  const ok = clamp({ width: PANEL, height: 480, left: 400, top: 120 }, 1080, 681)
  assert.equal(ok.left, 400)
  assert.equal(ok.top, 120)
  assert.equal(ok.width, PANEL)

  // 视口未知（单测/非浏览器）时不做任何猜测
  assert.equal(clamp({ width: PANEL, height: 480, left: 1386, top: 140 }, 0, 0).left, 1386)
})

test('渲染时套用钳制：越界的持久化坐标不会让面板消失', () => {
  const sandbox = createSandbox(
    { pinned: true, view: 'panel', left: 1386, top: 140 },
    { innerWidth: 1080, innerHeight: 681 },
  )
  const panel = panelOf(renderPanel(sandbox))
  assert.equal(panel.props.style.left, 760)
  assert.equal(panel.props.style.width, PANEL)
  // 持久化值保持原样：窗口拉回去时位置还在原处
  assert.equal(sandbox.__saved().left, 1386)
})

test('全屏档窗口比面板还窄时贴住左缘', () => {
  const sandbox = createSandbox({ pinned: true, view: 'full', left: 800, top: 40 }, { innerWidth: 700, innerHeight: 600 })
  const panel = panelOf(renderPanel(sandbox))
  assert.equal(panel.props.style.left, 0)
  assert.equal(panel.props.style.width, FULL)
})

test('停靠态（right 锚点）在窗口比面板还窄时也折算成 left: 0', () => {
  const sandbox = createSandbox({ pinned: true, view: 'full' }, { innerWidth: 700, innerHeight: 600 })
  const clamp = sandbox.__module.internals.clampPlacementToViewport
  // 720 宽的全屏档 + 16 边距落进 700 的窗口：右锚点会把左缘顶到 -36
  const out = clamp({ width: FULL, height: 480, right: 16, top: 28 }, 700, 600)
  assert.equal(out.left, 0, '左缘不能为负')
  assert.equal(out.right, undefined, '既要 left 就不能同时留 right，否则左缘仍按右缘算')

  // 窗口够宽时仍然走右锚点（跟随右侧栏，窗口拉宽后不会被钉死在左边）
  const docked = clamp({ width: FULL, height: 480, right: 16, top: 28 }, 1080, 600)
  assert.equal(docked.right, 16)
  assert.equal(docked.left, undefined)
})
