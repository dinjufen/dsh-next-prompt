/**
 * Pure prompt-suggestion policy: the instruction appended to the forked
 * conversation, and the filter that drops low-quality predictions.
 * No Harness imports, so it can be unit-tested with plain Node.
 */

/** Instruction appended as the final user message of the forked conversation. */
export const SUGGESTION_INSTRUCTION = `[SUGGESTION MODE: Predict what the user would naturally type next into this coding assistant.]

First look at the user's recent messages and original request. Predict what THEY would type, not what you think they should do.
The test: would they think "I was just about to type that"?

Examples:
- User asked "fix the bug and run tests", bug is fixed -> "run the tests"
- After code is written -> "try it out"
- Assistant offers options -> the option the user would most likely pick
- Assistant asks whether to continue -> "yes" or "go ahead"
- Task complete with an obvious follow-up -> "commit this"
- After an error or misunderstanding -> stay silent (let them assess)

Be specific: "run the tests" beats "continue".

Never suggest:
- Evaluations ("looks good", "thanks")
- Questions
- Assistant voice ("Let me...", "I'll...", "Here's...")
- New ideas the user did not ask about
- Multiple sentences

Stay silent if the next step is not obvious from what the user said, or if a suggestion could be unsafe or touch sensitive topics (credentials, security incidents, private data).

Format: 2-12 words (or up to 25 CJK characters), in the user's language and style. Or nothing.
Reply with ONLY the suggestion text, no quotes, labels or explanation. To stay silent, reply with an empty message.`

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_GLOBAL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** Words for Latin text; CJK characters count as half a word each. */
export function wordCount(text) {
  const cjk = (text.match(CJK_GLOBAL) ?? []).length
  const rest = text.replace(CJK_GLOBAL, ' ').trim()
  const words = rest === '' ? 0 : rest.split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length
  return words + Math.ceil(cjk / 2)
}

const SHORT_OK = new Set(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'push', 'commit', 'deploy', 'stop', 'continue', 'check', 'no',
  '好', '好的', '可以', '继续', '提交', '是', '对', '行', '不用', '推送'])

/**
 * Strip wrappers the model sometimes adds: XML-ish tags, quotes, "Suggestion:" labels.
 * @param raw - assembled model text.
 * @returns the bare candidate (may be empty).
 */
export function cleanSuggestion(raw) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^<(suggestion|response|output|answer)>([\s\S]*)<\/\1>$/iu, '$2').trim()
  text = text.replace(/^\s*(suggested\s+(response|reply|input|prompt)|suggestion|response|reply|answer|output|建议|回复|输出|答案)\s*[:：]\s*/iu, '').trim()
  const quoted = /^(["'“‘「『`])([\s\S]*)(["'”’」』`])$/u.exec(text)
  if (quoted) text = quoted[2].trim()
  return text
}

/**
 * Decide whether a cleaned candidate should be dropped.
 * @param text - cleaned candidate.
 * @returns the rejection reason, or undefined when the suggestion is acceptable.
 */
export function rejectReason(text) {
  if (!text) return 'empty'
  const lower = text.toLowerCase()
  const words = wordCount(text)
  if (lower === 'done' || /^(nothing|no suggestion|silence|stay silent)/u.test(lower) || /^\P{L}*(沉默|无建议|没有建议|保持沉默|无)\P{L}*$/u.test(text)) return 'meta_text'
  if (/^[(\[（【].*[)\]）】]$/u.test(text)) return 'meta_wrapped'
  if (/^(api error|prompt is too long|request timed out|invalid api key)/u.test(lower)) return 'error_message'
  if (/\n|\*\*|^#|```/u.test(text)) return 'has_formatting'
  if (text.length >= 100) return 'too_long'
  if (words > 12) return 'too_many_words'
  if (words < 2 && !text.startsWith('/') && !SHORT_OK.has(lower) && !(CJK.test(text) && text.length >= 2)) return 'too_few_words'
  if (/[.!?]\s+[A-Z]|[。！？]\s*[\p{L}\p{N}]/u.test(text)) return 'multiple_sentences'
  if (/[?？]\s*$/u.test(text)) return 'question'
  if (/\b(thanks|thank you|looks good|sounds good|that works|perfect|awesome|great|nice)\b/u.test(lower)
    || /^\P{L}*(谢谢|感谢|多谢|辛苦了?|不错|太好了|完美|很好|好棒)/u.test(text)
    || /(不错|很好|挺好|完美|没问题|太棒了)\P{L}*$/u.test(text)) return 'evaluative'
  if (/^(let me|i'll|i've|i'm|i can|i would|i think|here's|here is|here are|you can|you should|sure,|of course|certainly)/iu.test(text)
    || /^(让我(?!们)|我来|我会|我将|我已|你可以|您可以|好的，我)/u.test(text)) return 'assistant_voice'
  return undefined
}
