import type {ChatMessage} from '../../domain/inference/InferenceEngine';

/**
 * DL-011 fixed self-test fixture. Contains no user content. The text is a
 * constant so the deterministic sampler (seed 42, greedy) produces a stable
 * token sequence for a given artifact and runtime build.
 *
 * Note: the locked template always renders Cohere's upstream preamble, so the
 * total formatted prompt is larger than this fixture; the measured count is
 * recorded in diagnostics and in docs/engineering/runtime-contract.md.
 */
export const SELF_TEST_FIXTURE_VERSION = 'namu-selftest-1';

export const SELF_TEST_MESSAGES: ChatMessage[] = [
  {
    role: 'system',
    content: 'You are a concise assistant. Answer in plain English with one short sentence.',
  },
  {
    role: 'user',
    content:
      'This is an installation check that contains no personal information. ' +
      'Water is a clear liquid that people, animals and plants need to live. It falls as rain, ' +
      'collects in rivers, lakes and wells, and returns to the air when the sun warms it. ' +
      'Farmers depend on it for crops, families use it for cooking and washing, and clean ' +
      'drinking water protects health. Many communities store water in tanks or clay pots so ' +
      'that it stays cool and available during the dry season. ' +
      'In one short sentence, say why clean water matters.',
  },
];
