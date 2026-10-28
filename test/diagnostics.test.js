// test/diagnostics.test.js — 一次性诊断日志（DOM 契约 / 快照形状）的回归测试。
//
// 背景：插件对宿主 DOM 属性和会话快照结构都做多候选兼容，但降级过去是**静默**的：
// 宿主改名后用户只看到「点了不跳」或「面板空着」，控制台没有任何线索。这里锁定：
//   1) probeDomContract 能分辨「契约齐全 / 缺哪个属性 / 只有等价锚点」；
//   2) reportDomContractOnce 缺失时 console.warn 一次、健康时 console.info 一次，且只一次；
//   3) snapshotShapeOf 覆盖新旧每一种快照形状；
//   4) reportSnapshotShapeOnce 记录实际形状与行数，陌生但像 ChatSnapshot 的结构告警一次，
//      数据尚未到达时不消耗那一次机会。
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

function makeReactStub() {
  return {
    createElement: () => null,
    Fragment: Symbol('fragment'),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useReducer: (_r, initial) => [initial, () => {}],
    useSyncExternalStore: () => null,
  }
}

/** 捕获 console 输出，返回 { logs, console }。 */
function makeConsole() {
  const logs = []
  const push = (level) => (...args) => logs.push({ level, text: args.map(String).join(' ') })
  return { logs, console: { log: push('log'), info: push('info'), warn: push('warn'), error: push('error') } }
}

function loadClient(consoleFace) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const dom = makeDomStub()
  let registered = null
  dom.window.__ModuleLoader__ = { load: (mod) => { registered = mod } }
  const factory = new Function('window', 'document', 'navigator', 'localStorage', 'console', src)
  factory(dom.window, dom.document, dom.navigator, makeLocalStorage(), consoleFace)
  assert.ok(registered, 'client.js must register itself via window.__ModuleLoader__.load')
  return registered.factory((id) => {
    if (id === 'react') return makeReactStub()
    throw new Error(`client.js must not require "${id}"`)
  })
}

/** 只实现 querySelector 的 DOM 桩：传入“存在的选择器”集合。 */
function makeFakeDocument(selectors) {
  return { querySelector: (selector) => (selectors.includes(selector) ? {} : null) }
}

const ALL_DOM = [
  '[data-conversation-scroll]',
  '[data-chat-flow-kind]',
  '[data-chat-anchor-key]',
  '[data-message-key]',
  '[data-node-key]',
]

test('probeDomContract distinguishes complete, degraded and equivalent-anchor DOM contracts', () => {
  const { probeDomContract } = loadClient(makeConsole().console).internals

  const complete = probeDomContract(makeFakeDocument(ALL_DOM))
  assert.equal(complete.ok, true)
  assert.deepEqual(complete.missing, [])

  const empty = probeDomContract(makeFakeDocument([]))
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.missing, [
    'data-conversation-scroll',
    'data-chat-flow-kind',
    'data-chat-anchor-key | data-message-key | data-node-key',
  ])

  // 只有等价的 message-key：精确定位仍可用，不应报“锚点缺失”。
  const equivalent = probeDomContract(makeFakeDocument([
    '[data-conversation-scroll]',
    '[data-chat-flow-kind]',
    '[data-message-key]',
  ]))
  assert.equal(equivalent.ok, true)

  // 滚动容器缺失只影响“跟随/回顶”，但也要提示。
  const noScroll = probeDomContract(makeFakeDocument(ALL_DOM.filter((s) => s !== '[data-conversation-scroll]')))
  assert.deepEqual(noScroll.missing, ['data-conversation-scroll'])

  assert.equal(probeDomContract(undefined).ok, false, 'missing document must degrade, not throw')
})

test('reportDomContractOnce logs exactly once and never throws on a renamed contract', () => {
  const capture = makeConsole()
  const api = loadClient(capture.console)
  const { reportDomContractOnce, resetDiagnostics } = api.internals

  resetDiagnostics()
  reportDomContractOnce(makeFakeDocument(ALL_DOM))
  assert.equal(capture.logs.length, 1, 'a healthy contract leaves one info line')
  assert.equal(capture.logs[0].level, 'info')
  assert.ok(capture.logs[0].text.includes('DOM contract OK'))

  // 第二次（哪怕契约随后坏掉）不再输出：一次性诊断不刷屏。
  reportDomContractOnce(makeFakeDocument([]))
  assert.equal(capture.logs.length, 1)

  resetDiagnostics()
  reportDomContractOnce(makeFakeDocument([]))
  assert.equal(capture.logs.length, 2)
  assert.equal(capture.logs[1].level, 'warn')
  const warning = capture.logs[1].text
  for (const name of ['data-conversation-scroll', 'data-chat-flow-kind', 'data-chat-anchor-key']) {
    assert.ok(warning.includes(name), `warning must name the missing contract: ${name}`)
  }
  assert.ok(warning.includes('text-order'), 'warning must state the degradation consequence')
})

test('snapshotShapeOf covers every snapshot contract dsh has used', () => {
  const { snapshotShapeOf } = loadClient(makeConsole().console).internals
  assert.equal(snapshotShapeOf(undefined), 'absent')
  assert.equal(snapshotShapeOf(null), 'absent')
  assert.equal(snapshotShapeOf(42), 'non-object')
  assert.equal(snapshotShapeOf([{ kind: 'user' }]), 'array')
  assert.equal(snapshotShapeOf({ legacy: { nodes: [] } }), 'legacy.nodes')
  assert.equal(snapshotShapeOf({ nodes: [] }), 'nodes')
  assert.equal(snapshotShapeOf({ items: [] }), 'items')
  assert.equal(snapshotShapeOf({ messages: [] }), 'messages')
  assert.equal(snapshotShapeOf({ chat: { order: [], nodes: {} } }), 'chat.order')
  assert.equal(snapshotShapeOf({ nodes: { values: () => [] } }), 'nodes.values')
  assert.equal(snapshotShapeOf({}), 'unknown')
  assert.equal(snapshotShapeOf({ legacy: { nodes: 'nope' } }), 'unknown')
})

test('reportSnapshotShapeOnce records the actual shape and warns once on an unknown ChatSnapshot', () => {
  const capture = makeConsole()
  const api = loadClient(capture.console)
  const { reportSnapshotShapeOnce, resetDiagnostics, safeNodesOf } = api.internals

  resetDiagnostics()
  // 数据还没到：不消耗那一次机会。
  reportSnapshotShapeOnce(undefined)
  reportSnapshotShapeOnce({})
  assert.equal(capture.logs.length, 0)

  const legacy = { legacy: { nodes: [{ kind: 'user', text: 'q' }, { kind: 'assistant', text: '## h' }] } }
  reportSnapshotShapeOnce(legacy, safeNodesOf(legacy).length)
  assert.equal(capture.logs.length, 1)
  assert.equal(capture.logs[0].level, 'info')
  assert.ok(capture.logs[0].text.includes('legacy.nodes'))
  assert.ok(capture.logs[0].text.includes('2 rows'))

  // 第二次（哪怕换成旧结构）不再输出。
  reportSnapshotShapeOnce({ chat: { order: ['a'], nodes: { a: { kind: 'user', text: 'q' } } } }, 1)
  assert.equal(capture.logs.length, 1)

  resetDiagnostics()
  reportSnapshotShapeOnce({ legacy: { nodes: 'nope' }, order: [], nodes: 'nope' })
  assert.equal(capture.logs.length, 2)
  assert.equal(capture.logs[1].level, 'warn')
  assert.ok(capture.logs[1].text.includes('unrecognised'))
  assert.ok(capture.logs[1].text.includes('legacy, order, nodes'), 'warning must list the keys it saw')

  resetDiagnostics()
  reportSnapshotShapeOnce({ someOtherField: 1 })
  assert.equal(capture.logs.length, 2, 'unknown but chat-unlike objects are not worth a warning')
})
