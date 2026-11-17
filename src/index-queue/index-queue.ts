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
  | { state: 'indexing'; startedAt: Date }
  | { state: 'deleting' }
  | { state: 'indexed'; version: number; indexedAt: Date; entities: number; files: number }
  | { state: 'failed'; error: string; failedAt: Date; attempts: number };

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
  error: string;
  failedAt: Date;
  attempts: number;
};

/** Each crate with its state, and the columns that state shows */
const stateRows = (where: Prisma.Sql) => Prisma.sql`
  SELECT crate.id, crate.name, crate."indexedVersion", crate."indexedAt", crate.entities, crate.files,
    active."startedAt", failed.error, failed."failedAt", failed.attempts,
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
    SELECT kind, status, "startedAt" FROM index_job
    WHERE "crateId" = crate.id AND status IN ('running', 'waiting')
    ORDER BY status = 'running' DESC LIMIT 1
  ) active ON true
  LEFT JOIN LATERAL (
    SELECT id, error, "failedAt", attempts FROM index_job
    WHERE "crateId" = crate.id AND status = 'failed'
    ORDER BY id DESC LIMIT 1
  ) failed ON true
  ${where}`;

const indexState = (row: StateRow): IndexState => {
  switch (row.state) {
    case 'indexing':
      return { state: row.state, startedAt: row.startedAt };
    case 'indexed':
      return { state: row.state, version: row.indexedVersion, indexedAt: row.indexedAt, entities: row.entities, files: row.files };
    case 'failed':
      return { state: row.state, error: row.error, failedAt: row.failedAt, attempts: row.attempts };
    default:
      return { state: row.state };
  }
};

const crateState = (row: StateRow): CrateState => ({ id: row.id, name: row.name, ...indexState(row) });

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

  const states = (where = Prisma.empty) => prisma.$queryRaw<StateRow[]>`${stateRows(where)} ORDER BY crate.id`;

  return {
    index: (crateId: string) => ask(crateId, 'index'),

    /** Index regardless of the indexed version */
    reindex: (crateId: string) => ask(crateId, 'reindex'),

    delete: (crateId: string) => ask(crateId, 'delete'),

    /** Asks to index, or reindex, every crate in the repository, returning their ids */
    async indexEverything({ reindex = false } = {}) {
      const asked: string[] = [];
      for await (const crateId of crateIds(repository)) {
        await ask(crateId, reindex ? 'reindex' : 'index');
        asked.push(crateId);
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

    /** The failed jobs of the crates among `crateIds` */
    failures: (crateIds: string[]) =>
      prisma.indexJob.findMany({ where: { crateId: { in: crateIds }, status: 'failed' }, select: { crateId: true, error: true }, orderBy: { crateId: 'asc' } }),

    /** Whether any worker, or CLI run working the queue, has a fresh heartbeat */
    workerRunning: async () => (await prisma.indexWorker.count({ where: { heartbeatAt: { gt: new Date(Date.now() - WORKER_SILENT_MILLISECONDS) } } })) > 0,
  };
}

export type IndexQueue = ReturnType<typeof createIndexQueue>;
