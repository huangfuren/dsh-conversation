// test/slots-channel.test.js — 槽位注册通道的三层兜底。
//
// 背景：面板唯一入口是 conversation.session.header.actions 槽位。历史上的实现把
// `ctx.slots.inject` 当成硬依赖，一旦宿主换掉这个 API，整个面板会直接消失且只有一条
// console.warn。这里用假槽位表把三条通道（inject / subscribeDeclaration / 退避重试）
// 和两类真实故障（声明迟到、槽位塌缩重建）都跑一遍。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

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

/** 加载一份沙箱实例；setTimeout 被捕获成队列，便于同步推进重试。 */
function loadClient() {
  const warns = []
  const timers = new Map()
  let nextTimerId = 1
  const sandbox = {
    console: {
      log() {}, info() {}, error() {}, debug() {},
      warn: (...args) => warns.push(args.join(' ')),
    },
    setTimeout: (fn) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, fn)
      return id
    },
    clearTimeout: (id) => { timers.delete(id) },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  sandbox.window = sandbox
  sandbox.window.__ModuleLoader__ = { load: (definition) => { sandbox.__definition = definition } }
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox)

  const mod = sandbox.__definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`client.js must not require "${id}"`)
  })

  const flushTimers = () => {
    let guard = 0
    while (timers.size > 0 && guard < 60) {
      const [id, fn] = timers.entries().next().value
      timers.delete(id)
      fn()
      guard += 1
    }
  }

  return { mod, warns, flushTimers, pendingTimers: () => timers.size }
}

/**
 * 假槽位表：模拟真实宿主的三件关键行为
 * 1. 未声明时 register 抛 `is not declared`；
 * 2. 同 id 重复注册抛 `already has an entry with id`；
 * 3. 声明 / 塌缩各推进一次 epoch，并同步通知声明监听者。
 */
function makeSlots(channels) {
  const state = { declared: false, epoch: 0, entries: [], injectCbs: [], declareHandlers: [] }
  const table = {
    register(options) {
      if (!state.declared) {
        throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
      }
      if (state.entries.some((entry) => entry.id === options.id)) {
        throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`)
      }
      state.entries.push({ id: options.id, name: options.name })
    },
    declarationEpoch: () => state.epoch,
  }
  if (channels.includes('inject')) {
    table.inject = (key, cb) => { state.injectCbs.push({ key, cb }) }
  }
  if (channels.includes('declaration')) {
    table.subscribeDeclaration = (key, fn) => {
      state.declareHandlers.push({ key, fn })
      return () => {}
    }
  }
  return {
    table,
    state,
    declare() {
      state.declared = true
      state.epoch += 1
      for (const { fn } of state.declareHandlers) fn()
    },
    collapse() {
      state.declared = false
      state.epoch += 1
      state.entries.length = 0 // 宿主丢弃塌缩槽位下的所有条目
      for (const { fn } of state.declareHandlers) fn()
    },
    notify() {
      for (const { fn } of state.declareHandlers) fn()
    },
  }
}

function applyWith(client, slots) {
  client.mod.apply({ slots, sessions: {} })
}

test('resolveSlotChannel 按可用 API 选择通道', () => {
  const { resolveSlotChannel } = loadClient().mod.internals
  assert.equal(resolveSlotChannel({ register() {}, inject() {}, subscribeDeclaration() {} }), 'inject', 'inject 优先')
  assert.equal(resolveSlotChannel({ register() {}, subscribeDeclaration() {} }), 'declaration', 'inject 缺失时退到声明事件')
  assert.equal(resolveSlotChannel({ register() {} }), 'register', '都没有时只剩退避重试')
  assert.equal(resolveSlotChannel({}), 'register')
  assert.equal(resolveSlotChannel(null), 'register')
  assert.equal(resolveSlotChannel(undefined), 'register')
})

test('inject 通道：声明迟到时靠 inject 回调补注册', () => {
  const client = loadClient()
  const fake = makeSlots(['inject'])
  applyWith(client, fake.table)

  assert.equal(fake.state.entries.length, 0, '槽位未声明，第一次注册必然失败')
  assert.equal(fake.state.injectCbs.length, 1, 'inject 仍应被调用')

  fake.declare()
  fake.state.injectCbs[0].cb()
  assert.equal(fake.state.entries.length, 1, '声明后应挂上条目')
  assert.equal(fake.state.entries[0].id, 'dsh-conversation')
})

test('inject 缺失时改走 subscribeDeclaration，面板不再整块消失', () => {
  const client = loadClient()
  const fake = makeSlots(['declaration'])
  applyWith(client, fake.table)

  assert.equal(fake.state.declareHandlers.length, 1, '应订阅声明事件')
  assert.equal(fake.state.declareHandlers[0].key, 'conversation.session.header.actions')

  fake.declare()
  assert.equal(fake.state.entries.length, 1, '声明通知后应挂上条目')
  assert.equal(client.warns.length, 0, '正常路径不该 warn')
})

test('重复的声明通知不会重复注册同一个 id', () => {
  const client = loadClient()
  const fake = makeSlots(['declaration'])
  applyWith(client, fake.table)
  fake.declare()
  assert.equal(fake.state.entries.length, 1)

  // 同一 epoch 再通知两次：真实宿主会因同 id 抛 already has an entry
  fake.notify()
  fake.notify()
  assert.equal(fake.state.entries.length, 1, '幂等：仍只有一个条目')
  assert.equal(client.pendingTimers(), 0, '重复通知不该排出无意义的重试')
  client.flushTimers()
  assert.ok(
    !client.warns.some((line) => /already has an entry/.test(line)),
    `不该触发重复注册告警，实际：${client.warns.join(' | ')}`,
  )
})

test('槽位塌缩重建后自动重新注册（旧实现在这里永久失效）', () => {
  const client = loadClient()
  const fake = makeSlots(['declaration'])
  applyWith(client, fake.table)
  fake.declare()
  assert.equal(fake.state.entries.length, 1)

  fake.collapse()
  assert.equal(fake.state.entries.length, 0, '塌缩会连带丢掉我们的条目')
  client.flushTimers() // 塌缩通知里的注册失败后走过若干次退避重试

  fake.declare()
  assert.equal(fake.state.entries.length, 1, '重建后应重新挂上')
})

test('两条快通道都缺时，退回立即注册 + 退避重试', () => {
  const client = loadClient()
  const fake = makeSlots([])
  applyWith(client, fake.table)

  assert.equal(fake.state.entries.length, 0)
  assert.ok(client.pendingTimers() > 0, '应排上重试定时器')

  fake.declare()
  client.flushTimers()
  assert.equal(fake.state.entries.length, 1, '重试最终应成功')
})

test('slots.register 缺失时只 warn 不抛，插件初始化不炸', () => {
  const client = loadClient()
  assert.doesNotThrow(() => client.mod.apply({ slots: {}, sessions: {} }))
  assert.doesNotThrow(() => client.mod.apply({ slots: null, sessions: {} }))
  assert.doesNotThrow(() => client.mod.apply({}))
  assert.ok(client.warns.some((line) => /slots\.register missing/.test(line)))
})
