// test/icon-only.test.js — 标题栏按钮 icon-only（2026-11-01 PR#2 适配点 2·第3版，照抄宿主原生机制）。
//
// 现象：右侧边栏展开 ⇒ 标题栏变窄 ⇒ 宿主原生按钮收成图标，本插件按钮仍「svg + 文字」整块 ⇒ 重叠。
// 第 1/2 版失败根因：自造"测量父容器宽度"判定 —— 直接父容器 headerActions 被内容撑出
// （现场 270 == 子项合计），恒"放得下" ⇒ 永不触发。
//
// 第 3 版 = **复用宿主原生机制**（取证见两处宿主源码，只读）：
//   ① 容器：dsh-client-ui-conversation/lib/client.js 的 .wSkVaW_titleRow 声明
//      `container-type: inline-size` —— 本按钮是该容器的后代；
//   ② 条件：dsh-client-ui-agent-preset/lib/client.js 的原生 label 规则
//      `@container (width<=540px){.SVAs4q_label{display:none}}` —— 纯 CSS，无 JS 测宽。
//   本插件注入同一条件的容器查询，命中同一容器（titleRow）⇒ 与原生按钮同帧收起/还原。
//   span 保持挂载（与原生 label 同款 display:none 处理）；aria-label/title 在按钮上不受影响；
//   按钮随 span 隐藏**真实收窄**为 glyph 固有宽 + padding。宿主无该容器（旧版）⇒ 查询不命中
//   ⇒ 保持宽态（降级安全，与原生行为一致）。
//
// 契约：
//   R1 渲染恒定：svg + 文本 span + aria-label/title/type=button/onClick —— 显隐由样式表承担，
//      DOM 不随容器宽度变化（样式表缺失 ⇒ 保持宽态，天然降级）；
//   W  真实收窄（宽度由**解析产物 CSS**驱动的布局模拟计算，防循环自证）：
//      titleRow ≤ 阈值 ⇒ span display:none ⇒ 按钮宽 < 全宽 ×60%；titleRow > 阈值 ⇒ 全宽；
//   N  来源一致：产物 CSS 的容器查询条件（归一化后）与宿主原生 label 的条件逐字符相同；
//   S  选择器对位：规则的目标类与 JSX 里 span 的 className 逐字符相同（防类名漂移失配）。
// 变异自证（隔离副本；期望红集 == 实际红集，逐条相等）：
//   M1-nohide   规则删掉 display:none ⇒ 窄态不再收窄 ⇒ W 窄态红
//   M2-always   拆掉 @container 条件（规则恒生效）⇒ 宽态被误收 ⇒ W 宽态红
// 复现: node --test test/icon-only.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client.js')

/** 宿主原生事实（取证记录；改动请同步 docs/reports）：
 *  - 容器：`.wSkVaW_titleRow{...container-type:inline-size}`（dsh-client-ui-conversation）；
 *  - 原生 label 收起条件（dsh-client-ui-agent-preset）：
 *    `@container (width<=540px){.SVAs4q_label{display:none}}`。 */
const NATIVE_CONDITION = '(width<=540px)'
const GLYPH_W = 18
const GAP_W = 4
const TEXT_W = 83   // 「历史提问 · 大纲」文本自然宽（现场全宽按钮 121 = 18+4+83+16）
const BTN_PAD = 16
const FULL_W = GLYPH_W + GAP_W + TEXT_W + BTN_PAD

function makeLocalStorage() {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), clear: () => map.clear() }
}

function makeDomStub() {
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
      body: el(), head: el(), documentElement: el(),
      querySelector: () => null, querySelectorAll: () => [],
      createElement: el, createTextNode: () => ({}),
      addEventListener() {}, removeEventListener() {},
    },
    navigator: { language: 'en-US', languages: ['en-US'] },
  }
}

/** React 树桩：createElement 保留完整元素树（渲染形态断言用）。 */
const reactTree = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.length <= 1 ? (children[0] ?? null) : children }
  },
  Fragment: Symbol('dsh-conv-icon-fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useReducer: (_r, init) => [init, () => {}],
  useSyncExternalStore: (_s, get) => get(),
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

const api = loadClient(reactTree)
const src0 = fs.readFileSync(CLIENT, 'utf8')

const zhTitle = '历史提问 · 大纲'
const zhCollapse = '收起面板'
const t = (k) => (k === 'panel.title' ? zhTitle : k === 'panel.collapse' ? zhCollapse : k)

/** 从产物源码解析容器查询规则（阈值 + display 值 + 目标选择器）。 */
function parseContainerRule(src) {
  const m = /@container\s*\(width\s*<=\s*(\d+)px\)\s*\{\s*\.dsh-conv-header-btn \.dsh-conv-header-btn-text\s*\{\s*display:\s*(\w+);?\s*\}\s*\}/.exec(src)
  if (!m) return null
  return { threshold: Number(m[1]), display: m[2], selector: '.dsh-conv-header-btn .dsh-conv-header-btn-text' }
}
const normCond = (s) => String(s).replace(/\s+/g, '')

test('N source parity: our container-query condition matches the native label rule character-for-character', () => {
  const rule = parseContainerRule(src0)
  assert.ok(rule, 'the @container rule for .dsh-conv-header-btn-text must exist in the injected CSS')
  assert.equal(normCond(`(width <= ${rule.threshold}px)`), normCond(NATIVE_CONDITION),
    'threshold must equal the native agent-preset label threshold (540px, same container .wSkVaW_titleRow)')
  assert.equal(rule.display, 'none', 'the narrow-state declaration must be display:none (native-faithful)')
})

test('S selector alignment: rule target class == the span className rendered by the button', () => {
  const rule = parseContainerRule(src0)
  assert.ok(rule, 'rule present')
  // 精确定位按钮 JSX 里的 span（锚定 OutlineGlyph 邻接，避开文件里其它 span）
  const m = /h\(OutlineGlyph\), h\("span", \{ className: "([^"]+)"/.exec(src0)
  assert.ok(m, 'the outline button text span must exist next to the glyph')
  assert.equal(m[1], 'dsh-conv-header-btn-text', 'span carries the rule-target class')
  assert.ok(rule.selector.endsWith(m[1]), 'rule selector must end with the rendered span class')
})

test('R1 render is state-free: svg + text span + aria-label/title/type/onClick always in the DOM', () => {
  // 索引切片取按钮 JSX 全文（props 含内嵌对象，不能用懒惰正则）；断言无条件形态：
  // span 不在任何条件表达式里（显隐完全交给样式表）。
  const start = src0.indexOf('h("button", {\n\t\t\t\t\tkey: "conv-header-btn"')
  assert.ok(start >= 0, 'outline header button JSX must exist')
  const endMarker = 'h("span", { className: "dsh-conv-header-btn-text"'
  const end = src0.indexOf(endMarker, start)
  assert.ok(end > start, 'text span must be rendered right after the glyph')
  const jsx = src0.slice(start, src0.indexOf(')),' , end) + 3)
  assert.ok(/"aria-label": t\("panel\.title"\)/.test(jsx), 'aria-label present')
  assert.ok(/type: "button"/.test(jsx), 'type=button present (keyboard focusable/activatable)')
  assert.ok(/onClick/.test(jsx), 'click handler present')
  assert.ok(/title: pinned \? t\("panel\.collapse"\) : t\("panel\.title"\)/.test(jsx), 'title present')
  assert.ok(!jsx.includes('iconOnly'), 'no JS icon-only state in the JSX (hiding is stylesheet-driven)')
})

test('W real narrowing: layout simulated from the parsed product CSS (no circular self-proof)', () => {
  const rule = parseContainerRule(src0)
  assert.ok(rule, 'rule present')
  // 布局模拟：span 显示 ⇒ 文本计宽；display:none ⇒ 排除（与浏览器容器查询行为同构）
  const width = (titleRowWidth) => {
    const hide = titleRowWidth <= rule.threshold
    const spanW = hide && rule.display === 'none' ? 0 : TEXT_W
    return GLYPH_W + GAP_W + spanW + BTN_PAD
  }
  const wide = width(700)     // 右栏收起：titleRow 充足（> 阈值）
  const narrow = width(335)   // 右栏展开：现场 titleRow 335 ≤ 540
  assert.ok(Math.abs(wide - FULL_W) <= 2, `wide state keeps the full button (${wide} ≈ ${FULL_W})`)
  assert.ok(narrow < FULL_W * 0.6, `narrow state really shrinks: ${narrow} < 60% of ${FULL_W}`)
  assert.equal(narrow, GLYPH_W + GAP_W + BTN_PAD, 'narrow width = glyph + gap + padding (text fully excluded)')
})

test('D degrade: hiding lives only in the stylesheet — DOM/JSX never unmounts the span', () => {
  // span 的类名在源码中恰好出现两处：CSS 规则里一次、JSX 里一次 ⇒ 无第三条 JS 隐藏通路
  const occurrences = src0.split('dsh-conv-header-btn-text').length - 1
  assert.equal(occurrences, 2, `expected exactly 2 occurrences (CSS + JSX), got ${occurrences}`)
  // JSX 里 span 无条件渲染（R1 已断言），容器查询不命中（旧宿主）⇒ 规则不生效 ⇒ 保持宽态
})

/* ═══ 变异自证（隔离副本；期望红集 == 实际红集，逐条相等） ═══ */
const TMP_DIRS = []
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP_DIRS.push(d); return d }
process.on('exit', () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } })

function failingTestsIn(dir) {
  let out = ''
  try {
    // 本判据可能运行在 node --test 子进程里 ⇒ 剥掉 NODE_TEST_CONTEXT（嵌套 runner 否则进入
    // "子报告"模式，stdout 为空）；CONV_ICON_MUTATIONS=0 禁用副本内的变异循环（防指数递归）。
    const env = { ...process.env, CONV_ICON_MUTATIONS: '0' }
    delete env.NODE_TEST_CONTEXT
    out = execFileSync(process.execPath, ['--test', 'test/icon-only.test.js'], { cwd: dir, encoding: 'utf8', timeout: 120000, env })
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '')
  }
  const names = []
  for (const m of out.matchAll(/^✖ ([^\n]+?)(?: \([\d.]+ms\))?$/gm)) {
    if (m[1] !== 'failing tests:') names.push(m[1])
  }
  return [...new Set(names)].sort()
}

function withMutant(id, what, pairs, expectRed) {
  const dir = mkTmp('conv-icon-mut-')
  let mutated = src0
  const applied = []
  for (const [anchor, replacement] of pairs) {
    const n = mutated.split(anchor).length - 1
    const next = mutated.replace(anchor, replacement)
    applied.push(n === 1 && next !== mutated && !next.includes(anchor))
    mutated = next
  }
  fs.writeFileSync(path.join(dir, 'client.js'), mutated)
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'test', 'icon-only.test.js'), path.join(dir, 'test', 'icon-only.test.js'))
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'))
  const actual = failingTestsIn(dir)
  const expected = [...expectRed].sort()
  const eq = applied.every(Boolean) && JSON.stringify(actual) === JSON.stringify(expected)
  console.log('  ' + (eq ? 'MUTANT-RED-OK  ' : 'MUTANT-MISMATCH') + ' ' + id + ' ' + what)
  console.log('    期望红集=' + JSON.stringify(expected))
  console.log('    实际红集=' + JSON.stringify(actual) + ' 变异生效=' + JSON.stringify(applied))
  if (!eq) throw new Error('mutation mismatch: ' + id)
}

if (process.env.CONV_ICON_MUTATIONS !== '0') {
  const MUTANTS = [
    ['M1-nohide', '规则删掉 display:none（窄态不再收窄）',
      [['      @container (width <= 540px) {\n        .dsh-conv-header-btn .dsh-conv-header-btn-text {\n          display: none;\n        }\n      }',
        '      @container (width <= 540px) {\n        .dsh-conv-header-btn .dsh-conv-header-btn-text {\n          /* M1 */\n        }\n      }']],
      ['N source parity: our container-query condition matches the native label rule character-for-character',
       'S selector alignment: rule target class == the span className rendered by the button',
       'W real narrowing: layout simulated from the parsed product CSS (no circular self-proof)']],
    ['M2-always', '拆掉 @container 条件（规则恒生效 ⇒ 宽态被误收）',
      [['      @container (width <= 540px) {\n        .dsh-conv-header-btn .dsh-conv-header-btn-text {\n          display: none;\n        }\n      }',
        '      .dsh-conv-header-btn .dsh-conv-header-btn-text {\n        display: none; /* M2 */\n      }']],
      ['N source parity: our container-query condition matches the native label rule character-for-character',
       'S selector alignment: rule target class == the span className rendered by the button',
       'W real narrowing: layout simulated from the parsed product CSS (no circular self-proof)']],
  ]
  let failed = 0
  for (const [id, what, pairs, expect] of MUTANTS) {
    try {
      withMutant(id, what, pairs, expect)
    } catch (e) {
      failed++
      console.log('  ✗ ' + e.message)
    }
  }
  if (failed > 0) process.exitCode = 1
}
