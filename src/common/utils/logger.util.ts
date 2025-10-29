import pino from 'pino';
import { appConfig, isDevelopment } from '../config';

export const logger = pino({
  level: appConfig.logLevel,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});
