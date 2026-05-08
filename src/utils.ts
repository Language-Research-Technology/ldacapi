import Fastify from 'fastify';
import { config } from './configuration.ts';

export const fastify = Fastify({
  //logger: { level: 'debug' },
  logger: {
    level: config.logLevel,
    ...(config.isDev && { transport: { target: 'pino-pretty' } }),
    // routerOptions: {
    //   ignoreTrailingSlash: true,
    // }
  }
});

export const log = fastify.log;

export class PromiseQueue<T = any> {
  concurrency: number;
  sharedFunction?: (t: T)=>Promise<unknown>;
  queue: (Promise<unknown>|null)[] = [];
  #returnSlot?: (value: number) => void;
  constructor(concurrency = 1, sharedFunction?: (t: T)=>Promise<unknown>) {
    this.concurrency = concurrency;
    this.sharedFunction = sharedFunction;
    this.queue = new Array<Promise<unknown>|null>(concurrency);
  }
  /**
   * Enqueue a value or function to be run. This method will be awaited until there is an available slot in the queue.
   * If a function is passed, it will be called immediately with no arguments and is expected to return a promise. The result of the promise will be returned.
   */
  //async enqueue<V>(value: V): Promise<R>;
  //async enqueue<RV, V extends () => Promise<RV>>(task: V): Promise<RV>;
  async enqueue(valueOrTask: T) {
    let slot = this.queue.findIndex(v => v == null);
    if (slot === -1) {
      slot = await (new Promise<number>(resolve => {
        this.#returnSlot = resolve;
      }));
    }
    let p: Promise<unknown>;
    if (typeof valueOrTask === 'function') {
      p = valueOrTask();
    } else {
      p = this.sharedFunction ? this.sharedFunction(valueOrTask) : Promise.resolve(valueOrTask);
    }
    this.queue[slot] = p.then(v => {
      this.queue[slot] = null;
      this.#returnSlot?.(slot);
      return v;
    });
    return { value: p };
  }
  async done() {
    await Promise.allSettled(this.queue);
  }
}

export function firstStringOrId(values: unknown[]): string | undefined {
  for (const value of values || []) {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null && '@id' in value && typeof value['@id'] === 'string') {
      return value['@id'];
    }
  //return typeof value === 'string' ? value : (value as { '@id'?: string })?.['@id'];
  }
}

// function delay() {
//   return new Promise(resolve => setTimeout(resolve, 200));
// }
// const pq = new PromiseQueue(4);
// for (let i=0; i<10; i++) {
//   console.log('s', i);
//   await pq.enqueue(async () => {
//     await delay();
//     console.log(i);
//   });
// }