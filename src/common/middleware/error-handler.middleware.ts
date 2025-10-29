import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../utils';
import { ApiResponse } from '../types';

export const errorHandler = async (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  logger.error(
    {
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
      },
      request: {
        method: request.method,
        url: request.url,
      },
    },
    'Request error'
  );

  const statusCode = error.statusCode || 500;
  const response: ApiResponse = {
    success: false,
    error: {
      message: error.message || 'Internal Server Error',
      code: error.code,
    },
  };

  reply.status(statusCode).send(response);
};
