import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Repository } from '../repository.ts';

type FileRouteOptions = {
  prefix: string;
  prisma: PrismaClient;
  repository: Repository;
  signatures: Map<string, string>;
};

export const fileRoute: FastifyPluginAsync<FileRouteOptions> = async (fastify, opts) => {
  const { repository, signatures, prisma } = opts;
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  //app.register(bearerAuthPlugin, { keys: [config.tokenAdmin] });

  app.get(
    '/:crateId/*',
    {
      schema: {
        summary: 'Get the actual file using either auth header or signature query parameter.',
        params: z.object({
          crateId: z.string(),
          '*': z.string().optional(),
        }),
        querystring: z.object({
          signature: z.string().optional(),
          disposition: z.string().optional(),
          filename: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      let crateId = request.params.crateId;
      if (!crateId) {
        return reply.badRequest('Missing crateId');
      }
      const filePath = request.params['*'];
      if (crateId.toLowerCase().endsWith('.zip')) {
        crateId = crateId.slice(0, -4);
        // handle zip download request
        console.log(crateId);
      } else if (!filePath) {
        return reply.badRequest('Missing filePath');
      } else {
        const entityId = `${crateId}/${filePath}`;
        const signature = request.query.signature;
        if (!signature || signatures.get(signature) !== entityId) {
          return reply.unauthorized('Invalid or missing signature');
        }
        try {
          const file = await prisma.file.findUnique({
            where: { id: entityId },
            include: { entity: true },
          });

          if (!file) {
            return reply.notFound(`File metadata not found: ${entityId}`);
          }

          const rf = await repository.getFile(crateId, filePath);
          if (!rf) return reply.notFound(`File not found: ${crateId}/${filePath}`);

          const disposition = request.query.disposition || 'attachment';
          const filename = request.query.filename || file.filename || filePath.split('/').pop() || 'file';
          // filename can contain unicode chars which aren't valid raw header bytes; use RFC 5987 encoding
          reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
          reply.header('Content-Type', file.mediaType);
          if (request.headers.via?.includes('nginx')) {
            // try to auto-detect nginx proxy using `via` header
            // if detected, use the x-accel feature to let nginx serve the requested file directly
            const path = encodeURI(`/ocfl/${rf.path}`);
            reply.header('X-Accel-Redirect', path);
            return reply.code(200).send();
          } else {
            reply.header('Content-Length', file.size.toString());

            // if (metadata.etag) {
            //   reply.header('ETag', metadata.etag);
            // }
            // if (metadata.lastModified) {
            //   reply.header('Last-Modified', metadata.lastModified.toUTCString());
            // }
            return reply.code(200).send(await rf.stream());
          }
        } catch (error) {
          const err = error as Error;
          fastify.log.error(`File retrieval error: ${err.message}`);
          return reply.internalServerError('Error retrieving file');
        }
      }
    },
  );
};
