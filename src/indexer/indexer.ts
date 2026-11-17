import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StorageRoot } from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { deleteSearchIndex, prepareSearchIndex, type SearchBackend } from '../search-backend.ts';
import { firstStringOrId } from '../utils.ts';
import { openCrate } from './crate.ts';
import { DocumentsWriter } from './documents.ts';
import { claim, fail, heartbeat, type Job, removeWorker, succeed } from './jobs.ts';
import { countRows, RowsWriter } from './rows.ts';
import type { Licences } from './writer.ts';

const log = logger.child({ module: 'indexer' });

export type IndexerDeps = {
  prisma: PrismaClient;
  repository: StorageRoot;
  opensearch: Client;
  search: SearchBackend;
  licences: Licences;
};

export type WorkOptions = (
  | { until: 'empty' }
  | {
      /** Waits for jobs until `signal` aborts, then stops after the job it is running */
      until: 'aborted';
      signal: AbortSignal;
    }
) & { heartbeatMilliseconds?: number };

/** How long to wait before looking for a job again when none is waiting */
const POLL_MILLISECONDS = 1000;

type Writers = { rows: RowsWriter; documents: DocumentsWriter };

const clearIndexedVersion = (prisma: PrismaClient, crateId: string) =>
  prisma.crateRecord.update({ where: { id: crateId }, data: { indexedVersion: null, indexedAt: null, entities: null, files: null } });

/** Documents first, as they are found by the rows */
async function deleteIndexes(prisma: PrismaClient, writers: Writers, crateId: string) {
  await clearIndexedVersion(prisma, crateId);
  await writers.documents.delete(crateId);
  await writers.rows.delete(crateId);
}

/** Empties both indexes wholesale, keeping every crate's record as not indexed */
async function deleteEverything({ prisma, opensearch, search }: IndexerDeps) {
  await prisma.crateRecord.updateMany({ data: { indexedVersion: null, indexedAt: null, entities: null, files: null } });
  await deleteSearchIndex(opensearch);
  await prepareSearchIndex(opensearch, search);
  await prisma.file.deleteMany();
  await prisma.entity.deleteMany();
}

/** Deletes the indexes of a crate gone from the repository, and its record */
async function removeCrate(prisma: PrismaClient, writers: Writers, crateId: string) {
  await deleteIndexes(prisma, writers, crateId);
  await prisma.crateRecord.delete({ where: { id: crateId } });
  return { removed: true };
}

type CrateJob = Job & { crateId: string };

async function runJob(deps: IndexerDeps, writers: Writers, job: Job) {
  if (job.crateId === null) {
    return deleteEverything(deps);
  }
  const crateJob = { ...job, crateId: job.crateId };
  if (!(await deps.repository.has(crateJob.crateId))) {
    return removeCrate(deps.prisma, writers, crateJob.crateId);
  }
  return crateJob.kind === 'delete' ? deleteIndexes(deps.prisma, writers, crateJob.crateId) : indexCrate(deps, writers, crateJob);
}

async function indexCrate({ prisma, repository }: IndexerDeps, writers: Writers, job: CrateJob) {
  const opened = await openCrate(repository, job.crateId);
  const record = await prisma.crateRecord.findUniqueOrThrow({ where: { id: job.crateId } });
  if (job.kind === 'index' && record.indexedVersion === opened.version) {
    log.debug({ crateId: job.crateId, version: opened.version }, 'Skipped: already indexed');
    return { skipped: true };
  }
  const read = await opened.read();
  await deleteIndexes(prisma, writers, job.crateId);
  await writers.rows.index(read);
  await writers.documents.index(read);
  const counts = await countRows(prisma, job.crateId);
  await prisma.crateRecord.update({
    where: { id: job.crateId },
    data: { name: firstStringOrId(read.crate.root.name) ?? null, indexedVersion: opened.version, indexedAt: new Date(), ...counts },
  });
  return { version: opened.version, ...counts };
}

async function run(deps: IndexerDeps, writers: Writers, workerId: string, job: Job) {
  const fields = { jobId: job.id, crateId: job.crateId, kind: job.kind };
  const started = Date.now();
  log.info({ ...fields, attempt: job.attempts }, 'Job started');
  try {
    const result = await runJob(deps, writers, job);
    await succeed(deps.prisma, workerId, job);
    log.info({ ...fields, ...result, milliseconds: Date.now() - started }, 'Job finished');
  } catch (error) {
    await fail(deps.prisma, workerId, job, error);
    log.error({ ...fields, err: error }, 'Job failed');
  }
}

/** Runs index jobs one at a time, until none is waiting or until stopped, as the worker and the CLI do */
export async function workTheQueue(deps: IndexerDeps, options: WorkOptions) {
  const { prisma, opensearch, search, licences } = deps;
  const writers = { rows: new RowsWriter(prisma, licences), documents: new DocumentsWriter(prisma, search, licences) };
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  await heartbeat(prisma, workerId);
  const beating = setInterval(() => heartbeat(prisma, workerId), options.heartbeatMilliseconds ?? 30_000);
  try {
    await prepareSearchIndex(opensearch, search);
    while (options.until === 'empty' || !options.signal.aborted) {
      const job = await claim(prisma, workerId);
      if (job) {
        await run(deps, writers, workerId, job);
      } else if (options.until === 'empty') {
        return;
      } else {
        await sleep(POLL_MILLISECONDS, undefined, { signal: options.signal }).catch(() => {});
      }
    }
  } finally {
    clearInterval(beating);
    await removeWorker(prisma, workerId);
  }
}
