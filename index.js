/**
 * Runtime override for the automatic compaction pressure threshold used by
 * `@deepseek-ai/dsh-compaction-basic`.
 *
 * `thresholdRatio` is declared volatile, so Settings projects it into an
 * editable form whose namespace is this row's Loader entry id
 * (`compaction-threshold`). The Loader commits a volatile-only config edit into
 * the running fiber's reference and emits `loader/volatile-update`; this plugin
 * reads the reference on every use instead of capturing a value at activation.
 *
 * The preset-owned engine keeps its resolved configuration in a frozen object,
 * so this plugin replaces the engine instance's `config` property with a copy
 * carrying the current ratio. Agent preset declarations stay untouched.
 *
 * @module dsh-compaction-threshold
 */

import z from '@deepseek-ai/schemastery'

/** Name used by Loader diagnostics for this function plugin. */
export const name = 'dsh-compaction-threshold'

/** Applied when the row omits `thresholdRatio`. */
const DEFAULT_THRESHOLD_RATIO = 0.5

/** Volatile reference protocol shared with `@deepseek-ai/cosmokit` across copies. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Volatile Config of this plugin.
 *
 * Only declared fields reach the Settings page; `thresholdRatio` is the single
 * live value the row exposes. The range is enforced here as well as in `apply`,
 * so a rejected edit never reaches the engine.
 */
export const Config = z.object({
  thresholdRatio: z.number()
    .step(0.01)
    .min(Number.MIN_VALUE)
    .max(1)
    .default(DEFAULT_THRESHOLD_RATIO)
    .volatile()
    .description(
      '自动压缩触发阈值：上下文占用达到该比例时触发自动压缩。取值 (0, 1]，'
      + '且必须大于 compaction 后端的 retainRatio（basic 后端默认 0.16）。',
    ),
})

/**
 * Whether a resolved Config field is a volatile reference rather than a plain value.
 *
 * @param {unknown} value - one field of the validated plugin config.
 * @returns {boolean} whether the field resolves through the volatile protocol.
 */
function isVolatile(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Validate one threshold value.
 *
 * @param {unknown} value - candidate pressure fraction.
 * @returns {number} the accepted ratio.
 * @throws {Error} when the value is not a finite number inside (0, 1].
 */
function assertThresholdRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `dsh-compaction-threshold: thresholdRatio (${String(value)}) must be a number in (0, 1]`,
    )
  }
  return value
}

/**
 * Read the current threshold from the live Config reference.
 *
 * A volatile field is read on every call so a Settings edit takes effect without
 * reloading the plugin; a plain value keeps `apply` usable from a composition
 * that passed the resolved config directly.
 *
 * @param {{ thresholdRatio?: unknown }} config - validated plugin config.
 * @returns {number} the current pressure fraction.
 * @throws {Error} when the current value is outside (0, 1].
 */
function readThresholdRatio(config) {
  const field = config.thresholdRatio
  const value = isVolatile(field) ? field.get() : field
  return assertThresholdRatio(value ?? DEFAULT_THRESHOLD_RATIO)
}

/**
 * Narrow the resolved `compaction` service to the basic engine shape.
 *
 * Structural on purpose: this plugin carries no runtime import of the engine
 * package, so it never depends on module identity or on another installed copy.
 *
 * @param {unknown} value - resolved `compaction` service.
 * @returns {boolean} whether the value carries a resolved compaction config.
 */
function isBasicEngine(value) {
  if (typeof value !== 'object' || value === null) return false
  const config = Reflect.get(value, 'config')
  return typeof config === 'object' && config !== null
    && typeof Reflect.get(config, 'thresholdRatio') === 'number'
}

/**
 * Replace the engine's resolved config with one carrying `thresholdRatio`.
 *
 * The engine reads `this.config` on every compaction decision, so replacing the
 * instance property changes the threshold for later steps without remounting the
 * preset.
 *
 * @param {object} engine - resolved basic compaction engine.
 * @param {number} thresholdRatio - pressure fraction to apply.
 * @param {{ logger: { info: (message: string) => void, warn: (message: string) => void } }} ctx - plugin context.
 * @returns {void}
 */
function overrideThreshold(engine, thresholdRatio, ctx) {
  const config = Reflect.get(engine, 'config')
  if (Reflect.get(config, 'thresholdRatio') === thresholdRatio) return

  const retainRatio = Reflect.get(config, 'retainRatio')
  if (typeof retainRatio === 'number' && thresholdRatio <= retainRatio) {
    ctx.logger.warn(
      `dsh-compaction-threshold: thresholdRatio ${thresholdRatio} is not greater than `
      + `retainRatio ${retainRatio}; automatic compaction will reject this configuration`,
    )
  }

  Object.defineProperty(engine, 'config', {
    value: { ...config, thresholdRatio },
    writable: true,
    configurable: true,
  })
  ctx.logger.info(`dsh-compaction-threshold: pressure threshold set to ${thresholdRatio}`)
}

/**
 * Resolve the basic compaction engine owned by one agent's preset mount.
 *
 * Agent presets mount their compaction backend inside an `isolate` realm, so
 * the service is not visible from the agent's own scope; the preset registry
 * exposes the implementation a mount owns. Compositions without a preset (or
 * without the registry) keep the direct agent-scope lookup.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ ctx: import('@deepseek-ai/cordis').Context }} agent - agent created by the loop.
 * @returns {unknown} the engine when one is reachable.
 */
function resolveEngine(ctx, agent) {
  const registry = agent.ctx.get('agentPresets') ?? ctx.get('agentPresets')
  const presetEngine = registry?.serviceFor?.(agent, 'compaction')
  if (isBasicEngine(presetEngine)) return presetEngine
  return agent.ctx.get('compaction')
}

/**
 * Apply the current threshold to every agent created after this plugin loads,
 * and re-apply it to live agents when the Settings form saves a new value.
 *
 * `agent/created` fires after the agent's preset generation mounted, so the
 * preset-owned `compaction` service is reachable through the preset registry.
 * `loader/volatile-update` is the Loader's volatile-only config commit: the
 * fiber keeps running, so already-created agents need the new value pushed.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ thresholdRatio?: unknown }} [config] - row configuration; the volatile field is read live.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // A row that can never produce a usable threshold fails at activation rather
  // than on the first agent; later edits are re-validated per read.
  readThresholdRatio(config)

  /**
   * Apply the live threshold to one agent.
   *
   * Every failure is contained: `agent/created` is a serial event, so a throw
   * here would fail agent creation, and a config edit must never break a turn.
   *
   * @param {import('@deepseek-ai/cordis').Agent} agent - live agent.
   * @returns {void}
   */
  const applyTo = (agent) => {
    let thresholdRatio
    try {
      thresholdRatio = readThresholdRatio(config)
    } catch (error) {
      ctx.logger.warn(`dsh-compaction-threshold: unusable config value: ${error.message}`)
      return
    }

    let engine
    try {
      engine = resolveEngine(ctx, agent)
    } catch (error) {
      ctx.logger.warn(`dsh-compaction-threshold: cannot read the compaction service: ${error.message}`)
      return
    }
    if (!isBasicEngine(engine)) {
      ctx.logger.debug('dsh-compaction-threshold: this preset exposes no basic compaction engine')
      return
    }
    try {
      overrideThreshold(engine, thresholdRatio, ctx)
    } catch (error) {
      // A frozen or accessor-backed config means the engine shape changed; keep
      // the session running on its original threshold instead of failing the turn.
      ctx.logger.warn(`dsh-compaction-threshold: cannot override threshold: ${error.message}`)
    }
  }

  /**
   * Apply the live threshold to every agent currently in the registry.
   *
   * @param {string} reason - what asked for the re-apply, for the debug log.
   * @returns {void}
   */
  const applyToLiveAgents = (reason) => {
    const agents = ctx.get('agents')
    if (typeof agents?.list !== 'function') {
      ctx.logger.debug(
        `dsh-compaction-threshold: no agents service while applying on ${reason}; `
        + 'agents created before activation keep their threshold',
      )
      return
    }
    for (const agent of agents.list()) applyTo(agent)
  }

  ctx.on('agent/created', ({ agent }) => {
    applyTo(agent)
  })

  ctx.on('loader/volatile-update', () => {
    applyToLiveAgents('volatile config update')
  })

  // Agents created before this plugin activated (for example after a plugin
  // reload) are already mounted, so they receive the current value once here.
  applyToLiveAgents('activation')
}
