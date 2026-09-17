import {resolveParameters} from '../../src/domain/inference/productionConfig';

/** Contract-level tests of the adapter against a scripted llama.rn (QA-004). */
type CompletionCallback = (data: {token: string}) => void;
const mockNative = {
  initLlama: jest.fn(),
  completion: jest.fn(),
  stopCompletion: jest.fn(async () => undefined),
  release: jest.fn(async () => undefined),
  clearCache: jest.fn(async () => undefined),
  formatDelayMs: 0,
};

jest.mock('llama.rn', () => ({
  BuildInfo: {number: '10256', commit: 'test'},
  initLlama: (...args: unknown[]) => mockNative.initLlama(...args),
}));

import {LlamaRnEngine} from '../../src/infrastructure/inference/LlamaRnEngine';

function makeContext(gpu: boolean) {
  return {
    gpu,
    getFormattedChat: jest.fn(async (messages: {content: string}[]) => {
      await new Promise(resolve => setTimeout(resolve, mockNative.formatDelayMs));
      return {type: 'jinja', prompt: messages.map(m => m.content).join('|'), chat_format: 1, additional_stops: ['<end_of_utterance>']};
    }),
    tokenize: jest.fn(async (text: string) => ({tokens: new Array(text.length).fill(1)})),
    completion: (params: unknown, cb: CompletionCallback) => mockNative.completion(params, cb),
    stopCompletion: mockNative.stopCompletion,
    clearCache: mockNative.clearCache,
    release: mockNative.release,
  };
}

function makeEngine(platform: 'android' | 'ios' = 'android') {
  const references: (string | null)[] = [];
  const diagnostics: string[] = [];
  const engine = new LlamaRnEngine({
    platform,
    parameters: resolveParameters(platform, 8),
    resolveArtifactPath: async () => '/verified/model.gguf',
    setRuntimeReference: id => void references.push(id),
    allowCpuOnIosSimulator: false,
    diagnostics: {record: code => void diagnostics.push(code)},
  });
  return {engine, references, diagnostics};
}

const MESSAGES = [{role: 'user' as const, content: 'hello'}];
const RESULT = {
  text: '', tokens_predicted: 3, tokens_evaluated: 6, tokens_cached: 0, stopped_eos: true, stopped_word: '',
  stopped_limit: 0, context_full: false, truncated: false, interrupted: false, timings: {},
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.formatDelayMs = 0;
  mockNative.initLlama.mockImplementation(async () => makeContext(false));
});

describe('INF-001 configuration mapping', () => {
  it('passes the fixed production configuration to the pinned API', async () => {
    const {engine, references} = makeEngine();
    await engine.load('artifact');
    expect(mockNative.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        model: '/verified/model.gguf', n_ctx: 2048, n_batch: 256, n_ubatch: 128, n_threads: 4, n_gpu_layers: 0,
        n_parallel: 1, cache_type_k: 'f16', cache_type_v: 'f16', use_mmap: true, use_mlock: false, ctx_shift: false,
        embedding: false,
      }),
    );
    expect(references).toEqual(['artifact']);
    mockNative.completion.mockImplementation(async () => ({...RESULT, text: 'ok'}));
    await engine.generate({id: 'r1', conversationId: 'c', messages: MESSAGES}, () => undefined);
    expect(mockNative.completion.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        n_predict: 384, temperature: 0.3, top_p: 0.9, top_k: 40, penalty_repeat: 1.1, seed: -1,
        stop: ['<|END_RESPONSE|>', '<|END_OF_TURN_TOKEN|>', '<end_of_utterance>'],
      }),
    );
  });

  it('counts the formatted prompt plus the BOS token the completion path adds (INF-002)', async () => {
    const {engine} = makeEngine();
    await engine.load('artifact');
    expect(await engine.countFormattedTokens(MESSAGES)).toBe('hello'.length + 1);
  });

  it('DEV-004: refuses a CPU context on iOS and releases it; refuses a GPU context on Android', async () => {
    const ios = makeEngine('ios');
    await expect(ios.engine.load('a')).rejects.toMatchObject({code: 'MODEL_LOAD_FAILED'});
    expect(mockNative.release).toHaveBeenCalledTimes(1);
    mockNative.initLlama.mockImplementation(async () => makeContext(true));
    const android = makeEngine('android');
    await expect(android.engine.load('a')).rejects.toMatchObject({code: 'MODEL_LOAD_FAILED'});
  });
});

describe('INF-003 / INF-006 generation', () => {
  it('uses the runtime final text, never showing trimmed stop strings or partial markers', async () => {
    const {engine} = makeEngine();
    await engine.load('artifact');
    mockNative.completion.mockImplementation(async (_p: unknown, cb: CompletionCallback) => {
      for (const token of ['Answer', '.', '<end_of', '_utterance>']) {
        cb({token});
      }
      return {...RESULT, text: 'Answer.', stopped_eos: false, stopped_word: '<end_of_utterance>'};
    });
    const deltas: string[] = [];
    const result = await engine.generate({id: 'r1', conversationId: 'c', messages: MESSAGES}, e => deltas.push(e.delta));
    expect(result.text).toBe('Answer.');
    expect(deltas.join('')).toBe('Answer.');
    expect(result.reason).toBe('eos');
  });

  it('cuts at a leaked control token and emits strictly increasing sequence numbers', async () => {
    const {engine} = makeEngine();
    await engine.load('artifact');
    mockNative.completion.mockImplementation(async (_p: unknown, cb: CompletionCallback) => {
      for (const token of ['Sannu', ' duniya', '<|END_RESPONSE|>', '<|START_OF_TURN_TOKEN|>', 'ignored']) {
        cb({token});
      }
      return {...RESULT, text: 'Sannu duniya<|END_RESPONSE|><|START_OF_TURN_TOKEN|>ignored'};
    });
    const sequences: number[] = [];
    const result = await engine.generate({id: 'r1', conversationId: 'c', messages: MESSAGES}, e => sequences.push(e.sequence));
    expect(result.text).toBe('Sannu duniya');
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('latches a cancel that arrives before the native completion is registered', async () => {
    const {engine} = makeEngine();
    await engine.load('artifact');
    mockNative.formatDelayMs = 30;
    const running = engine.generate({id: 'r1', conversationId: 'c', messages: [{role: 'user', content: 'uncached'}]}, () => undefined);
    const cancelled = engine.cancel('r1'); // completion() has not been called yet
    const result = await running;
    await cancelled;
    expect(result.reason).toBe('cancelled');
    expect(mockNative.completion).not.toHaveBeenCalled();
    expect(engine.state()).toBe('ready');
  });

  it('acknowledges cancel only after the running completion has returned', async () => {
    const {engine} = makeEngine();
    await engine.load('artifact');
    let finish!: (value: unknown) => void;
    mockNative.completion.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    const running = engine.generate({id: 'r1', conversationId: 'c', messages: MESSAGES}, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 5));
    let acknowledged = false;
    const cancel = engine.cancel('r1').then(() => (acknowledged = true));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(mockNative.stopCompletion).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(false);
    await expect(engine.unload()).rejects.toMatchObject({code: 'CANCEL_TIMEOUT'}); // never free a running context
    finish({...RESULT, text: 'partial', interrupted: true, stopped_eos: false});
    expect((await running).reason).toBe('cancelled');
    await cancel;
    expect(acknowledged).toBe(true);
  });

  it('reports a runtime interruption that Namu did not request as interrupted, not as a user stop', async () => {
    const {engine} = makeEngine();
    await engine.load('artifact');
    mockNative.completion.mockImplementation(async () => ({...RESULT, text: 'half', interrupted: true, stopped_eos: false}));
    expect((await engine.generate({id: 'r1', conversationId: 'c', messages: MESSAGES}, () => undefined)).reason).toBe('interrupted');
  });

  it('records a diagnostic when the evaluated prompt differs from the counted one', async () => {
    const {engine, diagnostics} = makeEngine();
    await engine.load('artifact');
    mockNative.completion.mockImplementation(async () => ({...RESULT, text: 'x', tokens_evaluated: 99}));
    await engine.generate({id: 'r1', conversationId: 'c', messages: MESSAGES}, () => undefined);
    expect(diagnostics).toContain('prompt.count.mismatch');
  });

  it('never reports a half state when release throws', async () => {
    const {engine, references} = makeEngine();
    await engine.load('artifact');
    mockNative.release.mockRejectedValueOnce(new Error('native'));
    await expect(engine.unload()).rejects.toThrow('native');
    expect(engine.state()).toBe('unloaded');
    expect(engine.loadedArtifactId()).toBeNull();
    expect(references[references.length - 1]).toBeNull();
  });
});
