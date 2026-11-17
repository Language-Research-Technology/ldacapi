import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StorageRoot } from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import type { IndexJobKind, PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { deleteSearchIndex, prepareSearchIndex, type SearchBackend } from '../search-backend.ts';
import { AggregatesWriter } from './aggregates.ts';
import { openCrate, Parents } from './crate.ts';
import { type DeriveFacts, derive } from './derive.ts';
import { DocumentsWriter } from './documents.ts';
import { claim, fail, heartbeat, type Job, type RecordWrite, release, removeWorker, returnDeadWorkersJobs, succeed, unfinished } from './jobs.ts';
import { isOutage, waitForServices } from './outage.ts';
import { Progress } from './progress.ts';
import { RowsWriter } from './rows.ts';

const log = logger.child({ module: 'indexer' });

export type IndexerDeps = {
  prisma: PrismaClient;
  repository: StorageRoot;
  opensearch: Client;
  search: SearchBackend;
  licences: Pick<DeriveFacts, 'defaultLicense' | 'defaultMetadataLicense' | 'isOpenLicence'>;
};

export type WorkOptions = (
  | { until: 'empty' }
  | {
      /** Works the queue until it is empty and no job for `crateIds` is waiting or running, here or in any worker */
      until: 'finished';
      crateIds: string[];
    }
  | {
      /** Waits for jobs until `signal` aborts, then stops, releasing the job it is running once its current step is done */
      until: 'aborted';
      signal: AbortSignal;
    }
) & {
  heartbeatMilliseconds?: number;
  /** How long to wait before looking for a job again when none is waiting */
  pollMilliseconds?: number;
  /** How long to wait between checks while the database or search is unavailable */
  retryMilliseconds?: number;
};

type Writers = { rows: RowsWriter; documents: DocumentsWriter; aggregates: AggregatesWriter };

const NOT_INDEXED = { indexedVersion: null, indexedAt: null, entities: null, files: null };

/**
 * Documents first, found by the links, so a delete cut short can be asked again. Then, once the rows have changed, the
 * documents of what changed, as another crate may have linked to them since
 */
async function deleteIndexes(prisma: PrismaClient, writers: Writers, crateId: string, progress: Progress) {
  await prisma.crateRecord.update({ where: { id: crateId }, data: NOT_INDEXED });
  progress.start('search index');
  const removed = await writers.documents.delete(crateId);
  progress.start('aggregates');
  await writers.aggregates.delete(crateId);
  progress.start('database index');
  const { orphaned, rebuilt } = await writers.rows.delete(crateId);
  progress.start('search index');
  const held = new Set(removed.held);
  await writers.documents.sync([...new Set([...removed.shared, ...orphaned, ...rebuilt])].filter((id) => !held.has(id)));
}

/** What a job logs when it finishes, and what it writes to its crate's record */
type Outcome = { logged?: Record<string, unknown>; record?: RecordWrite };

/** Empties both indexes wholesale, keeping every crate's record as not indexed, and clears every crate's failure */
async function deleteEverything({ prisma, opensearch, search }: IndexerDeps, progress: Progress): Promise<Outcome> {
  progress.start('database index');
  await prisma.$transaction([prisma.crateRecord.updateMany({ data: NOT_INDEXED }), prisma.indexJob.deleteMany({ where: { status: 'failed' } })]);
  progress.start('search index');
  await deleteSearchIndex(opensearch);
  await prepareSearchIndex(opensearch, search);
  progress.start('aggregates');
  await prisma.aggregate.deleteMany();
  progress.start('database index');
  await prisma.crateLink.deleteMany();
  await prisma.file.deleteMany();
  await prisma.entity.deleteMany();
  return {};
}

/** Deletes everything, or the crate's indexes (then its record, if it is gone from the repository), or indexes it */
async function runJob(deps: IndexerDeps, writers: Writers, parents: Parents, job: Job, progress: Progress): Promise<Outcome> {
  const { crateId, kind } = job;
  if (crateId === null) {
    return deleteEverything(deps, progress);
  }
  if (!(await deps.repository.has(crateId))) {
    await deleteIndexes(deps.prisma, writers, crateId, progress);
    return { logged: { removed: true }, record: { crateId, remove: true } };
  }
  if (kind === 'delete') {
    await deleteIndexes(deps.prisma, writers, crateId, progress);
    return {};
  }
  return indexCrate(deps, writers, parents, crateId, kind, progress);
}

async function indexCrate(
  { prisma, repository, licences }: IndexerDeps,
  writers: Writers,
  parents: Parents,
  crateId: string,
  kind: IndexJobKind,
  progress: Progress,
): Promise<Outcome> {
  const opened = await openCrate(repository, parents, crateId);
  const { indexedVersion } = await prisma.crateRecord.findUniqueOrThrow({ where: { id: crateId } });
  if (kind === 'index' && indexedVersion === opened.version) {
    log.debug({ crateId, version: opened.version }, 'Skipped: already indexed');
    return { logged: { skipped: true } };
  }
  const { crate, heldFiles, readText, parentCrates } = await opened.read(progress);
  progress.start('deriving');
  if (crate.rootId !== crateId) {
    throw new Error(`The crate's root id, ${crate.rootId}, isn't the id of the OCFL object holding it, ${crateId}`);
  }
  const derivation = derive(crate, { parentCrates, heldFiles, ...licences });
  for (const { msg, ...warning } of derivation.warnings) {
    log.warn({ crateId, ...warning }, msg);
  }
  await deleteIndexes(prisma, writers, crateId, progress);
  await writers.rows.write(derivation, progress);
  await writers.documents.write(derivation, readText, progress);
  await writers.aggregates.write(derivation, progress);
  const counts = { entities: derivation.entities.length, files: derivation.entities.filter(({ file }) => file).length };
  const data = { name: derivation.name, indexedVersion: opened.version, indexedAt: new Date(), ...counts };
  return { logged: { version: opened.version, ...counts }, record: { crateId, data } };
}

/** A job being run, and what stops it once another worker is found to hold its claim */
type Running = { job: Job; progress: Progress; claimLost: AbortController };

/** Runs the job and records its result, unless it was stopped or met an outage, which the caller releases it for */
async function run(deps: IndexerDeps, writers: Writers, parents: Parents, workerId: string, { job, progress, claimLost }: Running) {
  const fields = { jobId: job.id, crateId: job.crateId, kind: job.kind };
  const started = Date.now();
  log.info({ ...fields, attempt: job.attempts }, 'Job started');
  const dropped = () => log.warn(fields, 'Result dropped: another worker holds the job');
  try {
    const { logged, record } = await runJob(deps, writers, parents, job, progress);
    if (await succeed(deps.prisma, workerId, job, record)) {
      log.info({ ...fields, ...logged, milliseconds: Date.now() - started }, 'Job finished');
    } else {
      dropped();
    }
  } catch (error) {
    if (claimLost.signal.aborted) {
      dropped();
      return;
    }
    if (isOutage(error) || progress.signal.aborted) {
      throw error;
    }
    if (await fail(deps.prisma, workerId, job, error, progress)) {
      log.error({ ...fields, stage: progress.stage, failedOn: progress.on, err: error }, 'Job failed');
    } else {
      dropped();
    }
  }
}

const INTERVALS = { heartbeatMilliseconds: 30_000, pollMilliseconds: 1000, retryMilliseconds: 5000 };

/** Runs index jobs one at a time, until none is waiting or until stopped, as the worker and the CLI do */
export async function workTheQueue(deps: IndexerDeps, options: WorkOptions) {
  const { prisma, search } = deps;
  const signal = options.until === 'aborted' ? options.signal : new AbortController().signal;
  const intervals = { ...INTERVALS, ...options };
  const writers = {
    rows: new RowsWriter(prisma),
    documents: new DocumentsWriter(prisma, search),
    aggregates: new AggregatesWriter(prisma),
  };
  const parents = new Parents(deps.repository);
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  let running: Running | undefined;
  const beat = async () => {
    const current = running;
    try {
      if (!(await heartbeat(prisma, workerId, current))) {
        const { job, claimLost } = current as Running;
        log.warn({ jobId: job.id, crateId: job.crateId, kind: job.kind }, 'Stopping the job: another worker holds it');
        claimLost.abort();
      }
      await returnDeadWorkersJobs(prisma);
    } catch (error) {
      log.warn({ err: error }, 'Heartbeat failed');
    }
  };
  // One beat at a time, the last awaited before the worker row is removed
  let beating = Promise.resolve();
  const beats = setInterval(() => {
    beating = beating.then(beat);
  }, intervals.heartbeatMilliseconds);
  let ready = false;
  let swept = false;
  /** A job stopped or cut short by an outage, released once the database answers or the worker stops */
  let unreleased: Job | undefined;
  try {
    while (!signal.aborted) {
      let job: Job | undefined;
      try {
        if (!ready) {
          await prepareSearchIndex(deps.opensearch, search);
          ready = true;
        }
        if (unreleased) {
          await release(prisma, workerId, unreleased);
          unreleased = undefined;
        }
        job = await claim(prisma, workerId);
        // Idle polls leave dead workers' jobs to the heartbeat
        if (!job && !swept) {
          await returnDeadWorkersJobs(prisma);
          job = await claim(prisma, workerId);
        }
        swept = !job;
        if (job) {
          const claimLost = new AbortController();
          running = { job, progress: new Progress(AbortSignal.any([signal, claimLost.signal])), claimLost };
          await run(deps, writers, parents, workerId, running);
        } else if (options.until === 'aborted' || (options.until === 'finished' && (await unfinished(prisma, options.crateIds)))) {
          await sleep(intervals.pollMilliseconds, undefined, { signal }).catch(() => {});
        } else {
          return;
        }
      } catch (error) {
        unreleased ??= job;
        if (isOutage(error)) {
          log.warn({ err: error }, 'Paused: the database or search is unavailable');
          await waitForServices(deps, intervals.retryMilliseconds, signal);
        } else if (!signal.aborted) {
          throw error;
        }
      } finally {
        running = undefined;
      }
    }
  } finally {
    // Left to the dead-worker sweep when the database can't be reached
    const job = unreleased;
    if (job) {
      await release(prisma, workerId, job).catch((error: unknown) => log.warn({ err: error, jobId: job.id, crateId: job.crateId }, 'Job not released'));
    }
    clearInterval(beats);
    await beating;
    await removeWorker(prisma, workerId).catch((error: unknown) => log.warn({ err: error }, 'Worker not removed'));
  }
}
