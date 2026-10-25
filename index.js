/**
 * Host half of the next-prompt bundle.
 *
 * After a turn ends, the Client calls `nextPrompt.suggest({ sessionId })`.
 * The Host forks the exact model request the agent last sent (same request
 * header, same derived messages, same tools), appends one suggestion
 * instruction as a final user message, and asks the same route for a short
 * prediction. Because the prefix is byte-identical to the main request,
 * DeepSeek's context cache serves almost all input tokens. Nothing is written
 * to the Session log, so the model never sees the suggestion request.
 *
 * `enabled` is a volatile field: the Settings row in the Client writes it
 * through the Host settings service and the running plugin reads the new value
 * without a restart.
 */
import { importShipped } from './shipped.js'
import { SUGGESTION_INSTRUCTION, cleanSuggestion, rejectReason } from './suggestion.js'
import { createManifest } from './typert.js'

const [protocol, { createUserMessage }, zod, { default: Schema }] = await Promise.all([
  importShipped('@deepseek-ai/dsh-typert-protocol'),
  importShipped('@deepseek-ai/dsh-llm'),
  importShipped('zod'),
  importShipped('@deepseek-ai/schemastery'),
])
const z = zod.z ?? zod.default ?? zod

export const name = 'next-prompt'
export const inject = ['llm', 'sessions', 'typert']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile().description('Show a predicted next prompt after each turn.'),
  maxOutputTokens: Schema.natural().min(8).default(64).description('Output token cap for one suggestion.'),
  timeoutMs: Schema.natural().min(1000).default(20000).description('End-to-end deadline for one suggestion request.'),
  includeTools: Schema.boolean().default(true).description('Send the main request\'s tool definitions so the prompt prefix (and the KV cache) matches.'),
  provider: Schema.string().description('Optional route override; set together with model.'),
  model: Schema.string().description('Optional route override; set together with provider.'),
  debug: Schema.boolean().default(false).description('Print token usage of each suggestion request to the Host terminal.'),
})

/** Read a volatile field, which arrives as a live reference rather than a plain value. */
const live = value => (typeof value?.get === 'function' ? value.get() : value)

const none = reason => ({ text: null, reason })

/** Resolve a promise unless the caller's signal aborts first; the shared work keeps running. */
function untilAborted(promise, signal) {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Generate one suggestion from a Session whose last turn has finished.
 * @param ctx - context exposing `llm`.
 * @param config - resolved plugin configuration.
 * @param session - live Session.
 * @param signal - cancellation for this generation.
 */
async function generate(ctx, config, session, signal) {
  const messages = session.deriveMessages()
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'assistant') return none('not-at-turn-end')
  if (last.content.some(block => block.type === 'tool-call')) return none('not-at-turn-end')
  if (!last.content.some(block => block.type === 'text' && block.text.trim() !== '')) return none('no-assistant-text')
  if (!messages.some(message => message.role === 'user')) return none('no-user-message')

  const header = session.requestHeader()
  if (header === undefined) return none('no-request-header')

  const { maxOutputTokens, timeoutMs, includeTools, provider, model } = config
  const override = provider && model ? { provider, model } : undefined
  // Same route and controls as the main request unless overridden; only the output cap changes.
  const proposal = override !== undefined ? { ...override, maxTokens: maxOutputTokens } : { ...header.config, maxTokens: maxOutputTokens }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const call = await ctx.llm.prepareCall(proposal, deadline, (controls, info) => {
    const least = info?.reasoning?.efforts?.[0]?.id
    return { ...controls, maxTokens: maxOutputTokens, ...(least === undefined ? {} : { reasoningEffort: least }) }
  })

  const instruction = createUserMessage({
    content: [{ type: 'text', text: SUGGESTION_INSTRUCTION }],
    source: { kind: 'dsh-next-prompt' },
  })
  const options = {
    ...call.config,
    messages: [...messages, instruction],
    toolHistory: session.toolHistory(),
    ...(includeTools && override === undefined && header.tools !== undefined ? { tools: header.tools } : {}),
    sessionId: session.id,
    purpose: 'next-prompt',
    signal: deadline,
  }

  let text = ''
  let finish
  let usage
  for await (const chunk of call.stream(options)) {
    deadline.throwIfAborted()
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'tool-call-delta') return none('tool-call')
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (config.debug) console.error('[next-prompt] usage', JSON.stringify(usage), 'text', JSON.stringify(text))
  if (finish?.kind === 'error' || finish?.kind === 'aborted') return none(`finish-${finish.kind}`)
  if (finish?.kind === 'max-tokens') return none('max-tokens')

  const candidate = cleanSuggestion(text)
  const rejected = rejectReason(candidate)
  ctx.logger.info('candidate %s -> %s', JSON.stringify(candidate), rejected ?? 'ok')
  return rejected === undefined ? { text: candidate, reason: 'ok' } : none(rejected)
}

export function apply(ctx, config) {
  const { Remote, TypertRemoteService, createTypertRemoteInfo } = protocol

  // The Client renders its own Settings row, so the generic form is not generated.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  /** Instance initializers produced by the `@Remote` marker (decorator applied by hand). */
  const remoteInitializers = []

  class PromptSuggestionController extends TypertRemoteService {
    constructor(serviceCtx) {
      super(serviceCtx, 'nextPrompt')
      /** One in-flight or settled generation per Session, keyed by the log length it was built from. */
      this.latest = new Map()
      for (const initializer of remoteInitializers) initializer.call(this)
      serviceCtx.effect(() => () => {
        for (const entry of this.latest.values()) entry.controller.abort()
        this.latest.clear()
      }, 'next-prompt: cancel pending generations')
    }

    /**
     * Predict the next user prompt for a Session whose last turn has finished.
     * @param request - Session identity.
     * @param signal - caller cancellation; it stops this caller's wait, not the shared generation.
     * @returns suggestion text, or null with the suppression reason.
     */
    async suggest(request, signal) {
      if (live(config.enabled) === false) {
        for (const entry of this.latest.values()) entry.controller.abort()
        this.latest.clear()
        return none('disabled')
      }
      const session = ctx.sessions.get(request.sessionId)
      if (session === undefined) return none('session-inactive')
      const key = session.seq
      let entry = this.latest.get(session.id)
      if (entry === undefined || entry.key !== key) {
        entry?.controller.abort()
        const controller = new AbortController()
        entry = {
          key,
          controller,
          promise: generate(ctx, config, session, controller.signal).catch(error => {
            ctx.logger.warn('suggestion failed: %s', error?.message ?? error)
            return none(controller.signal.aborted ? 'aborted' : 'error')
          }),
        }
        this.latest.set(session.id, entry)
      }
      return await untilAborted(entry.promise, signal)
    }
  }

  Remote(PromptSuggestionController.prototype.suggest, {
    kind: 'method',
    name: 'suggest',
    static: false,
    private: false,
    addInitializer: initializer => remoteInitializers.push(initializer),
  })

  ctx.typert.register(createManifest(createTypertRemoteInfo, z))
  ctx.plugin(PromptSuggestionController)
}
