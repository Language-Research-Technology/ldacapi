import type { EntityRow, RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
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

/** `access` as configured by `ENROLLMENT_URL`, read on first import */
const accessWith = async (enrollmentUrl: string) => {
  vi.stubEnv('ENROLLMENT_URL', enrollmentUrl);
  vi.resetModules();
  try {
    return (await import('./auth.ts')).access;
  } finally {
    vi.unstubAllEnvs();
  }
};

describe('access', () => {
  it('grants metadata and content under open licences', async () => {
    const open = entity(OPEN, OPEN);
    expect(await access(open, anonymous(), open)).toEqual({ metadata: true, content: true });
  });

  it('denies content under a restricted licence and offers its enrolment link', async () => {
    const access = await accessWith('https://rems.example.org/apply-for?resource={licenseId}');
    const restricted = entity(OPEN, RESTRICTED);

    expect(await access(restricted, anonymous(), restricted)).toEqual({
      metadata: true,
      content: false,
      contentAuthorizationUrl: 'https://rems.example.org/apply-for?resource=https%3A%2F%2Fexample.org%2Flicenses%2Frestricted',
    });
  });

  it('offers no enrolment link when ENROLLMENT_URL is unset', async () => {
    const access = await accessWith('');
    const restricted = entity(OPEN, RESTRICTED);

    expect(await access(restricted, anonymous(), restricted)).toEqual({ metadata: true, content: false });
  });
});

describe('isAuthenticated', () => {
  it('treats a request without a bearer token as anonymous', async () => {
    expect(await isAuthenticated(anonymous())).toBe(false);
  });
});
