// test/client.test.js — 客户端大纲语义的回归测试。
//
// 客户端入口 client.js 不是 ESM,而是 dsh 加载器格式(window.__ModuleLoader__.load({id, factory})),
// 所以这里先搭一个最小加载器桩把它 load 进来,再断言它专门导出的 exports.internals 纯函数。
// 这几个纯函数(快照归一 / 文本抽取 / 建大纲)决定了大纲树的语义,是回归价值最高的部分;
// 依赖宿主 DOM 的定位与滚动逻辑无法在 Node 里测,由 test/contract.test.js 的结构断言兜住。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client.js')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const MAX_USER_TEXT = 80 // 与 client.js 保持一致

function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
}

function makeDomStub() {
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollTo() {}, focus() {}, contains: () => false, textContent: '',
  })
  const document = {
    body: el(), head: el(), documentElement: el(),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: el, createTextNode: () => ({}),
    addEventListener() {}, removeEventListener() {},
  }
  const window = {
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    getComputedStyle: () => ({ overflowY: 'visible', position: 'static' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
  }
  return { window, document, navigator: { language: 'en-US', languages: ['en-US'] } }
}

/** 用加载器桩加载 client.js,返回 { module, exports, required }。 */
function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const required = []
  const warns = []
  const React = {
    createElement: () => null,
    Fragment: {},
    useState: () => [null, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useReducer: (_r, initial) => [initial, () => {}],
    useSyncExternalStore: () => null,
  }
  const requireStub = (id) => {
    required.push(id)
    if (id === 'react') return React
    // 客户端只能依赖宿主提供的外部模块;任何相对路径依赖在真实加载器里会解析失败。
    throw new Error(`client.js must not require "${id}"`)
  }
  const quietConsole = { log() {}, info() {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) }

  let registered = null
  const dom = makeDomStub()
  dom.window.__ModuleLoader__ = { load: (mod) => { registered = mod } }

  const factory = new Function('window', 'document', 'navigator', 'localStorage', 'console', src)
  factory(dom.window, dom.document, dom.navigator, makeLocalStorage(), quietConsole)

  assert.ok(registered, 'client.js must register itself via window.__ModuleLoader__.load')
  const exports = registered.factory(requireStub)
  return { module: registered, exports, required, warns }
}

const { module: mod, exports: api, required } = loadClient()

test('loader contract: id, exports and declared services', () => {
  assert.equal(mod.id, pkg.name, 'module id must equal the package name')
  assert.equal(typeof api.apply, 'function')
  assert.deepEqual(api.inject, ['slots', 'sessions'], 'host services this panel needs')
  assert.ok(Object.isFrozen(api.internals), 'internals must be frozen')
  assert.deepEqual(required, ['react'], 'client may only require the host-provided react')
})

test('internals expose exactly the pure helpers', () => {
  assert.deepEqual(Object.keys(api.internals).sort(), [
    'HistoryOutlinePanelInner', 'HistoryOutlinePlaceholder', 'HistoryOutlineSlot', 'buildOutlineItems',
    'conversationNodesOf', 'createHostBridge', 'mainSessionIdOf', 'makeSessionBindingSelector',
    'panelMountStateOf', 'probeDomContract', 'readHostService', 'reportDomContractOnce',
    'reportSnapshotShapeOnce', 'resetDiagnostics', 'safeNodesOf', 'snapshotRows', 'snapshotShapeOf',
    'snapshotSourceOf', 'textBlocks', 'userText',
  ])
  for (const [name, fn] of Object.entries(api.internals)) assert.equal(typeof fn, 'function', `${name} must be a function`)
})

test('snapshotRows normalises every session-snapshot shape dsh has used', () => {
  const { snapshotRows } = api.internals
  const rows = [{ key: 'a' }, { key: 'b' }]
  assert.equal(snapshotRows(rows), rows, 'a bare array is already a row list')
  assert.deepEqual(snapshotRows({ nodes: rows }), rows)
  assert.deepEqual(snapshotRows({ items: rows }), rows)
  assert.deepEqual(snapshotRows({ messages: rows }), rows)
  assert.deepEqual(snapshotRows({ legacy: { nodes: rows } }), rows)
  // 0.1.5 形状:chat.order 给出顺序,nodes 可能是 Map 也可能是普通对象
  assert.deepEqual(snapshotRows({ chat: { order: ['a', 'b'], nodes: new Map(rows.map((r) => [r.key, r])) } }), rows)
  assert.deepEqual(snapshotRows({ chat: { order: ['a', 'b'], nodes: { a: rows[0], b: rows[1] } } }), rows)
  assert.deepEqual(snapshotRows({ nodes: { values: () => rows } }), rows)
  // 顺序必须按 chat.order,缺项跳过而不是塞 undefined
  assert.deepEqual(snapshotRows({ chat: { order: ['b', 'missing', 'a'], nodes: { a: rows[0], b: rows[1] } } }), [rows[1], rows[0]])
  for (const bad of [null, undefined, 42, 'text', {}]) assert.deepEqual(snapshotRows(bad), [], `expected [] for ${String(bad)}`)
})

test('textBlocks harvests text from every block shape', () => {
  const { textBlocks } = api.internals
  assert.deepEqual(textBlocks('plain'), ['plain'])
  assert.deepEqual(textBlocks({ text: 'top' }), ['top'])
  assert.deepEqual(textBlocks({ blocks: ['raw', { kind: 'text', text: 'k' }, { type: 'text', text: 't' }, { kind: 'tool' }] }), ['raw', 'k', 't'])
  assert.deepEqual(textBlocks({ data: { text: 'd', content: ['c', { type: 'text', text: 'ct' }] } }), ['c', 'ct', 'd'])
  for (const empty of [null, undefined, '', {}, { text: '' }]) assert.deepEqual(textBlocks(empty), [], `expected [] for ${JSON.stringify(empty)}`)
})

test('textBlocks harvests each content array only once (regression)', () => {
  // rowContent() 取的就是 node.content / node.data.content,与 data.content 那条分支可能指向同一个数组。
  // 修复前这里会返回 ['c','ct','d','c','ct']:同一段正文进两次 → 标题在大纲里重复、该轮字数翻倍。
  const { textBlocks, buildOutlineItems } = api.internals
  const content = ['c', { type: 'text', text: 'ct' }]

  assert.deepEqual(textBlocks({ data: { text: 'd', content } }), ['c', 'ct', 'd'])
  assert.deepEqual(textBlocks({ content, data: { content } }), ['c', 'ct'], 'same array referenced twice')

  // 用户可见的症状:同一批标题只应出现一次,字数也不该翻倍。
  const items = buildOutlineItems([
    { kind: 'user', text: 'Q' },
    { kind: 'assistant', data: { content: [{ type: 'text', text: '# 标题\n正文\n## 子标题' }] } },
  ])
  assert.deepEqual(items.slice(1).map((i) => i.text), ['标题', '子标题'])
  assert.equal(items[0].charCount, '# 标题\n正文\n## 子标题'.length)
})

test('userText keeps only the first non-empty line', () => {
  const { userText } = api.internals
  assert.equal(userText({ kind: 'user', text: 'first line\nsecond line' }), 'first line')
  assert.equal(userText({ kind: 'user', text: '   padded   ' }), 'padded')
  assert.equal(userText({ kind: 'user', title: 'from title' }), 'from title')
  assert.equal(userText({ kind: 'user' }), '')
})

test('buildOutlineItems: user turns are level 0, assistant headings hang below, tools only counted', () => {
  const { buildOutlineItems } = api.internals
  const items = buildOutlineItems([
    { kind: 'user', key: 'u1', text: '问题一' },
    { kind: 'assistant', text: '# 方案\n正文\n## 细节\n正文' },
    { kind: 'tool-call', text: 'ignored' },
    { kind: 'user', key: 'u2', text: '问题二' },
  ])

  assert.deepEqual(items.map((i) => [i.level, i.text]), [
    [0, '问题一'], [1, '方案'], [2, '细节'], [0, '问题二'],
  ])
  assert.equal(items[0].isUserQuery, true)
  assert.equal(items[0].userIndex, 0)
  assert.equal(items[0].key, 'u1')
  assert.equal(items[3].userIndex, 1)
  // 标题项带连续 headingIndex,与 DOM 里的 h1..h6 顺序对应
  assert.equal(items[1].headingIndex, 0)
  assert.equal(items[2].headingIndex, 1)
  // 工具节点不进大纲,但计入它所属那一轮
  assert.equal(items[0].toolCount, 1)
  assert.equal(items[3].toolCount, 0)
  assert.equal(items[0].charCount, '# 方案\n正文\n## 细节\n正文'.length)
  // 非正文节点绝不产生大纲项
  assert.ok(!items.some((i) => i.text === 'ignored'))
})

test('buildOutlineItems skips headings inside fenced code blocks', () => {
  const { buildOutlineItems } = api.internals
  const items = buildOutlineItems([
    { kind: 'user', text: 'Q' },
    { kind: 'assistant', text: '# 真标题\n```sh\n# 这是注释\n```\n## 另一个真标题' },
  ])
  assert.deepEqual(items.slice(1).map((i) => i.text), ['真标题', '另一个真标题'])
})

test('buildOutlineItems marks streaming headings from snapshot.partial', () => {
  const { buildOutlineItems } = api.internals
  const items = buildOutlineItems({ items: [{ kind: 'user', text: 'Q' }], partial: { text: '## 正在写' } })
  assert.equal(items.length, 2)
  assert.equal(items[1].text, '正在写')
  assert.equal(items[1].level, 2)
  assert.equal(items[1].streaming, true)
})

test('buildOutlineItems truncates very long user text but flags it', () => {
  const { buildOutlineItems } = api.internals
  const long = 'x'.repeat(MAX_USER_TEXT + 40)
  const [item] = buildOutlineItems([{ kind: 'user', text: long }])
  assert.equal(item.text.length, MAX_USER_TEXT)
  assert.equal(item.isTruncated, true)

  const [shortItem] = buildOutlineItems([{ kind: 'user', text: 'ok' }])
  assert.equal(shortItem.isTruncated, undefined, 'short text must not be flagged')
})

test('buildOutlineItems ignores empty user rows and treats steering as a user turn', () => {
  const { buildOutlineItems } = api.internals
  const items = buildOutlineItems([
    { kind: 'user', text: '   ' },
    { kind: 'steering', text: '插话' },
  ])
  assert.deepEqual(items.map((i) => i.text), ['插话'])
  assert.equal(items[0].isUserQuery, true)
})
