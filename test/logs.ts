import { Writable } from 'node:stream';
import { pino } from 'pino';

/** The module `vi.mock('./logger.ts', …)` returns: a logger at `level` that writes each record into `logs` */
export const capturingLogger = (logs: Record<string, unknown>[], level: string) => {
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ level }, stream) };
};
