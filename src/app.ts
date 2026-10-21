import type { Client } from '@opensearch-project/opensearch';
import type { FileHandler, FileMetadata } from 'arocapi';
import type { FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import { config } from './configuration.ts';
import type { File, PrismaClient } from './generated/prisma/client.ts';
import type { createSearchBackend } from './indexer/search.ts';
import { initRepository, type Repository } from './repository.ts';
import { admin as adminRoute } from './routes/admin.ts';
import { fileRoute } from './routes/file.ts';
import { log } from './utils.ts';

export type LdacapiOptions = {
  prisma: PrismaClient;
  opensearch: Client;
  search: ReturnType<typeof createSearchBackend>;
};

let repository: Repository;
const signatures = new Map<string, string>();

const ldacapi: FastifyPluginAsync<LdacapiOptions> = async (fastify, options: LdacapiOptions) => {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  repository = await initRepository('ocfl', { opensearchClient: options.opensearch, search: options.search });
  fastify.decorate('repository', repository);

  const { version } = pkg;
  fastify.register(adminRoute, { prefix: '/admin', repository });
  fastify.register(fileRoute, { prefix: '/dav', repository, prisma: options.prisma, signatures });

  fastify.get('/version', async () => ({ version }));
};

export default ldacapi;

function fileMetadata(file: File): FileMetadata {
  return {
    contentType: file.mediaType,
    contentLength: file.size as unknown as number,
  };
}

export const fileHandler: FileHandler = {
  get: async (file, { request }) => {
    //console.log('fileHandler', file);
    const { disposition, filename } = request.query as { disposition?: string; filename?: string };
    const storagePath = file.meta.storagePath;
    log.debug(`fileHandler: ${file.id}  ${file.meta.storagePath}`);
    const crateId = storagePath && file.id.endsWith(`/${storagePath}`) ? file.id.slice(0, -storagePath.length - 1) : file.id;
    const params = new URLSearchParams({ signature: generateSignature(file.id) });
    if (disposition) {
      params.set('disposition', disposition);
    }
    if (filename) {
      params.set('filename', filename);
    }
    return {
      type: 'redirect',
      url: `${config.prefix || ''}/dav/${encodeURIComponent(crateId)}/${encodeURI(storagePath)}?${params}`,
    };
  },
  head: async (file) => fileMetadata(file),
};

function generateSignature(url: string) {
  const token = crypto.randomUUID();
  signatures.set(token, url);
  setTimeout(() => signatures.delete(token), 60 * 1000); // expire after 1 minutes
  return token;
}
