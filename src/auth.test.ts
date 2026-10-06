import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileAccessTransformer } from './auth.ts';
import { prisma } from './prisma.ts';

const OPEN = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED = 'https://example.org/licenses/restricted';
const OPEN_ID = 'http://test/auth/open.txt';
const RESTRICTED_ID = 'http://test/auth/restricted.txt';
const ids = [OPEN_ID, RESTRICTED_ID];

const createFile = async (id: string, contentLicenseId: string) => {
  await prisma.entity.create({
    data: { id, name: id, description: '', entityType: 'http://schema.org/MediaObject', metadataLicenseId: OPEN, contentLicenseId },
  });
  const file = await prisma.file.create({ data: { id, filename: id.split('/').pop() ?? '', mediaType: 'text/plain', size: 1 } });
  return { id: file.id, filename: file.filename, mediaType: file.mediaType, size: Number(file.size) };
};

const fakeRequest = () => {
  const decorators = new Map<string, unknown>();
  return {
    headers: {},
    getDecorator: (name: string) => decorators.get(name) ?? null,
    setDecorator: (name: string, value: unknown) => decorators.set(name, value),
  } as unknown as FastifyRequest;
};

const cleanup = async () => {
  await prisma.file.deleteMany({ where: { id: { in: ids } } });
  await prisma.entity.deleteMany({ where: { id: { in: ids } } });
};

describe('fileAccessTransformer', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('grants content access when the file entity has an open licence', async () => {
    const file = await createFile(OPEN_ID, OPEN);
    const result = await fileAccessTransformer(file, { request: fakeRequest() });
    expect(result).toEqual({ ...file, access: { content: true } });
  });

  it('denies content access when the file entity has a restricted licence', async () => {
    const file = await createFile(RESTRICTED_ID, RESTRICTED);
    const result = await fileAccessTransformer(file, { request: fakeRequest() });
    expect(result.access.content).toBe(false);
  });
});
