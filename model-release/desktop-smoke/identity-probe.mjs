#!/usr/bin/env node
// PRD-006 / PA-006: measures how the locked model introduces itself under the
// app's REAL system prompt (imported from src/, not copied), with production
// sampling, against llama-server built at the pinned tag (see README.md).
//
//   llama-server -m <model.gguf> -c 2048 -b 256 -ub 128 -t 4 -np 1 --jinja --port 8790
//   node model-release/desktop-smoke/identity-probe.mjs [--url http://127.0.0.1:8790] [--seeds 1,2,3]
//
// Exit code 1 when the model names itself "Aya" in more than 5 % of samples or
// says "Namu" in fewer than 85 % of them (sampling at temperature 0.3 is noisy). This is a mechanical check; fluent readers still
// review the Hausa and French output (LOC-002).
import {parseArgs} from 'node:util';
import {buildSystemPrompt, PROMPT_VERSION} from '../../src/domain/chat/systemPrompt.ts';

const {values: args} = parseArgs({
  options: {url: {type: 'string', default: 'http://127.0.0.1:8790'}, seeds: {type: 'string', default: '1,2,3'}},
});
const QUESTIONS = [
  'Who are you, and who made you?',
  'What is your name?',
  'Wane ne kai?',
  'Menene sunanka?',
  'Qui es-tu ?',
  'Which AI model are you based on?',
  'Are you Aya from Cohere?',
];
const NAMES_ITSELF_AYA = /\b(I'?m|I am|name is|je suis|ni|sunana)\s+\**Aya\b/i;

const seeds = args.seeds.split(',').map(Number);
let namu = 0;
let aya = 0;
let total = 0;
for (const question of QUESTIONS) {
  for (const seed of seeds) {
    const response = await fetch(`${args.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        messages: [{role: 'system', content: buildSystemPrompt('auto')}, {role: 'user', content: question}],
        temperature: 0.3, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: 70, seed, cache_prompt: true,
      }),
    });
    const text = (await response.json()).choices[0].message.content.replace(/\s+/g, ' ');
    total += 1;
    namu += /namu/i.test(text) ? 1 : 0;
    const offender = NAMES_ITSELF_AYA.test(text) || /^\**Aya\b/.test(text);
    aya += offender ? 1 : 0;
    if (offender) {
      console.log(`AYA seed=${seed} [${question}] ${text.slice(0, 200)}`);
    } else if (seed === seeds[0]) {
      console.log(`[${question}] ${text.slice(0, 200)}`);
    }
  }
}
console.log(JSON.stringify({prompt_version: PROMPT_VERSION, samples: total, says_namu: namu, names_itself_aya: aya}));
process.exit(aya / total <= 0.05 && namu / total >= 0.85 ? 0 : 1);
