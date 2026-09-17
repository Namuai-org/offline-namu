import {graphemeLength, truncateGraphemes} from '../text/graphemes';

export const GENERATED_TITLE_GRAPHEMES = 48;
export const RENAME_MIN_GRAPHEMES = 1;
export const RENAME_MAX_GRAPHEMES = 80;

/** Collapses every whitespace run (including newlines) to one space. */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * CHAT-007: the first 48 grapheme clusters of the initial user message,
 * normalized to one line. No model-generated titles in v1.
 */
export function titleFromFirstMessage(userText: string): string {
  return truncateGraphemes(toSingleLine(userText), GENERATED_TITLE_GRAPHEMES);
}

export type RenameValidation = {ok: true; title: string} | {ok: false; reason: 'empty' | 'tooLong'};

/** S05: rename length is 1–80 grapheme clusters. */
export function validateRename(input: string): RenameValidation {
  const title = toSingleLine(input);
  const length = graphemeLength(title);
  if (length < RENAME_MIN_GRAPHEMES) {
    return {ok: false, reason: 'empty'};
  }
  if (length > RENAME_MAX_GRAPHEMES) {
    return {ok: false, reason: 'tooLong'};
  }
  return {ok: true, title};
}
