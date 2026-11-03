// test/glass.test.js — 面板「玻璃层」的结构回归（issue #4 A）。
//
// 事故：1.4.0 给 .dsh-conv-panel 本体加了 backdrop-filter，按 CSS 规范它会成为
// fixed 后代的包含块，于是面板内 position: fixed 的 .dsh-conv-preview 改成
// 相对面板原点定位，再被面板的 overflow: hidden 裁掉 —— hover 预览整个看不见。
//
// 这类回归没法靠"渲染元素树"发现（元素树是对的，错的是 CSS 层叠/包含块语义），
// 所以这里直接断言 CSS 文本结构：模糊只能在 ::before 上，面板本体不能有。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

/** 取出某条 CSS 规则的声明块正文（本项目 CSS 里没有嵌套规则，取到第一个行首右括号即止）。
 *  注释会被剥掉：面板那段注释本身就在解释 backdrop-filter，断言不能把它当成声明。 */
function cssRule(selector) {
  const needle = selector + ' {'
  const at = SRC.indexOf(needle)
  assert.ok(at >= 0, `CSS 规则 ${selector} 必须存在`)
  const end = SRC.indexOf('\n      }', at)
  assert.ok(end > at, `CSS 规则 ${selector} 必须有闭合括号`)
  return SRC.slice(at + needle.length, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

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

const internals = loadSandbox().__module.internals

/** 跨 vm 边界返回的对象原型不同，deepEqual 会判不等，这里摊平成普通对象再比。 */
function place(x, y, vw, vh) {
  const spot = internals.previewPlacement(x, y, vw, vh)
  return { left: spot.left, top: spot.top }
}

// ── A. backdrop-filter 不许回到面板本体上 ──────────────────────────────

test('面板本体不带 backdrop-filter（否则 fixed 预览浮层会改按面板定位并被裁掉）', () => {
  const panel = cssRule('.dsh-conv-panel')
  assert.doesNotMatch(panel, /backdrop-filter/, 'backdrop-filter 必须留在 ::before 上')
  assert.match(panel, /overflow:\s*hidden/, '面板仍要裁剪内部内容（滚动列表、圆角）')
})

test('模糊与底色由 ::before 承担，且铺满整块面板', () => {
  const glass = cssRule('.dsh-conv-panel::before')
  assert.match(glass, /position:\s*absolute/)
  assert.match(glass, /inset:\s*0/)
  assert.match(glass, /border-radius:\s*inherit/)
  assert.match(glass, /background:\s*color-mix\(/, '半透明底色跟着滑杆走')
  assert.match(glass, /backdrop-filter:\s*blur\(/)
  assert.match(glass, /-webkit-backdrop-filter:\s*blur\(/, 'WebView 仍需 -webkit- 前缀')
  assert.match(glass, /pointer-events:\s*none/)
  assert.match(glass, /z-index:\s*-1/, '玻璃层要压在内容之下')
})

test('面板本体背景透明，否则会把 ::before 的模糊挡在后面', () => {
  const panel = cssRule('.dsh-conv-panel')
  const declared = [...panel.matchAll(/(?:^|\n)\s*background:\s*([^;]+);/g)].map((m) => m[1].trim())
  assert.deepEqual(declared, ['transparent'], `面板本体只应声明 background: transparent，实际声明了 ${JSON.stringify(declared)}`)
})

test('预览浮层仍是 fixed 且压在面板之上', () => {
  const preview = cssRule('.dsh-conv-preview')
  assert.match(preview, /position:\s*fixed/)
  const previewZ = Number((preview.match(/z-index:\s*(-?\d+)/) || [])[1])
  const panelZ = Number((cssRule('.dsh-conv-panel').match(/z-index:\s*(-?\d+)/) || [])[1])
  assert.ok(previewZ > panelZ, `preview z-index ${previewZ} 必须高于面板 ${panelZ}`)
})

// ── B. 预览浮层的落点按视口夹回 ───────────────────────────────────────

test('宽窗口：贴着悬停行右下角', () => {
  assert.deepEqual(place(400, 300, 1440, 900), { left: 420, top: 320 })
})

test('窄窗口：不再算出负的 left（原来的 innerWidth - 380）', () => {
  const spot = place(30, 300, 400, 800)
  assert.ok(spot.left >= 8, `left 必须留在视口内，实际 ${spot.left}`)
  assert.equal(spot.left, 50, '右侧放得下时仍贴着行 + 20px 间距')
  assert.ok(spot.left + 340 <= 400, '浮层不越出视口右沿')
})

test('极窄视口：夹到左边距，不越界', () => {
  const spot = place(10, 20, 320, 640)
  assert.deepEqual(spot, { left: 8, top: 40 })
})

test('靠近底部时上移，浮层不越出视口下沿', () => {
  const spot = place(400, 880, 1440, 900)
  assert.equal(spot.top, 900 - 240 - 8)
  assert.ok(spot.left >= 8)
})

test('视口未知（非浏览器 / 单测）时只做原始偏移，不瞎猜', () => {
  assert.deepEqual(place(400, 300, 0, 0), { left: 420, top: 320 })
})

test('脏坐标当作 0 处理', () => {
  assert.deepEqual(place(undefined, NaN, 0, 0), { left: 20, top: 20 })
})

// ── C. 滑杆文案与真实语义一致（issue #4 B）──────────────────────────────

test('滑杆标签与 tooltip 都说明「调的是背景不透明度」', () => {
  const zhLabel = SRC.match(/"appearance\.opacity":\s*"([^"]+)"/)[1]
  assert.match(zhLabel, /背景/, `中文标签要写明是背景，实际「${zhLabel}」`)

  const zhTip = SRC.match(/"appearance\.opacityTooltip":\s*"([^"]+)"/)[1]
  assert.match(zhTip, /背景/, 'tooltip 要说明只看背景')
  assert.match(zhTip, /40–100%|40-100%/, 'tooltip 要给出取值范围')
  assert.match(zhTip, /模糊/, 'tooltip 要交代模糊是跟着反向变化的')
  assert.match(zhTip, /文字/, 'tooltip 要说明文字不受影响')
})

test('英文文案与中文同口径（都点名 background + 范围 + 模糊）', () => {
  const enLabel = SRC.match(/"appearance\.opacity":\s*"([^"]+)"/g).pop()
  assert.match(enLabel, /Background/i)

  const enTip = SRC.match(/"appearance\.opacityTooltip":\s*"([^"]+)"/g).pop()
  assert.match(enTip, /background/i)
  assert.match(enTip, /40–100%|40-100%/)
  assert.match(enTip, /blur/i)
  assert.match(enTip, /text/i)
})

test('中英文案都不再叫「面板透明度」（会让人以为在调模糊）', () => {
  assert.doesNotMatch(SRC, /"appearance\.opacity":\s*"面板透明度"/)
  assert.doesNotMatch(SRC, /"appearance\.opacity":\s*"Panel opacity"/)
})
