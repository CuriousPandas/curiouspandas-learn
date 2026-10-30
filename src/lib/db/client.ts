// The page's side of the SQLite worker. Every query has a deadline: past it the
// worker is terminated and the dataset reloaded, and the learner is told so.
// A stopped query must not look like a query that returned nothing.
import type { Dataset, RunResult } from './engine.ts';

export type Schema = { table: string; columns: string[] }[];
export type Reply = { result?: RunResult; schema: Schema; indexes: string[]; stopped?: boolean };

export const DEADLINE_MS = 4000;

export class DbClient {
  private worker!: Worker;
  private seq = 0;
  private waiting = new Map<number, (r: Reply) => void>();
  ready: Promise<Reply>;
  private dataset: Dataset;

  constructor(dataset: Dataset) {
    this.dataset = dataset;
    this.ready = this.start();
  }

  private start(): Promise<Reply> {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Reply & { id: number }>) => {
      this.waiting.get(e.data.id)?.(e.data);
      this.waiting.delete(e.data.id);
    };
    return this.send({ type: 'open', dataset: this.dataset });
  }

  private send(msg: { type: 'open'; dataset: Dataset } | { type: 'run'; sql: string }): Promise<Reply> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, ...msg });
    });
  }

  async run(sql: string): Promise<Reply> {
    await this.ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), DEADLINE_MS); });
    const reply = await Promise.race([this.send({ type: 'run', sql }), deadline]);
    clearTimeout(timer);
    if (reply !== 'late') return reply;
    this.worker.terminate();
    this.waiting.clear();
    this.ready = this.start();
    const fresh = await this.ready;
    return { ...fresh, stopped: true };
  }

  /** Throw away every change and load the dataset again. */
  async reset(): Promise<Reply> {
    this.worker.terminate();
    this.waiting.clear();
    this.ready = this.start();
    return this.ready;
  }
}
