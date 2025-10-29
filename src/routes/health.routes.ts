import { FastifyInstance } from 'fastify';
import { healthController } from '../controllers';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', {
    handler: healthController.getHealth.bind(healthController),
    schema: {
      description: 'Health check endpoint',
      tags: ['health'],
      response: {
        200: {
          description: 'Successful response',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                timestamp: { type: 'string' },
                uptime: { type: 'number' },
                database: {
                  type: 'object',
                  properties: {
                    connected: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}
