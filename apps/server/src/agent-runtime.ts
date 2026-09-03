export class AgentRuntime {
  private active = 0;
  private limit: number;
  private stopping = false;
  private readonly waiting: Array<{ key: string | undefined; resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly controllers = new Map<AbortController, string | undefined>();
  private readonly completions = new Set<Promise<void>>();

  constructor(maxConcurrent: number) { this.limit = maxConcurrent; }

  get maxConcurrent(): number { return this.limit; }

  get availableSlots(): number {
    return Math.max(0, this.limit - this.active - this.waiting.length);
  }

  setMaxConcurrent(maxConcurrent: number): void {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be a positive integer');
    this.limit = maxConcurrent;
    this.drain();
  }

  async run<T>(task: (signal: AbortSignal) => Promise<T>, key?: string): Promise<T> {
    await this.acquire(key);
    const controller = new AbortController();
    this.controllers.set(controller, key);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    this.completions.add(completion);
    try {
      return await task(controller.signal);
    } finally {
      this.controllers.delete(controller);
      this.completions.delete(completion);
      finish();
      this.release();
    }
  }

  async track<T>(task: (signal: AbortSignal) => Promise<T>, key?: string): Promise<T> {
    if (this.stopping) throw new Error('Barbarian is shutting down');
    const controller = new AbortController();
    this.controllers.set(controller, key);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    this.completions.add(completion);
    try {
      return await task(controller.signal);
    } finally {
      this.controllers.delete(controller);
      this.completions.delete(completion);
      finish();
    }
  }

  cancel(key: string, reason = new Error('Stopped by user')): number {
    let cancelled = 0;
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiting[index];
      if (waiter?.key !== key) continue;
      this.waiting.splice(index, 1);
      waiter.reject(reason);
      cancelled += 1;
    }
    for (const [controller, controllerKey] of this.controllers) {
      if (controllerKey !== key || controller.signal.aborted) continue;
      controller.abort(reason);
      cancelled += 1;
    }
    return cancelled;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const error = new Error('Barbarian is shutting down');
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
    for (const controller of this.controllers.keys()) controller.abort(error);
    await Promise.allSettled([...this.completions]);
  }

  private acquire(key?: string): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Barbarian is shutting down'));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.waiting.push({ key, resolve, reject }));
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.waiting.shift();
      if (!next) break;
      this.active += 1;
      next.resolve();
    }
  }
}
