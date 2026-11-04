import type { EntityRow, RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { access, isAuthenticated } from './auth.ts';

const OPEN = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED = 'https://example.org/licenses/restricted';

const entity = (metadataLicenseId: string, contentLicenseId: string): EntityRow => ({
  id: 'http://test/auth/entity',
  entityType: 'http://schema.org/MediaObject',
  name: 'entity',
  description: '',
  memberOf: null,
  rootCollection: null,
  metadataLicenseId,
  contentLicenseId,
  meta: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const anonymous = () => ({ request: { headers: {} } as FastifyRequest }) as RequestContext;

describe('access', () => {
  it('grants metadata and content under open licences', async () => {
    const open = entity(OPEN, OPEN);
    expect(await access(open, anonymous(), open)).toEqual({ metadata: true, content: true });
  });

  it('denies content under a restricted licence and offers an enrolment link', async () => {
    const restricted = entity(OPEN, RESTRICTED);
    const result = await access(restricted, anonymous(), restricted);
    expect(result).toMatchObject({ metadata: true, content: false });
    expect(result).toHaveProperty('contentAuthorizationUrl');
    expect(result).not.toHaveProperty('metadataAuthorizationUrl');
  });
});

describe('isAuthenticated', () => {
  it('treats a request without a bearer token as anonymous', async () => {
    expect(await isAuthenticated(anonymous())).toBe(false);
  });
});
