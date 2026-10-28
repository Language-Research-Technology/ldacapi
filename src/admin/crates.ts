import { hasState, type RepositoryObject, State } from '../repository.ts';

type Crate = RepositoryObject & { label: string; children: Crate[] };

const INDEXES = { structural: 'Structural', search: 'Search' } as const;

/** How often the page reloads while an index is changing */
const REFRESH_SECONDS = 5;

/** The ids of the crates `id` is under, nearest first, as indexing a crate also indexes the crates under it */
function* ancestorIds(id: string) {
  let path = id.replace(/\/+$/, '');
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/')) {
    path = path.slice(0, slash);
    yield path;
    yield `${path}/`;
  }
}

/** Whether `id` is `crateId` or a crate under it */
export const isWithin = (id: string, crateId: string) => id === crateId || ancestorIds(id).some((ancestor) => ancestor === crateId);

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

const buildTree = (objects: RepositoryObject[]) => {
  const crates = new Map(objects.map((object) => [object.id, { ...object, label: object.name ?? object.id, children: [] as Crate[] }]));
  const roots: Crate[] = [];
  for (const crate of crates.values()) {
    (parentOf(crate.id, crates)?.children ?? roots).push(crate);
  }
  return sortTree(roots);
};

/** A form posting `crateId` (none for every crate) to an action */
type ActionForm = { action: 'index' | 'delete'; label: string; crateId?: string | undefined; force?: boolean; confirm?: string };

type CrateRow = { id: string; label: string; states: { label: string; value: string }[]; actions: ActionForm[]; children: CrateRow[] };

const crateRow = (crate: Crate): CrateRow => {
  const indexed = hasState(crate.state, State.INDEXED);
  const confirm = `Delete the indexes of ${crate.label}${crate.children.length > 0 ? ' and the crates under it' : ''}?`;
  return {
    id: crate.id,
    label: crate.label,
    states: Object.entries(INDEXES).map(([index, label]) => ({ label, value: crate.state[index] ?? 'not indexed' })),
    actions: [
      { action: 'index', label: indexed ? 'Reindex' : 'Index', crateId: crate.id, force: indexed },
      { action: 'delete', label: 'Delete', crateId: crate.id, confirm },
    ],
    children: crate.children.map(crateRow),
  };
};

const ALL_ACTIONS: ActionForm[] = [
  { action: 'index', label: 'Index all' },
  { action: 'index', label: 'Reindex all', force: true },
  { action: 'delete', label: 'Delete all', confirm: 'Delete every index?' },
];

/** The crates as a tree, and a refresh while any index is changing */
export const cratesPage = (objects: RepositoryObject[]) => {
  const changing = objects.some(({ state }) => hasState(state, State.QUEUED, State.INDEXING, State.DELETING));
  return { refresh: changing ? REFRESH_SECONDS : undefined, actions: ALL_ACTIONS, crates: buildTree(objects).map(crateRow) };
};
