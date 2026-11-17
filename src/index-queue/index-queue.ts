import type { StorageRoot } from '@ocfl/ocfl-fs';
import { type IndexJobKind, Prisma, type PrismaClient } from '../generated/prisma/client.ts';
import { crateIds } from '../repository/repository.ts';

/** A worker whose heartbeat is older than this is not running */
export const WORKER_SILENT_MILLISECONDS = 5 * 60 * 1000;

export const STATES = ['not indexed', 'queued', 'indexing', 'deleting', 'indexed', 'failed'] as const;

export type StateName = (typeof STATES)[number];

/** A crate's one index state: a running or waiting job, else a failed job, else what its record says */
type IndexState =
  | { state: 'not indexed' }
  | { state: 'queued' }
  | { state: 'indexing'; startedAt: Date; stage: string | null; done: number | null; total: number | null }
  | { state: 'deleting' }
  | { state: 'indexed'; version: number; indexedAt: Date; entities: number; files: number }
  | { state: 'failed'; error: string; stage: string | null; failedOn: string | null; failedAt: Date; attempts: number };

/** The ids of the crates `id` is under, nearest first: a crate is under another when its id extends the other's by a path */
export function* ancestorIds(id: string) {
  let path = id.replace(/\/+$/, '');
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/')) {
    path = path.slice(0, slash);
    yield path;
    yield `${path}/`;
  }
}

const isWithin = (id: string, crateId: string) => id === crateId || ancestorIds(id).some((ancestor) => ancestor === crateId);

/** Asks for the crate alone, or with `under`, for it and every crate under it */
type Scope = { under?: boolean };

export type CrateState = { id: string; name: string | null } & IndexState;

type StateRow = {
  id: string;
  name: string | null;
  state: StateName;
  indexedVersion: number;
  indexedAt: Date;
  entities: number;
  files: number;
  startedAt: Date;
  stage: string | null;
  done: number | null;
  total: number | null;
  error: string;
  failedStage: string | null;
  failedOn: string | null;
  failedAt: Date;
  attempts: number;
};

/** Each crate with its state, and the columns that state shows. A job with no crate, deleting everything, is every crate's */
const stateRows = (where: Prisma.Sql) => Prisma.sql`
  SELECT crate.id, crate.name, crate."indexedVersion", crate."indexedAt", crate.entities, crate.files,
    active."startedAt", active.stage, active.done, active.total,
    failed.error, failed.stage AS "failedStage", failed."failedOn", failed."failedAt", failed.attempts,
    CASE
      WHEN active.kind = 'delete' THEN 'deleting'
      WHEN active.status = 'running' THEN 'indexing'
      WHEN active.status = 'waiting' THEN 'queued'
      WHEN failed.id IS NOT NULL THEN 'failed'
      WHEN crate."indexedVersion" IS NOT NULL THEN 'indexed'
      ELSE 'not indexed'
    END AS state
  FROM crate
  LEFT JOIN LATERAL (
    SELECT kind, status, "startedAt", stage, done, total FROM index_job
    WHERE ("crateId" = crate.id OR "crateId" IS NULL) AND status IN ('running', 'waiting')
    ORDER BY status = 'running' DESC, id LIMIT 1
  ) active ON true
  LEFT JOIN index_job failed ON failed."crateId" = crate.id AND failed.status = 'failed'
  ${where}`;

const indexState = (row: StateRow): IndexState => {
  switch (row.state) {
    case 'indexing':
      return { state: row.state, startedAt: row.startedAt, stage: row.stage, done: row.done, total: row.total };
    case 'indexed':
      return { state: row.state, version: row.indexedVersion, indexedAt: row.indexedAt, entities: row.entities, files: row.files };
    case 'failed':
      return { state: row.state, error: row.error, stage: row.failedStage, failedOn: row.failedOn, failedAt: row.failedAt, attempts: row.attempts };
    default:
      return { state: row.state };
  }
};

const crateState = (row: StateRow): CrateState => ({ id: row.id, name: row.name, ...indexState(row) });

type Failure = { crateId: string; error: string; stage: string | null; failedOn: string | null };

/** What became of the crates a run asked for */
export type Summary = { indexed: number; skipped: number; deleted: number; failed: Failure[] };

type OutcomeRow = { id: string; listed: boolean; indexedVersion: number | null; indexedAt: Date | null } & Pick<Failure, 'error' | 'stage' | 'failedOn'>;

/** Asks for index jobs, and reads each crate's index state. The only part of indexing the API uses */
export function createIndexQueue({ prisma, repository }: { prisma: PrismaClient; repository: StorageRoot }) {
  /**
   * Leaves one waiting job for the crate: asking again while one waits changes only its kind, to the one asked for,
   * except that a waiting reindex stays one
   */
  const ask = async (crateId: string, kind: IndexJobKind) => {
    await prisma.$transaction([
      prisma.$executeRaw`INSERT INTO crate (id) VALUES (${crateId}) ON CONFLICT DO NOTHING`,
      prisma.$executeRaw`
        INSERT INTO index_job ("crateId", kind) VALUES (${crateId}, ${kind}::index_job_kind)
        ON CONFLICT ("crateId") WHERE status = 'waiting'
        DO UPDATE SET kind = CASE WHEN index_job.kind = 'reindex' AND EXCLUDED.kind = 'index' THEN index_job.kind ELSE EXCLUDED.kind END`,
    ]);
  };

  const recordIds = async () => (await prisma.crateRecord.findMany({ select: { id: true } })).map(({ id }) => id);

  /** `crateId` and, with `under`, the crates under it, in the repository or listed */
  const covered = async (crateId: string, { under = false }: Scope) => {
    if (!under) {
      return [crateId];
    }
    const ids = new Set([crateId, ...(await Array.fromAsync(crateIds(repository))), ...(await recordIds())]);
    return [...ids].filter((id) => isWithin(id, crateId));
  };

  const askFor = async (crateId: string, kind: IndexJobKind, scope: Scope = {}) => {
    const asked = await covered(crateId, scope);
    for (const id of asked) {
      await ask(id, kind);
    }
    return asked;
  };

  const states = (where = Prisma.empty) => prisma.$queryRaw<StateRow[]>`${stateRows(where)} ORDER BY crate.id`;

  return {
    /** Asks to index `crateId`, or it and those under it, returning the ids asked for */
    index: (crateId: string, scope?: Scope) => askFor(crateId, 'index', scope),

    /** Index regardless of the indexed version */
    reindex: (crateId: string, scope?: Scope) => askFor(crateId, 'reindex', scope),

    delete: (crateId: string, scope?: Scope) => askFor(crateId, 'delete', scope),

    /** Asks to empty both indexes and clear every crate's indexed version, discarding the jobs waiting */
    async deleteEverything() {
      await prisma.$transaction([
        prisma.indexJob.deleteMany({ where: { status: 'waiting' } }),
        prisma.$executeRaw`INSERT INTO index_job (kind) VALUES ('delete') ON CONFLICT ("crateId") WHERE status = 'waiting' DO NOTHING`,
      ]);
    },

    /** Asks to index, or reindex, every crate in the repository, and delete each listed crate gone from it, returning their ids */
    async indexEverything({ reindex = false } = {}) {
      const asked: string[] = [];
      for await (const crateId of crateIds(repository)) {
        await ask(crateId, reindex ? 'reindex' : 'index');
        asked.push(crateId);
      }
      const listed = new Set(asked);
      for (const crateId of await recordIds()) {
        if (!listed.has(crateId) && !(await repository.has(crateId))) {
          await ask(crateId, 'delete');
          asked.push(crateId);
        }
      }
      return asked;
    },

    /** Every crate known to be in the repository, by id */
    crates: async () => (await states()).map(crateState),

    /** The crate `crateId`, if it is known to be in the repository */
    crate: async (crateId: string) => (await states(Prisma.sql`WHERE crate.id = ${crateId}`)).map(crateState)[0],

    /** How many crates are in each state */
    async counts() {
      const rows = await prisma.$queryRaw<{ state: StateName; count: number }[]>`
        SELECT state, count(*)::int AS count FROM (${stateRows(Prisma.empty)}) states GROUP BY state`;
      return Object.fromEntries(STATES.map((state) => [state, rows.find((row) => row.state === state)?.count ?? 0])) as Record<StateName, number>;
    },

    /**
     * Starts a run, noting when each crate was last indexed. Its `summary` says what became of the crates it asked for,
     * once their jobs are finished: a crate indexed at the same time as before was skipped
     */
    async startRun() {
      const before = new Map(
        (await prisma.crateRecord.findMany({ select: { id: true, indexedAt: true } })).map(({ id, indexedAt }) => [id, indexedAt?.getTime()]),
      );
      return {
        async summary(crateIds: string[]): Promise<Summary> {
          const rows = await prisma.$queryRaw<OutcomeRow[]>`
            SELECT asked.id, crate.id IS NOT NULL AS listed, crate."indexedVersion", crate."indexedAt", failed.error, failed.stage, failed."failedOn"
            FROM unnest(${crateIds}::text[]) AS asked(id)
            LEFT JOIN crate ON crate.id = asked.id
            LEFT JOIN index_job failed ON failed."crateId" = asked.id AND failed.status = 'failed'
            ORDER BY asked.id`;
          const summary: Summary = { indexed: 0, skipped: 0, deleted: 0, failed: [] };
          for (const { id, listed, indexedVersion, indexedAt, error, stage, failedOn } of rows) {
            if (error !== null) {
              summary.failed.push({ crateId: id, error, stage, failedOn });
            } else if (!listed || indexedVersion === null) {
              summary.deleted++;
            } else if (indexedAt?.getTime() === before.get(id)) {
              summary.skipped++;
            } else {
              summary.indexed++;
            }
          }
          return summary;
        },
      };
    },

    /** Whether any worker, or CLI run working the queue, has a fresh heartbeat */
    workerRunning: async () => (await prisma.indexWorker.count({ where: { heartbeatAt: { gt: new Date(Date.now() - WORKER_SILENT_MILLISECONDS) } } })) > 0,
  };
}

export type IndexQueue = ReturnType<typeof createIndexQueue>;
