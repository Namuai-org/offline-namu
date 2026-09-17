import type {ContextPair} from '../../data/types';
import type {ChatMessage} from '../inference/InferenceEngine';
import {PROMPT_CEILING_TOKENS} from '../inference/productionConfig';

export type TokenCounter = (messages: ChatMessage[]) => Promise<number>;

export type BudgetResult =
  | {
      ok: true;
      messages: ChatMessage[];
      promptTokens: number;
      includedPairs: number;
      /** CTX-004: older saved turns exist that are not part of this prompt. */
      trimmed: boolean;
    }
  | {ok: false; reason: 'INPUT_TOO_LONG'; promptTokens: number};

/**
 * Assembles role messages: system, then complete pairs oldest→newest, then the
 * current user message (CTX-003). `pairsNewestFirst` must already contain only
 * selected, non-empty answers.
 */
export function assembleMessages(
  systemPrompt: string,
  pairsNewestFirst: readonly ContextPair[],
  currentUserText: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{role: 'system', content: systemPrompt}];
  for (let i = pairsNewestFirst.length - 1; i >= 0; i--) {
    const pair = pairsNewestFirst[i]!;
    messages.push({role: 'user', content: pair.userText});
    messages.push({role: 'assistant', content: pair.assistantText});
  }
  messages.push({role: 'user', content: currentUserText});
  return messages;
}

/**
 * CTX-002/003: fit the formatted prompt under the ceiling by dropping the
 * OLDEST pairs. The current user message is never truncated: if system +
 * current message alone exceed the ceiling the send is refused.
 *
 * Token counts come from the engine's own template + tokenizer (INF-002), so
 * the count is exact. Because the formatted length grows monotonically with
 * the number of included pairs, the largest fitting k is found by binary
 * search in O(log n) counting calls.
 */
export async function fitPrompt(input: {
  systemPrompt: string;
  currentUserText: string;
  pairsNewestFirst: readonly ContextPair[];
  /** True when the caller knows more history exists beyond the supplied pairs. */
  moreHistoryAvailable: boolean;
  count: TokenCounter;
  ceiling?: number;
}): Promise<BudgetResult> {
  const ceiling = input.ceiling ?? PROMPT_CEILING_TOKENS;
  const build = (k: number) =>
    assembleMessages(input.systemPrompt, input.pairsNewestFirst.slice(0, k), input.currentUserText);

  const minimal = build(0);
  const minimalTokens = await input.count(minimal);
  if (minimalTokens > ceiling) {
    return {ok: false, reason: 'INPUT_TOO_LONG', promptTokens: minimalTokens};
  }

  const total = input.pairsNewestFirst.length;
  let bestK = 0;
  let bestTokens = minimalTokens;
  if (total > 0) {
    const allTokens = await input.count(build(total));
    if (allTokens <= ceiling) {
      bestK = total;
      bestTokens = allTokens;
    } else {
      let lo = 0; // known to fit
      let hi = total; // known not to fit
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const tokens = await input.count(build(mid));
        if (tokens <= ceiling) {
          lo = mid;
          bestTokens = tokens;
        } else {
          hi = mid;
        }
      }
      bestK = lo;
    }
  }

  return {
    ok: true,
    messages: build(bestK),
    promptTokens: bestTokens,
    includedPairs: bestK,
    trimmed: bestK < total || input.moreHistoryAvailable,
  };
}
