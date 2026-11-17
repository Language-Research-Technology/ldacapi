export type Stage = 'reading the crate' | 'deriving' | 'database index' | 'search index' | 'aggregates';

/** Where a running job has got to, kept in memory: the worker's heartbeat saves it, and a failure records it */
export class Progress {
  stage: Stage = 'reading the crate';
  done = 0;
  total: number | null = null;
  /** The entity or file being worked on, which a failure names */
  on: string | null = null;

  /** Starts `stage`, with `total` things to do in it when they can be counted */
  start(stage: Stage, total: number | null = null) {
    this.stage = stage;
    this.done = 0;
    this.total = total;
    this.on = null;
  }

  advance(count = 1) {
    this.done += count;
  }

  /** Runs `work` on the entity or file `id`, which a failure inside it names */
  async onItem<T>(id: string, work: () => Promise<T>) {
    this.on = id;
    const result = await work();
    this.on = null;
    return result;
  }
}
