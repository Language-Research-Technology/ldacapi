import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '@prisma/client/extension';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AccessTransformer, EntityTransformer } from 'arocapi';
import pkg from "../package.json" with { type: "json" };

import fp from 'fastify-plugin';
import { admin } from './routes/admin.ts';
import ocfl from "@ocfl/ocfl-fs";

export type Options = {
  prisma: PrismaClient;
  opensearch: Client;
  disableCors?: boolean;
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
};

const ocflConf = {
  ocflPath: '/opt/storage/oni/ocfl',
  ocflPathInternal: '/ocfl',
  ocflScratch: '/opt/storage/oni/scratch-ocfl',
  ocflTestPath: '/opt/storage/oni/test/ocfl',
  ocflTestScratch: '/opt/storage/oni/test/scratch-ocfl',
  catalogFilename: 'ro-crate-metadata.json',
  hashAlgorithm: 'md5',
  create: {
    repoName: 'LDACA',
    collections: '../test-data/ingest-crate-list.development.json',
  },
  previewPath: '/opt/storage/oni/temp/ocfl/previews/',
  previewPathInternal: '/ocfl/previews',
};

const app: FastifyPluginAsync<Options> = async (fastify, options) => {
  const repository = ocfl.storage({
    root: ocflConf.ocflPath,
    workspace: ocflConf.ocflScratch,
    ocflVersion: '1.1',
    fixityAlgorithms: ['crc32'],
    layout: {
      extensionName: '000N-path-direct-storage-layout'
    }
  });

  try {
    await repository.load();
  } catch (e) {
    fastify.log.error('=======================================');
    fastify.log.error('Repository Error: please check your OCFL');
    fastify.log.error((e as Error).message);
    fastify.log.error(JSON.stringify(ocflConf));
    fastify.log.error('=======================================');
  }

  // Declare a route
  fastify.get('/', async function handler(request, reply) {
    const routes = fastify.routes.keys().toArray();
    return {
      about: 'Example implmentation of mounting an ROCrate API in a fastify app',
      routes,
    };
  });

  const { version } = pkg;
  fastify.get('/version', async () => ({ version }));
  fastify.register(admin, { prefix: '/admin', repository });

};

export default fp(app);
