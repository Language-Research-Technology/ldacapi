import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';

const log = logger.child({ module: 'indexer' });

/** Kinds of Prisma driver adapter error that mean the database can't be reached */
const DATABASE_OUTAGES = new Set(['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections']);

/** opensearch-js errors that mean search can't be reached */
const SEARCH_OUTAGES = new Set(['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError']);

type DriverAdapterMeta = { meta?: { driverAdapterError?: { cause?: { kind?: string; code?: string } } } };

/** Postgres error classes for a lost connection (08), and for a server shutting down or starting (57P0x) */
const POSTGRES_OUTAGE_CODE = /^(08|57P0)/;

/** Whether `error` comes from the database or search being unavailable, rather than from the job */
export function isOutage(error: unknown) {
  const { name, message, meta } = Object(error) as Partial<Error> & DriverAdapterMeta;
  const cause = meta?.driverAdapterError?.cause;
  return (
    SEARCH_OUTAGES.has(String(name)) ||
    DATABASE_OUTAGES.has(String(cause?.kind)) ||
    POSTGRES_OUTAGE_CODE.test(String(cause?.code)) ||
    /Connection terminated/.test(String(message))
  );
}

/** Waits until both the database and search answer, or `signal` aborts */
export async function waitForServices({ prisma, opensearch }: { prisma: PrismaClient; opensearch: Client }, retryMilliseconds: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await sleep(retryMilliseconds, undefined, { signal }).catch(() => {});
    try {
      await prisma.$queryRaw`SELECT 1`;
      await opensearch.ping();
      log.info('Resumed: the database and search answer');
      return;
    } catch (retryError) {
      if (!isOutage(retryError)) {
        throw retryError;
      }
      log.debug({ err: retryError }, 'Still unavailable');
    }
  }
}
