// test/preview-flash.test.js — 「hover 预览闪 ~45ms 就消失」回归（issue #4 重开）。
//
// 事故：v1.5.4 为「正文滚动后预览留在旧位置」加了滚动清预览，却把它放进 effect
// 挂载时的立即调用里。而 getState() 当时每次调用都新造对象，依赖 state 的 effect
// 便每轮渲染都重跑 —— 任何本地重渲染（hover 自己、搜索输入、透明度拖动）都会在
// 下一帧把刚出现的预览清掉。实测插入后 ~45ms 即被移出 DOM，指针停在行内也不再
// 复活。本文件锁住修复的三件事：
//   1) getState() 在同一次变更周期内返回同一引用（effect 不再每轮重跑）；
//   2) effect 挂载时的立即调用只同步阅读位置，不清预览；
//   3) 清预览只能发生在 scrollTop 真实变化之后（真滚动才清，合成事件不清）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

function loadSandbox() {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout,
    innerWidth: 1200,
    innerHeight: 800,
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { appendChild() {} },
      body: { appendChild() {} },
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} }),
      addEventListener() {}, removeEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  sandbox.window = sandbox
  sandbox.window.__ModuleLoader__ = { load: (definition) => { sandbox.__definition = definition } }
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox)
  sandbox.__module = sandbox.__definition.factory((id) => {
    if (id === 'react') {
      return {
        Component: class { constructor(props) { this.props = props; this.state = {} } setState() {} },
        Fragment: 'Fragment',
        createElement: (type, props) => ({ type, props: props || {} }),
        useMemo: (fn) => fn(), useState: (v) => [v, () => {}], useCallback: (fn) => fn,
        useEffect: () => {}, useLayoutEffect: () => {},
        useRef: (v) => ({ current: v }),
        useReducer: (r, i) => [r(undefined, i), () => {}],
        useSyncExternalStore: (_s, g) => g(),
      }
    }
    throw new Error(`client.js must not require "${id}"`)
  })
  return sandbox
}

function makeManager(options) {
  return new (loadSandbox().__module.internals.OutlineManager)(options)
}

/** 摘出「阅读位置跟随」那一个 effect 的源码文本（测试断言用，别在运行时路径上省行号）。 */
function effectSource() {
  const start = SRC.indexOf('const [, bumpActive] = useReducer((x) => x + 1, 0);')
  const end = SRC.indexOf('}, [state, currentId]);', start)
  assert.ok(start >= 0 && end > start, '阅读位置 effect 必须存在且以 [state, currentId] 收尾')
  return SRC.slice(start, end)
}

// ── A. 快照缓存：同一次变更周期内同一引用 ─────────────────────────────────

test('OutlineManager 经 internals 暴露（本组单测的前置）', () => {
  const { OutlineManager } = loadSandbox().__module.internals
  assert.equal(typeof OutlineManager, 'function')
})

test('getState() 连续调用返回同一引用（effect 依赖靠它保持稳定）', () => {
  const m = makeManager({})
  assert.equal(m.getState(), m.getState())
})

test('任何真实变更（notify）后引用必须换新，依赖方才能感知数据变化', () => {
  const m = makeManager({})
  m.setItems([{ level: 0, text: 'Q1', isUserQuery: true, userIndex: 0 }])
  const first = m.getState()
  m.setLevel(3)
  assert.notEqual(m.getState(), first, 'setLevel 要换快照')
  m.setBookmarkMode(true)
  assert.notEqual(m.getState(), first, 'setBookmarkMode 要换快照')
  m.setSearchQuery('Q')
  assert.notEqual(m.getState(), first, 'setSearchQuery 要换快照')
})

test('setItems 等值短路时不换引用（没有变化就不该惊动依赖方）', () => {
  const m = makeManager({})
  const items = [{ level: 0, text: 'Q1', isUserQuery: true, userIndex: 0 }]
  m.setItems(items)
  const before = m.getState()
  m.setItems(items.map((x) => ({ ...x })))
  assert.equal(m.getState(), before)
})

test('revealNode 落空也要失效缓存（clearForceVisible 动了树但不 notify）', () => {
  const m = makeManager({})
  m.setItems([{ level: 0, text: 'Q1', isUserQuery: true, userIndex: 0 },
    { level: 1, text: 'H1', userIndex: 0 }])
  m.setLevel(0)
  const before = m.getState()
  m.revealNode(-1)
  assert.notEqual(m.getState(), before, '落空的 revealNode 不该留下旧快照')
})

// ── B. effect 结构：立即调用只同步，清预览必须先看 scrollTop ─────────────

test('effect 挂载时的立即调用是 syncActive()，不是 onScroll()', () => {
  const block = effectSource()
  assert.match(
    block,
    /addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\);\s*\n\s*syncActive\(\);/,
    '立即调用只许做阅读位置同步',
  )
  assert.doesNotMatch(
    block,
    /addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\);\s*\n\s*onScroll\(\)/,
    '立即调用 onScroll() 就是 45ms 闪退本身',
  )
})

test('effect 内清预览必须先比对 scrollTop（真滚动才清）', () => {
  const block = effectSource()
  const clears = [...block.matchAll(/setPreviewNode\(null\)/g)]
  assert.equal(clears.length, 1, 'effect 内只允许一处清预览（Enter/Escape 的在别的 effect）')
  const guard = block.indexOf('top !== lastScrollTopRef.current')
  assert.ok(guard >= 0, '必须存在 scrollTop 真实变化守卫')
  assert.ok(guard < clears[0].index, '清预览必须发生在守卫判断之后')
})

test('scrollTop 基准存 ref（跨 effect 重跑保留，否则每次重跑丢基准漏清一次）', () => {
  assert.match(SRC, /const lastScrollTopRef = useRef\(null\)/)
})

// ── C. 其他清预览路径仍在（滚动之外的三条不许被顺手删掉）──────────────────

test('mouseleave、Enter 跳转、Escape 三条清预览路径保持存在', () => {
  assert.match(SRC, /onMouseLeave: \(\) => \{[\s\S]*?previewSetter\(null\)/, '鼠标移出要清')
  assert.match(SRC, /e\.key === "Enter" && previewNode !== null[\s\S]*?setPreviewNode\(null\)/, '回车跳转后要清')
  assert.match(SRC, /previewNode !== null[\s\S]*?e\.key === "Escape"[\s\S]*?setPreviewNode\(null\)/, 'Escape 要清')
})
