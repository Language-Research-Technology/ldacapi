import Fastify from 'fastify';
import { config } from './configuration.ts';

const hasPinoPretty = (() => {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

export const fastify = Fastify({
  routerOptions: {
    maxParamLength: config.maxParamLength,
  },
  logger: {
    level: config.logLevel,
    ...(config.isDev &&
      hasPinoPretty && {
        transport: {
          target: 'pino-pretty',
          options: { messageFormat: '[{module}] {msg}', ignore: 'pid,module,hostname' },
        },
      }),
  },
  trustProxy: true, // this is required for auth module to work corractly when the app is behind a reverse proxy. The proxy must set the X-Forwarded-* headers correctly.
});

export const log = fastify.log;

export class PromiseQueue<T = unknown> {
  concurrency: number;
  sharedFunction: ((t: T) => Promise<unknown>) | undefined;
  #runs: (Promise<unknown> | null)[] = [];
  #queue: ((value: number) => void)[] = [];
  #done: (() => void) | undefined;
  constructor(concurrency = 1, sharedFunction?: (t: T) => Promise<unknown>) {
    this.concurrency = concurrency;
    this.sharedFunction = sharedFunction;
    this.#runs = new Array<Promise<unknown> | null>(concurrency);
  }
  /**
   * Enqueue a value or function to be run. This method will be awaited until there is an available slot in the queue.
   * If a function is passed, it will be called immediately with no arguments and is expected to return a promise. The result of the promise will be returned.
   */
  //async enqueue<V>(value: V): Promise<R>;
  //async enqueue<RV, V extends () => Promise<RV>>(task: V): Promise<RV>;
  async enqueue(valueOrTask: T) {
    let slot = this.#runs.findIndex((v) => v == null);
    if (slot === -1) {
      slot = await new Promise<number>((resolve) => {
        this.#queue.push(resolve);
      });
    }
    let p: Promise<unknown>;
    if (typeof valueOrTask === 'function') {
      p = valueOrTask();
    } else {
      p = this.sharedFunction ? this.sharedFunction(valueOrTask) : Promise.resolve(valueOrTask);
    }
    this.#runs[slot] = p
      .catch((error) => {
        console.log(error);
      })
      .finally(() => {
        this.#runs[slot] = null;
        const next = this.#queue.shift();
        if (next) {
          next(slot);
        } else if (this.#done && !this.#runs.some((v) => !!v)) {
          //setTimeout(this.#done);
          this.#done();
          this.#done = undefined;
        }
      });
    return { value: p };
  }
  /** Signal the queue to finish operation and wait until all tasks are complete */
  async done() {
    if (this.#runs.every((v) => !v) && !this.#queue.length) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.#done = resolve;
    });
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
