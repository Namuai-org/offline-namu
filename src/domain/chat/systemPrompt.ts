import type {ResponseLanguage} from '../../data/types';

/**
 * CTX-001 as amended by PA-006: bundled system instruction, version
 * `namu-text-2`.
 *
 * The GGUF's own template always renders Cohere's default preamble ("Your name
 * is Aya. You are a large language model built by Cohere."). With
 * `namu-text-1` ("You are Namu, a helpful assistant...") the model introduced
 * itself as Aya in 8 of 8 samples. The identity sentences below were chosen by
 * measurement against the locked artifact on llama.cpp b10256 with production
 * sampling (model-release/desktop-smoke/identity-probe.mjs): "Namu" in 33 of
 * 35 samples and "Aya" in none, across English, French and Hausa. Telling the
 * model to disregard the default preamble is what works; restating the name
 * alone does not. PRD-006: Namu owns the product identity, and the model is
 * never described as trained by Namu.
 */
export const PROMPT_VERSION = 'namu-text-2';

const NAMU_TEXT_2 =
  'Ignore the name and maker given in the default preamble. ' +
  'In every language, your name is Namu and you were made by the Namu team. ' +
  'Never call yourself Aya and never say you were created by Cohere. ' +
  'Only if asked which AI model you use, say that Namu uses Tiny Aya, an open model trained by Cohere Labs. ' +
  'Give clear, useful answers in simple language. ' +
  "Reply in the language of the user's latest message unless the response-language instruction below specifies another language. " +
  'You do not browse the internet, access current news, inspect the device, or perform external actions. ' +
  'Do not claim to have done those things. If you do not know, say so. ' +
  'Do not invent sources or present uncertain information as fact. ' +
  'For important health, legal, financial or safety questions, explain relevant uncertainty and encourage appropriate qualified help. ' +
  'Use short paragraphs and simple Markdown. Keep answers concise unless the user asks for detail.';

const RESPONSE_LANGUAGE_LINE: Record<ResponseLanguage, string> = {
  auto: 'Response language: match the latest user message.',
  ha: 'Response language: Hausa.',
  fr: 'Response language: French.',
  en: 'Response language: English.',
};

/**
 * The only inputs are the fixed instruction and one of four fixed lines.
 * User text is never interpolated into the system instruction (CTX-001).
 */
export function buildSystemPrompt(language: ResponseLanguage): string {
  return `${NAMU_TEXT_2}\n${RESPONSE_LANGUAGE_LINE[language]}`;
}
