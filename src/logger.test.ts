import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.ts';

describe('logger options', () => {
  it('pretty-prints in development', () => {
    expect(loggerOptions({ logLevel: 'debug', isDev: true })).toMatchObject({ level: 'debug', transport: { target: 'pino-pretty' } });
  });

  it('logs JSON in development when the pretty-printer is not installed', () => {
    const notInstalled = () => {
      throw new Error('Cannot find package');
    };
    expect(loggerOptions({ logLevel: 'debug', isDev: true }, notInstalled)).toEqual({ level: 'debug' });
  });

  it('logs JSON outside development', () => {
    expect(loggerOptions({ logLevel: 'info', isDev: false })).toEqual({ level: 'info' });
  });
});
