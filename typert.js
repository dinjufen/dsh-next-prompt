/**
 * Host-face Typert manifest for `nextPrompt/suggest`, the hand-written
 * equivalent of a generated artifact. Built at activation because the Harness
 * runtime packages (Typert protocol, Zod) are only reachable through the Loader.
 */
import { PACKAGE, remoteSpec } from './remote.js'

const SUGGEST_DOC = 'Predict the next user prompt for a Session whose last turn has finished.'

/**
 * @param createTypertRemoteInfo - from `@deepseek-ai/dsh-typert-protocol`.
 * @param z - Zod namespace.
 * @returns manifest accepted by `ctx.typert.register()`.
 */
export function createManifest(createTypertRemoteInfo, z) {
  const $remote = createTypertRemoteInfo(remoteSpec(z), z)
  return {
    package: PACKAGE,
    face: 'host',
    schemas: [],
    get invocations() { return $remote.descriptors },
    get descriptors() { return $remote.descriptors },
    model: {
      services: [{
        description: 'Predicts the next user prompt from the finished conversation.',
        summary: 'Predicts the next user prompt from the finished conversation.',
        tags: [],
        jsDoc: '/** Predicts the next user prompt from the finished conversation. */',
        key: 'nextPrompt',
        exportName: 'default',
        members: [{
          kind: 'method',
          name: 'suggest',
          signature: '@Remote async suggest(request: SuggestionRequest, signal: AbortSignal): Promise<SuggestionResult>',
          summary: SUGGEST_DOC,
          jsDoc: `/** ${SUGGEST_DOC} */`,
        }],
        types: [
          { name: 'SuggestionRequest', declaration: 'export interface SuggestionRequest {\n    readonly sessionId: string;\n}' },
          { name: 'SuggestionResult', declaration: 'export interface SuggestionResult {\n    text: string | null;\n    reason: string;\n}' },
        ],
      }],
      events: [],
      objects: [],
    },
  }
}
