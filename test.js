import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, apply } from './index.js'

/** Volatile reference protocol the Loader uses to commit a config edit. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Build a minimal Cordis-like context that records listeners and log lines. */
function createHarness({ registry, agents } = {}) {
  const listeners = []
  const logs = { info: [], warn: [], debug: [] }
  const ctx = {
    get: (name) => {
      if (name === 'agentPresets') return registry
      if (name === 'agents') return agents
      return undefined
    },
    on(name, listener) {
      listeners.push({ name, listener })
      return () => {}
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      debug: (message) => logs.debug.push(message),
    },
  }
  return {
    ctx,
    listeners,
    logs,
    emit(name, payload) {
      for (const entry of listeners) {
        if (entry.name === name) entry.listener(payload)
      }
    },
    listenerCount: (name) => listeners.filter((entry) => entry.name === name).length,
  }
}

/** Build an agent whose scope resolves one compaction service and an optional preset registry. */
function createAgent(engine, registry) {
  return {
    ctx: {
      get: (name) => {
        if (name === 'compaction') return engine
        if (name === 'agentPresets') return registry
        return undefined
      },
    },
  }
}

/** Build a frozen resolved config shaped like the basic engine's. */
function createEngine() {
  return {
    config: Object.freeze({
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      headroomTokens: 65_536,
    }),
  }
}

/** Validate a row the way the Loader does, yielding the volatile references. */
function parseConfig(patch = {}) {
  const result = Config['~standard'].validate(patch)
  assert.equal(result.issues, undefined, `expected ${JSON.stringify(patch)} to validate`)
  return result.value
}

/** Commit a new value into a parsed volatile field, as the Loader's config update does. */
function writeThreshold(config, value) {
  config.thresholdRatio[VOLATILE_WRITE](value)
}

test('declares thresholdRatio as a volatile field with the default ratio', () => {
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  const field = json.refs[root.dict.thresholdRatio]
  assert.equal(field.meta.volatile, true)
  assert.equal(field.meta.default, 0.5)
  assert.equal(field.meta.max, 1)
  assert.equal(field.meta.step, 0.01)
  assert.equal(typeof field.meta.description, 'string')
  assert.ok(field.meta.description.length > 0)
  assert.equal(parseConfig({}).thresholdRatio.get(), 0.5)
})

test('rejects out-of-range values in the schema', () => {
  for (const thresholdRatio of [0, -1, 1.5, '0.5']) {
    const result = Config['~standard'].validate({ thresholdRatio })
    assert.ok(result.issues, `expected the schema to reject ${String(thresholdRatio)}`)
  }
})

test('replaces the frozen config on the preset engine', () => {
  const { ctx, emit } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  emit('agent/created', { agent: createAgent(engine) })
  assert.equal(engine.config.thresholdRatio, 0.5)
  assert.equal(engine.config.retainRatio, 0.16)
  assert.equal(engine.config.headroomTokens, 65_536)
})

test('leaves the original frozen config untouched', () => {
  const { ctx, emit } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  const original = engine.config
  emit('agent/created', { agent: createAgent(engine) })
  assert.notEqual(engine.config, original)
  assert.equal(original.thresholdRatio, 0.8)
})

test('applies the default ratio when the row omits it', () => {
  const { ctx, emit } = createHarness()
  apply(ctx, {})
  const engine = createEngine()
  emit('agent/created', { agent: createAgent(engine) })
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('applies the default ratio of a parsed empty row', () => {
  const { ctx, emit } = createHarness()
  apply(ctx, parseConfig({}))
  const engine = createEngine()
  emit('agent/created', { agent: createAgent(engine) })
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('is idempotent for repeated agents', () => {
  const { ctx, emit } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  emit('agent/created', { agent: createAgent(engine) })
  const applied = engine.config
  emit('agent/created', { agent: createAgent(engine) })
  assert.equal(engine.config, applied)
})

test('skips presets without a basic compaction engine', () => {
  const { ctx, emit, logs } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  emit('agent/created', { agent: createAgent(undefined) })
  emit('agent/created', { agent: createAgent({}) })
  assert.equal(logs.debug.filter((message) => message.includes('no basic compaction engine')).length, 2)
  assert.equal(logs.warn.length, 0)
})

test('reads an isolated preset engine through the agent-scope registry', () => {
  const { ctx, emit } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  const registry = { serviceFor: (_agent, name) => (name === 'compaction' ? engine : undefined) }
  emit('agent/created', { agent: createAgent(undefined, registry) })
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('falls back to the plugin-context registry when the agent scope has none', () => {
  const engine = createEngine()
  const registry = { serviceFor: (_agent, name) => (name === 'compaction' ? engine : undefined) }
  const { ctx, emit } = createHarness({ registry })
  apply(ctx, { thresholdRatio: 0.5 })
  emit('agent/created', { agent: createAgent(undefined) })
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('rejects ratios outside (0, 1] at load', () => {
  const { ctx } = createHarness()
  for (const thresholdRatio of [0, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.throws(
      () => apply(ctx, { thresholdRatio }),
      /must be a number in \(0, 1\]/,
      `expected rejection for ${String(thresholdRatio)}`,
    )
  }
})

test('warns when the ratio does not exceed retainRatio', () => {
  const { ctx, emit, logs } = createHarness()
  apply(ctx, { thresholdRatio: 0.1 })
  const engine = createEngine()
  emit('agent/created', { agent: createAgent(engine) })
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /retainRatio/)
  assert.equal(engine.config.thresholdRatio, 0.1)
})

test('reads the live volatile value for each newly created agent', () => {
  const config = parseConfig({})
  const { ctx, emit } = createHarness()
  apply(ctx, config)

  const first = createEngine()
  emit('agent/created', { agent: createAgent(first) })
  assert.equal(first.config.thresholdRatio, 0.5)

  writeThreshold(config, 0.7)
  const second = createEngine()
  emit('agent/created', { agent: createAgent(second) })
  assert.equal(second.config.thresholdRatio, 0.7)
})

test('applies the live value to agents that already exist at activation', () => {
  const engine = createEngine()
  const agents = { list: () => [createAgent(engine)] }
  const { ctx } = createHarness({ agents })
  apply(ctx, parseConfig({}))
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('re-applies a saved volatile value to a live agent', () => {
  const config = parseConfig({})
  const engine = createEngine()
  const agents = { list: () => [createAgent(engine)] }
  const { ctx, emit } = createHarness({ agents })
  apply(ctx, config)

  writeThreshold(config, 0.65)
  emit('loader/volatile-update', [['thresholdRatio']])

  assert.equal(engine.config.thresholdRatio, 0.65)
  assert.equal(engine.config.retainRatio, 0.16)
})

test('re-applies to every live agent, including isolated preset mounts', () => {
  const config = parseConfig({})
  const direct = createEngine()
  const isolated = createEngine()
  const isolatedRegistry = {
    serviceFor: (_agent, name) => (name === 'compaction' ? isolated : undefined),
  }
  const agents = {
    list: () => [createAgent(direct), createAgent(undefined, isolatedRegistry)],
  }
  const { ctx, emit } = createHarness({ agents })
  apply(ctx, config)

  writeThreshold(config, 0.42)
  emit('loader/volatile-update', [['thresholdRatio']])

  assert.equal(direct.config.thresholdRatio, 0.42)
  assert.equal(isolated.config.thresholdRatio, 0.42)
})

test('keeps running when no agents service is available', () => {
  const config = parseConfig({})
  const { ctx, emit, logs } = createHarness()
  apply(ctx, config)
  writeThreshold(config, 0.6)
  emit('loader/volatile-update', [['thresholdRatio']])
  assert.ok(logs.debug.some((message) => message.includes('no agents service')))
})

test('ignores an unusable live value instead of failing the agent event', () => {
  const config = parseConfig({})
  const engine = createEngine()
  const agents = { list: () => [createAgent(engine)] }
  const { ctx, emit, logs } = createHarness({ agents })
  apply(ctx, config)

  writeThreshold(config, 1.5)
  emit('loader/volatile-update', [['thresholdRatio']])

  assert.equal(engine.config.thresholdRatio, 0.5)
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /unusable config value/)
})

test('subscribes to the Loader lifecycle once per activation', () => {
  const { ctx, listenerCount } = createHarness()
  apply(ctx, parseConfig({}))
  assert.equal(listenerCount('agent/created'), 1)
  assert.equal(listenerCount('loader/volatile-update'), 1)
})
