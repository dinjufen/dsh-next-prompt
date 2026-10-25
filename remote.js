/**
 * Typert Remote definition for `nextPrompt/suggest`, shared by the Host
 * manifest. The browser module carries its own copy of the same spec.
 */
export const PACKAGE = 'dsh-next-prompt'

const REQUEST_JSON = {
  type: 'object',
  properties: { sessionId: { type: 'string', description: 'Session whose finished turn is used as context.' } },
  required: ['sessionId'],
}
const RESULT_JSON = {
  type: 'object',
  properties: {
    text: { type: ['string', 'null'], description: 'Predicted next prompt, or null when nothing is suggested.' },
    reason: { type: 'string', description: 'Why the suggestion was produced or suppressed.' },
  },
  required: ['text', 'reason'],
}

/**
 * Build the Remote spec with the caller's Zod runtime.
 * @param z - Zod namespace.
 * @returns spec accepted by `createTypertRemoteInfo`.
 */
export function remoteSpec(z) {
  let request, strictRequest, result
  return {
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
            create: () => (request ??= z.object({ sessionId: z.string() })),
            jsonSchema: { ...REQUEST_JSON, additionalProperties: true },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#SuggestionRequest`,
            create: () => (strictRequest ??= z.strictObject({ sessionId: z.string() })),
            jsonSchema: { ...REQUEST_JSON, additionalProperties: false },
          },
        }],
        cancellation: { parameter: 'signal' },
        result: {
          mode: 'strict',
          typeSymbol: `${PACKAGE}#nextPrompt/suggest:result`,
          create: () => (result ??= z.object({ text: z.string().nullable(), reason: z.string() })),
          description: 'Suggestion text, or null with the suppression reason.',
          jsonSchema: RESULT_JSON,
        },
      },
    },
  }
}
