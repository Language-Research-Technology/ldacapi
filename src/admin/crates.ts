import type { CrateState, IndexQueue, StateName } from '../index-queue/index-queue.ts';
import { ancestorIds, countStates, STATES } from '../index-queue/index-queue.ts';

type Crate = CrateState & { label: string; children: Crate[] };

/** How often the page reloads while a crate's indexes are changing */
const REFRESH_SECONDS = 5;

const CHANGING: StateName[] = ['queued', 'indexing', 'deleting'];

const parentOf = (id: string, crates: Map<string, Crate>) => {
  for (const ancestor of ancestorIds(id)) {
    const parent = crates.get(ancestor);
    if (parent) {
      return parent;
    }
  }
};

const byLabel = (a: Crate, b: Crate) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

const sortTree = (crates: Crate[]) => {
  crates.sort(byLabel);
  for (const crate of crates) {
    sortTree(crate.children);
  }
  return crates;
};

const buildTree = (states: CrateState[]) => {
  const crates = new Map(states.map((state) => [state.id, { ...state, label: state.name ?? state.id, children: [] as Crate[] }]));
  const roots: Crate[] = [];
  for (const crate of crates.values()) {
    (parentOf(crate.id, crates)?.children ?? roots).push(crate);
  }
  return sortTree(roots);
};

/** A form posting `crateId` (none for every crate), and with `under` the crates under it, to an action */
type ActionForm = { action: 'index' | 'delete'; label: string; crateId?: string | undefined; force?: boolean; under?: boolean; confirm?: string };

type CrateRow = { id: string; label: string; state: StateName; detail?: string | undefined; actions: ActionForm[]; children: CrateRow[] };

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const number = (count: number) => count.toLocaleString('en-AU');

const time = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16);

/** What the state shows beside its name */
const detail = (crate: CrateState) => {
  switch (crate.state) {
    case 'indexed':
      return `v${crate.version}, ${time(crate.indexedAt)} UTC, ${counted(crate.entities, 'entity', 'entities')}, ${counted(crate.files, 'file', 'files')}`;
    case 'indexing': {
      const counter = crate.done === null || crate.total === null ? [] : [`${number(crate.done)} of ${number(crate.total)}`];
      return [crate.stage ?? [], counter, `since ${time(crate.startedAt)} UTC`].flat().join(', ');
    }
    case 'failed': {
      const where = [crate.stage ?? [], crate.failedOn ? `on ${crate.failedOn}` : []].flat();
      return `${crate.error} (${[...where, `${time(crate.failedAt)} UTC`, `attempt ${crate.attempts}`].join(', ')})`;
    }
    default:
      return undefined;
  }
};

const crateActions = (crate: Crate): ActionForm[] => [
  { action: 'index', label: 'Index', crateId: crate.id },
  { action: 'index', label: 'Reindex', crateId: crate.id, force: true },
  { action: 'delete', label: 'Delete', crateId: crate.id, confirm: `Delete the indexes of ${crate.label}?` },
];

const underActions = (crate: Crate): ActionForm[] => [
  { action: 'index', label: 'Index tree', crateId: crate.id, under: true },
  { action: 'index', label: 'Reindex tree', crateId: crate.id, force: true, under: true },
  { action: 'delete', label: 'Delete tree', crateId: crate.id, under: true, confirm: `Delete the indexes of ${crate.label} and the crates under it?` },
];

const crateRow = (crate: Crate): CrateRow => ({
  id: crate.id,
  label: crate.label,
  state: crate.state,
  detail: detail(crate),
  actions: [...crateActions(crate), ...(crate.children.length > 0 ? underActions(crate) : [])],
  children: crate.children.map(crateRow),
});

const ALL_ACTIONS: ActionForm[] = [
  { action: 'index', label: 'Index all' },
  { action: 'index', label: 'Reindex all', force: true },
  { action: 'delete', label: 'Delete all', confirm: 'Delete every index?' },
];

type Failure = Awaited<ReturnType<IndexQueue['deleteEverythingFailure']>>;

const failureDetail = ({ error, stage, failedAt }: NonNullable<Failure>) => `${error} (${[stage ?? [], `${time(failedAt)} UTC`].flat().join(', ')})`;

/** The crates as a tree, how many are in each state, a refresh while any is changing, and how deleting everything last failed */
export const cratesPage = (crates: CrateState[], workerRunning: boolean, deleteEverythingFailure: Failure) => {
  const counts = countStates(crates);
  return {
    refresh: CHANGING.some((state) => counts[state] > 0) ? REFRESH_SECONDS : undefined,
    workerRunning,
    deleteEverythingFailed: deleteEverythingFailure && failureDetail(deleteEverythingFailure),
    counts: STATES.map((state) => ({ state, count: counts[state] })),
    actions: ALL_ACTIONS,
    crates: buildTree(crates).map(crateRow),
  };
};
