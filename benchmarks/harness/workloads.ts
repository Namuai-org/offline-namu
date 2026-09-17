import type {ChatMessage} from '../../src/domain/inference/InferenceEngine';
import {buildSystemPrompt} from '../../src/domain/chat/systemPrompt';

/**
 * QA-002 fixed workloads. Text is constant so the fixture hash in every result
 * (OBS-003) identifies exactly what was measured. No user content.
 */
export type WorkloadLanguage = 'ha' | 'fr' | 'en';

const SHORT: Record<WorkloadLanguage, string> = {
  ha: 'Me ya sa ake samun ruwan sama a damina? Ka amsa a taƙaice.',
  fr: 'Pourquoi pleut-il pendant la saison des pluies ? Réponds brièvement.',
  en: 'Why does it rain during the rainy season? Answer briefly.',
};

const PARAGRAPH: Record<WorkloadLanguage, string> = {
  ha: 'Manoma a yankin Sahel suna dogara da damina domin shuka gero, dawa da wake. Idan ruwan sama ya yi jinkiri, sukan jinkirta shuka, kuma hakan na iya rage yawan amfanin gona. ',
  fr: 'Dans le Sahel, les agriculteurs dépendent de la saison des pluies pour semer le mil, le sorgho et le niébé. Quand les pluies tardent, ils retardent les semis, ce qui peut réduire les récoltes. ',
  en: 'Farmers in the Sahel depend on the rainy season to sow millet, sorghum and cowpea. When the rains arrive late they delay sowing, which can reduce the harvest. ',
};

const ASK_SUMMARY: Record<WorkloadLanguage, string> = {
  ha: 'Taƙaita wannan rubutu cikin jimloli uku: ',
  fr: 'Résume ce texte en trois phrases : ',
  en: 'Summarize this text in three sentences: ',
};

export interface Workload {
  id: string;
  language: WorkloadLanguage;
  messages: ChatMessage[];
}

function system(language: WorkloadLanguage): ChatMessage {
  return {role: 'system', content: buildSystemPrompt(language)};
}

export function shortPrompt(language: WorkloadLanguage): Workload {
  return {id: `short-${language}`, language, messages: [system(language), {role: 'user', content: SHORT[language]}]};
}

/** Roughly 512 tokens of user content; the measured formatted count is recorded with the result. */
export function mediumPrompt(language: WorkloadLanguage): Workload {
  return {
    id: `medium-${language}`,
    language,
    messages: [system(language), {role: 'user', content: ASK_SUMMARY[language] + PARAGRAPH[language].repeat(9)}],
  };
}

/**
 * Near-budget prompt: grown by the harness until one more paragraph would
 * exceed the 1,632-token ceiling, using the engine's own count.
 */
export function nearBudgetSeed(language: WorkloadLanguage): {prefix: string; unit: string; system: ChatMessage} {
  return {prefix: ASK_SUMMARY[language], unit: PARAGRAPH[language], system: system(language)};
}

/** 20-turn chat: scripted user turns; the model's own answers become context. */
export function twentyTurnScript(language: WorkloadLanguage): string[] {
  const follow: Record<WorkloadLanguage, string[]> = {
    ha: ['Ka ƙara bayani kaɗan.', 'Ba ni misali ɗaya.', 'Ka taƙaita abin da ka faɗa.', 'Me ya kamata in yi da farko?'],
    fr: ['Explique un peu plus.', 'Donne-moi un exemple.', 'Résume ce que tu as dit.', 'Que dois-je faire en premier ?'],
    en: ['Explain a little more.', 'Give me one example.', 'Summarize what you said.', 'What should I do first?'],
  };
  const turns = [SHORT[language]];
  for (let i = 1; i < 20; i++) {
    turns.push(follow[language][i % follow[language].length]!);
  }
  return turns;
}

export const MIXED_AND_EMOJI: Workload = {
  id: 'mixed-emoji',
  language: 'en',
  messages: [
    system('en'),
    {role: 'user', content: 'Sannu 👋🏾! Je veux savoir: yaya ake dafa shinkafa 🍚 da wake? Please answer in simple English. Merci 🙏'},
  ],
};
