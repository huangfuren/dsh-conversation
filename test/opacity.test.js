// test/opacity.test.js — 面板不透明度控件的行为回归。
//
// client.js 是 dsh 加载器格式，且 chrome store 在 apply() 里读 localStorage 实例化，
// 所以每个用例都要新建一次模块实例（沙箱），再真实调用槽位组件、检查渲染出的元素树。
// 断言的是三件容易在重构中丢掉的事：滑杆在、CSS 变量跟着值走、老快照缺字段时不改变观感。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

const CHROME_KEY = 'dsh-conversation:panel'
const MIN = 40
const MAX = 100
const STEP = 5

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }

  setState(patch) {
    this.state = Object.assign({}, this.state, patch)
  }
}

/** 桩 React：函数组件直接求值，类组件实例化后取 render()，其余原样返回元素描述。 */
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

const SESSION = {
  current: 's1',
  hasMore: false,
  loadingOlder: false,
  nodes: [
    { id: 'n1', role: 'user', text: '第一条提问', children: [] },
    { id: 'n2', role: 'assistant', text: '## 小节\n回答', children: [] },
  ],
}

function noopElement() {
  return {
    style: {}, dataset: {},
    appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
  }
}

/**
 * 用给定的 chrome 快照渲染一次展开态面板，返回元素树。
 * 传 undefined 表示"老用户的快照里根本没有这个字段"。
 */
function renderPanel(chromePatch, options = {}) {
  const saved = {}
  for (const [key, value] of Object.entries(chromePatch)) {
    if (value !== undefined) saved[key] = value
  }
  const map = new Map([[CHROME_KEY, JSON.stringify(saved)]])

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
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
  // options.cssSupports 缺省时不放 CSS 全局，等价于"取不到能力探测"；显式给值则模拟宿主
  if (options.cssSupports !== undefined) {
    sandbox.CSS = { supports: () => options.cssSupports }
  }
  sandbox.window = sandbox
  sandbox.window.__ModuleLoader__ = { load: (definition) => { sandbox.__definition = definition } }
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox)

  const mod = sandbox.__definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`client.js must not require "${id}"`)
  })

  let entry = null
  mod.apply({
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

function parts(tree) {
  const nodes = flatten(tree)
  return {
    panel: nodes.find((n) => n.props && n.props.className === 'dsh-conv-panel'),
    slider: nodes.find((n) => n.type === 'input' && n.props && n.props.type === 'range'),
    readout: nodes.find((n) => n.type === 'button' && n.props && /dsh-conv-opacitylabel/.test(n.props.className || '')),
  }
}

test('透明度滑杆渲染在面板里，并与当前值对齐', () => {
  const { panel, slider, readout } = parts(renderPanel({ pinned: true, view: 'panel', opacity: 70 }))
  assert.ok(panel, 'panel must render')
  assert.ok(slider, 'opacity slider must render')
  assert.ok(readout, 'percentage readout must render')

  assert.equal(slider.props.value, 70)
  assert.equal(slider.props.min, MIN)
  assert.equal(slider.props.max, MAX)
  assert.equal(slider.props.step, STEP)
  assert.equal(readout.props.children, '70%')
  assert.match(readout.props['aria-label'], /70%/)
})

test('面板底色变量跟随滑杆值，且调暗时开启背景模糊', () => {
  const dim = parts(renderPanel({ pinned: true, view: 'panel', opacity: 55 }))
  assert.equal(dim.panel.props.style['--dsh-conv-bg-alpha'], '55%')
  assert.ok(parseFloat(dim.panel.props.style['--dsh-conv-bg-blur']) > 0, 'dimmed panel should blur what is behind it')

  const opaque = parts(renderPanel({ pinned: true, view: 'panel', opacity: MAX }))
  assert.equal(opaque.panel.props.style['--dsh-conv-bg-alpha'], '100%')
  assert.equal(parseFloat(opaque.panel.props.style['--dsh-conv-bg-blur']), 0, 'fully opaque panel must not blur')
})

test('老快照没有 opacity 字段时保持完全不透明', () => {
  // 1.3.2 之前的 chrome 快照里没有这个键，升级后不能突然变半透明
  const { slider, panel } = parts(renderPanel({ pinned: true, view: 'panel' }))
  assert.equal(slider.props.value, MAX)
  assert.equal(panel.props.style['--dsh-conv-bg-alpha'], '100%')
})

test('越界与脏值在渲染时被夹回合法档位', () => {
  for (const [saved, expected] of [[0, MIN], [-20, MIN], [240, MAX], [72, 70], [73, 75]]) {
    const { slider } = parts(renderPanel({ pinned: true, view: 'panel', opacity: saved }))
    assert.equal(slider.props.value, expected, `opacity ${saved} should render as ${expected}`)
  }
})

test('宿主不支持 color-mix 时不渲染这一行，避免"拖了没反应"', () => {
  // 老 Electron（Chromium < 111）上 color-mix 会被整行丢弃，滑杆就成了摆设
  const unsupported = parts(renderPanel({ pinned: true, view: 'panel', opacity: 70 }, { cssSupports: false }))
  assert.ok(unsupported.panel, 'panel itself must still render')
  assert.equal(unsupported.slider, undefined, 'opacity slider must be omitted when color-mix is unsupported')
  assert.equal(
    unsupported.panel.props.style['--dsh-conv-bg-alpha'],
    undefined,
    'no point injecting an alpha variable the engine will drop',
  )

  const supported = parts(renderPanel({ pinned: true, view: 'panel', opacity: 70 }, { cssSupports: true }))
  assert.ok(supported.slider, 'slider must render when the host supports color-mix')
  assert.equal(supported.panel.props.style['--dsh-conv-bg-alpha'], '70%')
})
