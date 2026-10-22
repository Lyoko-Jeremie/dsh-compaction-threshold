import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './index.js'

/** Build a minimal Cordis-like context that records listeners and log lines. */
function createHarness({ registry } = {}) {
  const listeners = []
  const logs = { info: [], warn: [], debug: [] }
  const ctx = {
    get: (name) => (name === 'agentPresets' ? registry : undefined),
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
  return { ctx, listeners, logs }
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

test('replaces the frozen config on the preset engine', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  listeners[0].listener({ agent: createAgent(engine) })
  assert.equal(engine.config.thresholdRatio, 0.5)
  assert.equal(engine.config.retainRatio, 0.16)
  assert.equal(engine.config.headroomTokens, 65_536)
})

test('leaves the original frozen config untouched', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  const original = engine.config
  listeners[0].listener({ agent: createAgent(engine) })
  assert.notEqual(engine.config, original)
  assert.equal(original.thresholdRatio, 0.8)
})

test('applies the default ratio when the row omits it', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, {})
  const engine = createEngine()
  listeners[0].listener({ agent: createAgent(engine) })
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('is idempotent for repeated agents', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  listeners[0].listener({ agent: createAgent(engine) })
  const applied = engine.config
  listeners[0].listener({ agent: createAgent(engine) })
  assert.equal(engine.config, applied)
})

test('skips presets without a basic compaction engine', () => {
  const { ctx, listeners, logs } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  listeners[0].listener({ agent: createAgent(undefined) })
  listeners[0].listener({ agent: createAgent({}) })
  assert.equal(logs.debug.length, 2)
  assert.equal(logs.warn.length, 0)
})

test('reads an isolated preset engine through the agent-scope registry', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, { thresholdRatio: 0.5 })
  const engine = createEngine()
  const registry = { serviceFor: (_agent, name) => (name === 'compaction' ? engine : undefined) }
  listeners[0].listener({ agent: createAgent(undefined, registry) })
  assert.equal(engine.config.thresholdRatio, 0.5)
})

test('falls back to the plugin-context registry when the agent scope has none', () => {
  const engine = createEngine()
  const registry = { serviceFor: (_agent, name) => (name === 'compaction' ? engine : undefined) }
  const { ctx, listeners } = createHarness({ registry })
  apply(ctx, { thresholdRatio: 0.5 })
  listeners[0].listener({ agent: createAgent(undefined) })
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
  const { ctx, listeners, logs } = createHarness()
  apply(ctx, { thresholdRatio: 0.1 })
  const engine = createEngine()
  listeners[0].listener({ agent: createAgent(engine) })
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /retainRatio/)
  assert.equal(engine.config.thresholdRatio, 0.1)
})
