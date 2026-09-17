/**
 * INF-006: one application-wide ownership lock serializes load, generation,
 * activation (self-test) and unload. Cancellation is NOT routed through this
 * lock: it is an out-of-band signal and must never wait behind the generation
 * it is stopping.
 */
export type OwnershipPurpose = 'load' | 'generate' | 'activation' | 'unload' | 'reset';

export class EngineOwnership {
  private tail: Promise<void> = Promise.resolve();
  private holder: OwnershipPurpose | null = null;
  private waiting = 0;

  current(): OwnershipPurpose | null {
    return this.holder;
  }

  isIdle(): boolean {
    return this.holder === null && this.waiting === 0;
  }

  async run<T>(purpose: OwnershipPurpose, task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    this.waiting++;
    await previous;
    this.waiting--;
    this.holder = purpose;
    try {
      return await task();
    } finally {
      this.holder = null;
      release();
    }
  }
}
