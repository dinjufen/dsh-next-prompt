window.__ModuleLoader__.load({
  id: 'dsh-next-prompt',
  factory(require) {
    const React = require('react')
    const { z } = require('zod')
    const h = React.createElement
    const PACKAGE = 'dsh-next-prompt'
    const SLOT = 'conversation.input.overlay'

    //#region Typert remote info (copied from @deepseek-ai/dsh-typert-protocol/remote-info, MIT)
    function createTypertRemoteInfo(spec, zod) { return new RemoteInfo(spec, zod) }
    class RemoteInfo {
      constructor(spec, zod) { this.spec = spec; this.zod = zod; this.index = undefined }
      get package() { return this.spec.package }
      get descriptors() { return this.resolve().descriptors }
      get methods() { return this.resolve().methods }
      resolve() {
        if (this.index !== undefined) return this.index
        const zod = this.zod
        const descriptors = []
        const methods = Object.create(null)
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
          const separator = endpoint.indexOf('/')
          const namespace = endpoint.slice(0, separator)
          const method = endpoint.slice(separator + 1)
          const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }))
          const descriptor = {
            ...definition,
            id: `${this.spec.package}#${endpoint}`,
            namespace,
            method,
            parameters,
            result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
          }
          if (definition.invocation.kind === 'direct') {
            const inputs = []
            methods[endpoint] = Object.assign(descriptor, {
              input(options) {
                const strict = options?.strict === true
                return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod)
              },
              invoke(remote, input, signal) {
                const values = parameters.map(parameter => input[parameter.wire])
                if (definition.cancellation !== undefined) values.push(signal)
                const receiver = Reflect.get(remote, namespace)
                const call = Reflect.get(receiver, method)
                return call.apply(receiver, values)
              },
            })
          }
          descriptors.push(descriptor)
        }
        return this.index = { descriptors, methods }
      }
    }
    const optional = parameter => parameter.source === 'json' && parameter.acceptsUndefined === true
    class NamedInput {
      constructor(parameters, strict, zod) { this.parameters = parameters; this.strict = strict; this.zod = zod }
      codec(parameter) { return this.strict ? parameter.strictCodec : parameter.codec }
      create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map(parameter => {
        const value = this.codec(parameter).create()
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()]
      })))
      get jsonSchema() { return this.project().jsonSchema }
      get jsonSchemaError() { return this.project().jsonSchemaError }
      project() {
        if (this.projection !== undefined) return this.projection
        const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined)
        if (unavailable !== undefined) return this.projection = { jsonSchemaError: `No JSON Schema for parameter ${unavailable.wire}` }
        return this.projection = {
          jsonSchema: {
            type: 'object',
            properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
              ...this.codec(parameter).jsonSchema,
              ...(parameter.description === undefined ? {} : { description: parameter.description }),
            }])),
            required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
            additionalProperties: false,
          },
        }
      }
    }
    class ResultValue {
      constructor(spec) { this.spec = spec }
      get mode() { return this.spec.mode }
      get typeSymbol() { return this.spec.typeSymbol }
      get create() { return this.spec.create }
      get decode() { return this.spec.decode }
      get encode() { return this.spec.encode }
      get description() { return this.spec.description }
      get jsonSchemaError() { return this.spec.jsonSchemaError }
      get jsonSchema() {
        if (this.projection === undefined) {
          const schema = this.spec.jsonSchema
          this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } }
        }
        return this.projection.value
      }
    }
    //#endregion

    //#region Remote spec (mirrors remote.js on the Host)
    const REQUEST_JSON = {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Session whose finished turn is used as context.' } },
      required: ['sessionId'],
    }
    const RESULT_JSON = {
      type: 'object',
      properties: { text: { type: ['string', 'null'] }, reason: { type: 'string' } },
      required: ['text', 'reason'],
    }
    let requestSchema, strictRequestSchema, resultSchema
    const TYPERT_REMOTE = createTypertRemoteInfo({
      package: PACKAGE,
      methods: {
        'nextPrompt/suggest': {
          service: 'nextPrompt',
          description: 'Predict the next user prompt for a Session whose last turn has finished.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request',
            description: 'Session identity.',
            source: 'json',
            codec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE}/types#SuggestionRequest`,
              create: () => (requestSchema ??= z.object({ sessionId: z.string() })),
              jsonSchema: { ...REQUEST_JSON, additionalProperties: true },
            },
            strictCodec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE}/types#SuggestionRequest`,
              create: () => (strictRequestSchema ??= z.strictObject({ sessionId: z.string() })),
              jsonSchema: { ...REQUEST_JSON, additionalProperties: false },
            },
          }],
          cancellation: { parameter: 'signal' },
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#nextPrompt/suggest:result`,
            create: () => (resultSchema ??= z.object({ text: z.string().nullable(), reason: z.string() })),
            description: 'Suggestion text, or null with the suppression reason.',
            jsonSchema: RESULT_JSON,
          },
        },
      },
    }, z)
    //#endregion

    /** Last suggestion per Session, so switching away and back keeps it until the next turn starts. */
    const bySession = new Map()

    /** Loader entry id of the Host plugin; also its settings namespace. */
    const ENTRY = 'next-prompt'
    const NS = 'next-prompt'
    const zh = {
      'hint.accept': '接受建议',
      'hint.dismiss': '关闭本次建议',
      'settings.title': '提示词建议',
      'settings.description': '每轮回复结束后预测你接下来可能输入的内容，显示在输入框上方，按 Tab 接受。',
    }
    const en = {
      'hint.accept': 'Accept suggestion',
      'hint.dismiss': 'Dismiss this suggestion',
      'settings.title': 'Prompt suggestions',
      'settings.description': 'After each turn, predict what you are likely to type next and show it above the composer. Press Tab to accept.',
    }

    const STYLE = `
.lps-hint{position:absolute;left:12px;right:12px;bottom:8px;display:flex;align-items:center;min-width:0;
  pointer-events:none;font-size:13px;line-height:20px}
.lps-chip{display:inline-flex;align-items:center;min-width:0;max-width:100%;pointer-events:auto;
  border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-secondary)}
.lps-accept{display:inline-flex;align-items:center;gap:8px;min-width:0;padding:3px 4px 3px 6px;cursor:pointer;
  border:0;border-radius:999px 0 0 999px;background:transparent;color:inherit;font:inherit;text-align:left}
.lps-accept:hover{color:var(--dsw-alias-label-primary)}
.lps-key{flex:none;padding:0 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);
  color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.lps-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lps-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin:0 4px 0 2px;
  padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.lps-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.lps-close:focus-visible,.lps-accept:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}`

    const ROW_STYLE = `
.lps-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}
.lps-row-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}
.lps-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.lps-row-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.lps-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;
  background:var(--dsw-alias-border-l3);cursor:pointer}
.lps-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.lps-switch:disabled{cursor:default;opacity:.5}
.lps-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.lps-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.lps-switch[aria-checked=false] .lps-thumb{background:var(--dsw-alias-switch-thumb)}
.lps-switch[aria-checked=true] .lps-thumb{transform:translate(16px)}`

    function isPlainTab(gesture) {
      return gesture.code === 'Tab' && !gesture.shift && !gesture.control && !gesture.alt && !gesture.meta && !gesture.composing && !gesture.repeat
    }

    /**
     * The `enabled` preference, read from the Host settings document (default on).
     * Writes go through the shared configuration form, so the Host plugin sees them live.
     */
    function createEnabledPreference(ctx) {
      const form = ctx.configForms.get(ENTRY)
      const read = () => form?.getSnapshot()?.value?.enabled !== false
      let current = read()
      const listeners = new Set()
      const unsubscribe = form?.subscribe(() => {
        const next = read()
        if (next === current) return
        current = next
        for (const listener of listeners) listener()
      })
      return {
        getSnapshot: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        writable: () => form !== undefined && form.getSnapshot()?.writable !== false,
        async set(enabled) {
          if (form === undefined) return
          await form.set('enabled', enabled)
        },
        dispose: () => unsubscribe?.(),
      }
    }

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', fill: 'none' }))
    }

    function registerUi(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'next-prompt: dictionaries')
      const enabled = createEnabledPreference(ctx)
      ctx.effect(() => () => enabled.dispose(), 'next-prompt: preference subscription')

      function SuggestionHint(props) {
        const { sessionId, useSession, useInput, inputActions, t } = props
        const on = React.useSyncExternalStore(enabled.subscribe, enabled.getSnapshot)
        const running = useSession(session => session?.running === true)
        const draftEmpty = useInput(input => (input?.draft ?? '') === '' && (input?.attachmentIds?.length ?? 0) === 0)
        const editable = useInput(input => input?.phase !== 'submitting' && input?.phase !== 'adjudicating')
        const [text, setText] = React.useState(() => bySession.get(sessionId) ?? null)
        const sawRunning = React.useRef(running)
        const root = React.useRef(null)

        // A turn ending (running -> idle) asks the Host for one prediction.
        React.useEffect(() => {
          if (running) {
            sawRunning.current = true
            bySession.delete(sessionId)
            setText(null)
            return
          }
          if (!sawRunning.current) return
          sawRunning.current = false
          if (!enabled.getSnapshot()) return
          const controller = new AbortController()
          ctx.remote.nextPrompt.suggest({ sessionId }, controller.signal).then(result => {
            if (controller.signal.aborted) return
            if (!result.ok) {
              console.warn('[next-prompt] request failed', result.error)
              return
            }
            if (result.value.text === null) {
              console.debug('[next-prompt] suppressed:', result.value.reason)
              return
            }
            bySession.set(sessionId, result.value.text)
            setText(result.value.text)
          }, error => {
            if (!controller.signal.aborted) console.warn('[next-prompt] request failed', error)
          })
          return () => controller.abort()
        }, [running, sessionId])

        const visible = on && text !== null && draftEmpty && editable && !running

        const accept = React.useCallback(() => {
          if (text === null) return false
          const span = inputActions.captureInsertion()
          const inserted = inputActions.insertText(text, span)
          if (!inserted) inputActions.setDraft(text)
          return true
        }, [text, inputActions])

        // Dropping the suggestion also drops the Tab binding below, so Tab is native again until the next turn.
        const dismiss = React.useCallback(() => {
          bySession.delete(sessionId)
          setText(null)
          inputActions.focus?.()
        }, [sessionId, inputActions])

        // Tab in this composer's editor accepts the suggestion; other Tab uses are untouched.
        React.useEffect(() => {
          if (!visible) return
          return ctx.shortcuts.observeFixedInput(input => {
            if (input.type !== 'keydown' || input.gesture.defaultPrevented || !isPlainTab(input.gesture)) return
            if (input.context.region !== 'editable' || input.context.modal !== null) return
            // The overlay anchor sits directly inside the composer card.
            const card = root.current?.closest('[data-composer-overlay]')?.parentElement
            if (!card || !(input.context.target instanceof Node) || !card.contains(input.context.target)) return
            if (accept()) input.consume()
          })
        }, [visible, accept])

        if (!visible) return null
        // Both buttons keep editor focus on press; they are pointer shortcuts for Tab and dismissal.
        const keepFocus = event => event.preventDefault()
        return h('div', { ref: root, className: 'lps-hint', 'data-next-prompt': true },
          h('style', null, STYLE),
          h('div', { className: 'lps-chip' },
            h('button', {
              type: 'button',
              className: 'lps-accept',
              title: text,
              'aria-label': `${t('hint.accept')}: ${text}`,
              onMouseDown: keepFocus,
              onClick: () => {
                accept()
                inputActions.focus?.()
              },
            },
            h('span', { className: 'lps-key' }, 'Tab'),
            h('span', { className: 'lps-text' }, text)),
            h('button', {
              type: 'button',
              className: 'lps-close',
              title: t('hint.dismiss'),
              'aria-label': t('hint.dismiss'),
              onMouseDown: keepFocus,
              onClick: dismiss,
            }, h(CloseIcon))))
      }

      function SettingsRow({ useEnabled, setEnabled, t }) {
        const on = useEnabled(value => value)
        const [pending, setPending] = React.useState(false)
        const toggle = () => {
          setPending(true)
          setEnabled(!on).catch(error => {
            console.warn('[next-prompt] saving the setting failed', error)
          }).finally(() => setPending(false))
        }
        return h('div', { className: 'lps-row' },
          h('style', null, ROW_STYLE),
          h('div', { className: 'lps-row-text' },
            h('div', { className: 'lps-row-title' }, t('settings.title')),
            h('div', { className: 'lps-row-desc' }, t('settings.description'))),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': on,
            'aria-label': t('settings.title'),
            className: 'lps-switch',
            disabled: pending || !enabled.writable(),
            onClick: toggle,
          }, h('span', { className: 'lps-thumb' })))
      }

      ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: 'next-prompt', order: 50, locale: NS }, SuggestionHint))
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'next-prompt',
        order: 25,
        locale: NS,
        inject: () => ({
          hooks: { enabled },
          setEnabled: value => enabled.set(value),
        }),
      }, SettingsRow))
    }

    const SERVICES = ['slots', 'remote', 'shortcuts', 'configForms', 'locale']

    return {
      inject: SERVICES,
      async apply(ctx) {
        const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
        const ui = ctx.inject(['remote.nextPrompt', ...SERVICES.filter(name => name !== 'remote')], child => registerUi(child))
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          await unmountRemote()
          throw error
        }
        return async () => {
          await ui.dispose()
          await unmountRemote()
        }
      },
    }
  },
})
