/**
 * Runtime override for the automatic compaction pressure threshold used by
 * `@deepseek-ai/dsh-compaction-basic`.
 *
 * The preset-owned engine keeps its resolved configuration in a frozen object,
 * so this plugin replaces the engine instance's `config` property with a copy
 * carrying the requested ratio. Agent preset declarations stay untouched.
 *
 * @module dsh-compaction-threshold
 */

/** Applied when the row omits `thresholdRatio`. */
const DEFAULT_THRESHOLD_RATIO = 0.5

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
 * Apply the threshold override to every agent created after this plugin loads.
 *
 * `agent/created` fires after the agent's preset generation mounted, so the
 * preset-owned `compaction` service is resolvable from the agent scope.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ thresholdRatio?: number }} [config] - row configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  if (typeof thresholdRatio !== 'number' || !Number.isFinite(thresholdRatio)
    || thresholdRatio <= 0 || thresholdRatio > 1) {
    throw new Error(
      `dsh-compaction-threshold: thresholdRatio (${String(thresholdRatio)}) must be a number in (0, 1]`,
    )
  }

  ctx.on('agent/created', ({ agent }) => {
    const engine = agent.ctx.get('compaction')
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
  })
}
