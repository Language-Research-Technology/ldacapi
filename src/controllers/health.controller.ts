import { FastifyReply, FastifyRequest } from 'fastify';
import { healthService } from '../services';
import { ApiResponse } from '../common/types';
import { logger } from '../common/utils';

export class HealthController {
  async getHealth(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const health = await healthService.checkHealth();
      const response: ApiResponse = {
        success: true,
        data: health,
      };

      const statusCode = health.status === 'healthy' ? 200 : 503;
      reply.status(statusCode).send(response);
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      const response: ApiResponse = {
        success: false,
        error: {
          message: 'Health check failed',
        },
      };
      reply.status(503).send(response);
    }
  }
}

export const healthController = new HealthController();
