/**
 * Browser half of `dsh-compaction-threshold`: the configuration page of the
 * bundle's `compaction-threshold` row on the Web Plugins page.
 *
 * The row's settings namespace is its Loader entry id, so this page edits the
 * same document section the Loader reads when it applies `config.thresholdRatio`.
 * Everything the page shows is registered while the Host serves that namespace,
 * and a save is the only write.
 */
window.__ModuleLoader__.load({
  id: 'dsh-compaction-threshold',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      SettingsForm, SettingsFormModel, SettingsValueField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Settings namespace of the row: the Loader entry id the bundle's patch declares. */
    const SETTINGS_NS = 'compaction-threshold'
    /** Registration key of a row's configuration: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-compaction-threshold#compaction-threshold'
    /** Config field this page edits. */
    const FIELD = 'thresholdRatio'
    /** Dictionary namespace owned by this plugin. */
    const NS = 'compactionThreshold'

    /** English copy. */
    const en = {
      summary: 'Set the context pressure at which automatic compaction starts.',
      ratioLabel: 'Compaction threshold ratio',
      ratioHint: 'Context-window fraction in (0, 1] at which automatic compaction starts; 0.5 starts at half full.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidRatio: 'Enter a number greater than 0 and at most 1, or leave blank to use the default.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept this value; it was left for you to correct.',
    }

    /** Simplified Chinese copy. */
    const zh = {
      summary: '设置自动上下文压缩开始时的上下文压力阈值。',
      ratioLabel: '压缩阈值比例',
      ratioHint: '上下文窗口占用达到该比例（大于 0 且不超过 1）时开始自动压缩；0.5 表示占用一半时开始。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidRatio: '请填大于 0 且不超过 1 的数字；留空表示使用默认值。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这个值，已保留供你修改。',
    }

    /**
     * The staged field's conversion spec: an empty draft clears the override so
     * the field re-inherits the composition default, and any other draft must be
     * a number in (0, 1]. The Host schema validates the same range again; a
     * value it rejects leaves the draft in place with the failure shown.
     * @returns {object} the field spec `SettingsFormModel` stages over.
     */
    function thresholdRatioField() {
      return {
        field: FIELD,
        format: value => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          const parsed = Number(trimmed)
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return undefined
          return { kind: 'set', value: parsed }
        },
      }
    }

    /**
     * The row's configuration page: the staged ratio field over the shared form,
     * its in-place validation and save feedback, and the page's own save control.
     * @param {object} props - owner `view`, locale `t`, the bound form snapshot, and its actions.
     * @returns {object|string} the form, or the one-liner the row page asks for.
     */
    function ThresholdRowPage(props) {
      const { t } = props
      const state = props.useThresholdForm(snapshot => snapshot)
      if (props.view === 'summary') return t('summary')
      return h(SettingsForm, {
        labels: {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        },
        state,
        onSave: props.save,
        onDiscard: props.discard,
      }, h(SettingsValueField, {
        id: 'plugin-config-compaction-threshold-ratio',
        label: t('ratioLabel'),
        hint: t('ratioHint'),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidRatio'),
        numeric: true,
        disabled: !state.writable,
        text: state.thresholdRatio.text,
        overridden: state.thresholdRatio.overridden,
        invalid: state.thresholdRatio.invalid,
        onEdit: (text) => { props.edit(FIELD, text) },
        onReset: () => { props.resetField(FIELD) },
      }))
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      /**
       * Register the row's dictionary and its configuration page.
       * @param {object} ctx - the browser plugin context.
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-compaction-threshold: dictionaries')

        // The shared form for the row's Loader entry id owns the accepted values
        // and the revision-fenced write queue; the model stages the draft and
        // writes it only on save.
        const model = new SettingsFormModel(ctx.configForms.get(SETTINGS_NS), [thresholdRatioField()])
        const store = model.bind(() => ({ ...model.shell(), [FIELD]: model.field(FIELD) }))
        ctx.effect(() => () => { model.dispose() }, 'dsh-compaction-threshold: form subscription')

        // `plugins.row.config` gives the bundle's row a Configure control that
        // opens this page; the contribution exists only while the Host serves
        // the row's settings namespace.
        ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
          inject: () => ({ hooks: { thresholdForm: store }, ...model.actions() }),
        }, ThresholdRowPage))), 'dsh-compaction-threshold: row configuration page')
      },
    }
  },
})
