import type { BaseEntity, RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { access, isAuthenticated } from './auth.ts';

const OPEN = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED = 'https://example.org/licenses/restricted';

const entity = (metadataLicenseId: string, contentLicenseId: string): BaseEntity => ({
  id: 'http://test/auth/entity',
  entityType: 'http://schema.org/MediaObject',
  name: 'entity',
  description: '',
  memberOf: null,
  rootCollection: null,
  metadataLicenseId,
  contentLicenseId,
});

const anonymous = () => ({ request: { headers: {} } as FastifyRequest }) as RequestContext;

describe('access', () => {
  it('grants metadata and content under open licences', async () => {
    expect(await access(entity(OPEN, OPEN), anonymous())).toEqual({ metadata: true, content: true });
  });

  it('denies content under a restricted licence and offers an enrolment link', async () => {
    const result = await access(entity(OPEN, RESTRICTED), anonymous());
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
