import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StorageRoot } from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import { isOpenLicence } from '../access/licences.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { deleteSearchIndex, prepareSearchIndex, type SearchBackend } from '../search-backend.ts';
import { AggregatesWriter } from './aggregates.ts';
import { openCrate } from './crate.ts';
import { derive } from './derive.ts';
import { DocumentsWriter } from './documents.ts';
import { claim, fail, heartbeat, type Job, type RecordWrite, release, removeWorker, succeed, unfinished } from './jobs.ts';
import { isOutage, waitForServices } from './outage.ts';
import { Progress } from './progress.ts';
import { countRows, RowsWriter } from './rows.ts';

const log = logger.child({ module: 'indexer' });

export type IndexerDeps = {
  prisma: PrismaClient;
  repository: StorageRoot;
  opensearch: Client;
  search: SearchBackend;
  licences: { defaultLicense: string; defaultMetadataLicense: string };
};

export type WorkOptions = (
  | { until: 'empty' }
  | {
      /** Works the queue until it is empty and no job for `crateIds` is waiting or running, here or in any worker */
      until: 'finished';
      crateIds: string[];
    }
  | {
      /** Waits for jobs until `signal` aborts, then stops at once, releasing the job it is running */
      until: 'aborted';
      signal: AbortSignal;
    }
) & { heartbeatMilliseconds?: number };

/** How long to wait before looking for a job again when none is waiting */
const POLL_MILLISECONDS = 1000;

type Writers = { rows: RowsWriter; documents: DocumentsWriter; aggregates: AggregatesWriter };

const clearIndexedVersion = (prisma: PrismaClient, crateId: string) =>
  prisma.crateRecord.update({ where: { id: crateId }, data: { indexedVersion: null, indexedAt: null, entities: null, files: null } });

/** Documents first, as they are found by the rows */
async function deleteIndexes(prisma: PrismaClient, writers: Writers, crateId: string, progress: Progress) {
  await clearIndexedVersion(prisma, crateId);
  progress.start('search index');
  await writers.documents.delete(crateId);
  progress.start('aggregates');
  await writers.aggregates.delete(crateId);
  progress.start('database index');
  await writers.rows.delete(crateId);
}

/** What a job logs when it finishes, and what it writes to its crate's record */
type Outcome = { logged?: Record<string, unknown>; record?: RecordWrite };

/** Empties both indexes wholesale, keeping every crate's record as not indexed */
async function deleteEverything({ prisma, opensearch, search }: IndexerDeps, progress: Progress): Promise<Outcome> {
  progress.start('database index');
  await prisma.crateRecord.updateMany({ data: { indexedVersion: null, indexedAt: null, entities: null, files: null } });
  progress.start('search index');
  await deleteSearchIndex(opensearch);
  await prepareSearchIndex(opensearch, search);
  progress.start('aggregates');
  await prisma.aggregate.deleteMany();
  progress.start('database index');
  await prisma.file.deleteMany();
  await prisma.entity.deleteMany();
  return {};
}

/** Deletes the indexes of a crate gone from the repository, and then its record */
async function removeCrate(prisma: PrismaClient, writers: Writers, crateId: string, progress: Progress): Promise<Outcome> {
  await deleteIndexes(prisma, writers, crateId, progress);
  return { logged: { removed: true }, record: { crateId, remove: true } };
}

async function deleteCrate(prisma: PrismaClient, writers: Writers, crateId: string, progress: Progress): Promise<Outcome> {
  await deleteIndexes(prisma, writers, crateId, progress);
  return {};
}

type CrateJob = Job & { crateId: string };

function runJob(deps: IndexerDeps, writers: Writers, job: Job, progress: Progress): Promise<Outcome> {
  if (job.crateId === null) {
    return deleteEverything(deps, progress);
  }
  return runCrateJob(deps, writers, { ...job, crateId: job.crateId }, progress);
}

async function runCrateJob(deps: IndexerDeps, writers: Writers, job: CrateJob, progress: Progress): Promise<Outcome> {
  if (!(await deps.repository.has(job.crateId))) {
    return removeCrate(deps.prisma, writers, job.crateId, progress);
  }
  return job.kind === 'delete' ? deleteCrate(deps.prisma, writers, job.crateId, progress) : indexCrate(deps, writers, job, progress);
}

async function indexCrate({ prisma, repository, licences }: IndexerDeps, writers: Writers, job: CrateJob, progress: Progress): Promise<Outcome> {
  const opened = await openCrate(repository, job.crateId);
  const { indexedVersion } = await prisma.crateRecord.findUniqueOrThrow({ where: { id: job.crateId } });
  if (job.kind === 'index' && indexedVersion === opened.version) {
    log.debug({ crateId: job.crateId, version: opened.version }, 'Skipped: already indexed');
    return { logged: { skipped: true } };
  }
  const { crate, heldFiles, readText, parentCrates } = await opened.read(progress);
  progress.start('deriving');
  const derivation = derive(crate, { parentCrates, heldFiles, ...licences, isOpenLicence });
  for (const { msg, ...warning } of derivation.warnings) {
    log.warn({ crateId: job.crateId, ...warning }, msg);
  }
  await deleteIndexes(prisma, writers, job.crateId, progress);
  const written = await writers.rows.write(derivation, progress);
  await writers.documents.write(derivation, readText, written, progress);
  await writers.aggregates.write(derivation, progress);
  const counts = await countRows(prisma, job.crateId);
  const data = { name: derivation.name, indexedVersion: opened.version, indexedAt: new Date(), ...counts };
  return { logged: { version: opened.version, ...counts }, record: { crateId: job.crateId, data } };
}

async function run(deps: IndexerDeps, writers: Writers, workerId: string, job: Job, progress: Progress) {
  const fields = { jobId: job.id, crateId: job.crateId, kind: job.kind };
  const started = Date.now();
  log.info({ ...fields, attempt: job.attempts }, 'Job started');
  const dropped = () => log.warn(fields, 'Result dropped: another worker holds the job');
  try {
    const { logged, record } = await runJob(deps, writers, job, progress);
    if (await succeed(deps.prisma, workerId, job, record)) {
      log.info({ ...fields, ...logged, milliseconds: Date.now() - started }, 'Job finished');
    } else {
      dropped();
    }
  } catch (error) {
    /* v8 ignore next 3 -- an outage is checked by hand */
    if (isOutage(error)) {
      throw error;
    }
    if (await fail(deps.prisma, workerId, job, error, progress)) {
      log.error({ ...fields, stage: progress.stage, failedOn: progress.on, err: error }, 'Job failed');
    } else {
      dropped();
    }
  }
}

/** Prepares the search index while holding a lock, as workers starting at once would each try to create it */
const prepareSearchIndexAlone = ({ prisma, opensearch, search }: IndexerDeps) =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('prepareSearchIndex'))`;
      await prepareSearchIndex(opensearch, search);
    },
    { timeout: 60_000 },
  );

/** Runs index jobs one at a time, until none is waiting or until stopped, as the worker and the CLI do */
export async function workTheQueue(deps: IndexerDeps, options: WorkOptions) {
  const { prisma, search } = deps;
  const signal = options.until === 'aborted' ? options.signal : undefined;
  const stopped = (signal ? once(signal, 'abort') : new Promise<never>(() => {})).then(() => true);
  const writers = { rows: new RowsWriter(prisma), documents: new DocumentsWriter(prisma, search), aggregates: new AggregatesWriter(prisma) };
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  let running: { job: Job; progress: Progress } | undefined;
  const beat = async () => {
    try {
      await heartbeat(prisma, workerId, running);
      /* v8 ignore start -- an outage is checked by hand */
    } catch (error) {
      log.warn({ err: error }, 'Heartbeat failed');
    }
    /* v8 ignore stop */
  };
  const beating = setInterval(beat, options.heartbeatMilliseconds ?? 30_000);
  let ready = false;
  try {
    while (!signal?.aborted) {
      let job: Job | undefined;
      try {
        if (!ready) {
          await prepareSearchIndexAlone(deps);
          ready = true;
        }
        job = await claim(prisma, workerId);
        if (job) {
          running = { job, progress: new Progress() };
          const finished = run(deps, writers, workerId, job, running.progress).then(() => false);
          if (await Promise.race([finished, stopped])) {
            // The job carries on unowned until the process ends, its result refused
            await release(prisma, workerId, job);
          }
          running = undefined;
        } else if (signal || (options.until === 'finished' && (await unfinished(prisma, options.crateIds)))) {
          await sleep(POLL_MILLISECONDS, undefined, { signal }).catch(() => {});
        } else {
          return;
        }
        /* v8 ignore start -- an outage is checked by hand */
      } catch (error) {
        if (!isOutage(error)) {
          throw error;
        }
        await waitForServices(deps, error, signal);
        if (job) {
          await release(prisma, workerId, job);
        }
      }
      /* v8 ignore stop */
    }
  } finally {
    clearInterval(beating);
    await removeWorker(prisma, workerId);
  }
}
