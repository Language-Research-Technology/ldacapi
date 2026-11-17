import type { CrateState, StateName } from '../index-queue/index-queue.ts';
import { STATES } from '../index-queue/index-queue.ts';

type Crate = CrateState & { label: string; children: Crate[] };

/** How often the page reloads while a crate's indexes are changing */
const REFRESH_SECONDS = 5;

const CHANGING: StateName[] = ['queued', 'indexing', 'deleting'];

/** The ids of the crates `id` is under, nearest first */
function* ancestorIds(id: string) {
  let path = id.replace(/\/+$/, '');
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/')) {
    path = path.slice(0, slash);
    yield path;
    yield `${path}/`;
  }
}

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

/** A form posting `crateId` (none for every crate) to an action */
type ActionForm = { action: 'index' | 'delete'; label: string; crateId?: string | undefined; force?: boolean; confirm?: string };

type CrateRow = { id: string; label: string; state: StateName; detail?: string | undefined; actions: ActionForm[]; children: CrateRow[] };

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const time = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16);

/** What the state shows beside its name */
const detail = (crate: CrateState) => {
  switch (crate.state) {
    case 'indexed':
      return `v${crate.version}, ${time(crate.indexedAt)} UTC, ${counted(crate.entities, 'entity', 'entities')}, ${counted(crate.files, 'file', 'files')}`;
    case 'indexing':
      return `since ${time(crate.startedAt)} UTC`;
    case 'failed':
      return `${crate.error} (${time(crate.failedAt)} UTC, attempt ${crate.attempts})`;
    default:
      return undefined;
  }
};

const crateRow = (crate: Crate): CrateRow => ({
  id: crate.id,
  label: crate.label,
  state: crate.state,
  detail: detail(crate),
  actions: [
    { action: 'index', label: 'Index', crateId: crate.id },
    { action: 'index', label: 'Reindex', crateId: crate.id, force: true },
    { action: 'delete', label: 'Delete', crateId: crate.id, confirm: `Delete the indexes of ${crate.label}?` },
  ],
  children: crate.children.map(crateRow),
});

const ALL_ACTIONS: ActionForm[] = [
  { action: 'index', label: 'Index all' },
  { action: 'index', label: 'Reindex all', force: true },
];

/** The crates as a tree, how many are in each state, and a refresh while any is changing */
export const cratesPage = (crates: CrateState[], counts: Record<StateName, number>, workerRunning: boolean) => ({
  refresh: CHANGING.some((state) => counts[state] > 0) ? REFRESH_SECONDS : undefined,
  workerRunning,
  counts: STATES.map((state) => ({ state, count: counts[state] })),
  actions: ALL_ACTIONS,
  crates: buildTree(crates).map(crateRow),
});
