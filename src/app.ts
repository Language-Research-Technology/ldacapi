import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { appConfig, isDevelopment } from './common';
import { errorHandler } from './common/middleware';
import { registerRoutes } from './routes';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
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
    },
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Register plugins
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  // Set error handler
  fastify.setErrorHandler(errorHandler);

  // Register routes
  await registerRoutes(fastify);

  // Root endpoint
  fastify.get('/', async () => {
    return {
      message: 'LDAC API - Language Data Commons REST API',
      version: '1.0.0',
      documentation: '/api/v1/health',
    };
  });

  return fastify;
}

export async function startServer(): Promise<void> {
  try {
    const app = await buildApp();

    await app.listen({
      port: appConfig.port,
      host: appConfig.host,
    });

    app.log.info(`Server running at http://${appConfig.host}:${appConfig.port}`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}
