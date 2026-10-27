import { hasState, type RepositoryObject, State } from '../repository.ts';
import { ADMIN_PATH } from './client.ts';
import { type Html, html } from './html.ts';

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

const BUTTON = 'cursor-pointer rounded border px-2 py-0.5 text-sm';
const INDEX_BUTTON = `${BUTTON} border-zinc-300 bg-white hover:border-amber-500 hover:bg-amber-50`;
const DELETE_BUTTON = `${BUTTON} border-red-300 bg-white text-red-700 hover:bg-red-50`;

/** A form posting `crateId` (none for every crate) to an action */
const actionForm = (action: 'index' | 'delete', label: string, crateId?: string, { force = false, confirm }: { force?: boolean; confirm?: string } = {}) =>
  html`<form method="post" action="${ADMIN_PATH}/${action}" class="inline"${confirm && html` data-confirm="${confirm}"`}>${crateId && html`<input type="hidden" name="crateId" value="${crateId}">`}${force && html`<input type="hidden" name="force" value="true">`}<button type="submit" class="${action === 'delete' ? DELETE_BUTTON : INDEX_BUTTON}">${label}</button></form>`;

const crateActions = (crate: Crate) => {
  const indexed = hasState(crate.state, State.INDEXED);
  const confirm = `Delete the indexes of ${crate.label}${crate.children.length > 0 ? ' and the crates under it' : ''}?`;
  return html`<span class="crate-actions">${actionForm('index', indexed ? 'Reindex' : 'Index', crate.id, { force: indexed })} ${actionForm('delete', 'Delete', crate.id, { confirm })}</span>`;
};

const renderCrates = (crates: Crate[]): Html => html`<ul>
${crates.map(
  (crate) => html`<li data-id="${crate.id}" data-name="${crate.label}">
  <span class="crate-name">${crate.label}</span> <code>${crate.id}</code>
  ${Object.entries(INDEXES).map(([index, label]) => html`<span class="index-state">${label}: ${crate.state[index] ?? 'not indexed'}</span> `)}
  ${crateActions(crate)}
  ${crate.children.length > 0 && renderCrates(crate.children)}
</li>
`,
)}</ul>`;

/** The crates as a tree, and a refresh while any index is changing */
export const cratesPage = (objects: RepositoryObject[]) => {
  const changing = objects.some(({ state }) => hasState(state, State.QUEUED, State.INDEXING, State.DELETING));
  const body =
    objects.length === 0
      ? html`<p>The repository has no crates.</p>`
      : html`<p class="mb-4 flex gap-2">${actionForm('index', 'Index all')} ${actionForm('index', 'Reindex all', undefined, { force: true })} ${actionForm('delete', 'Delete all', undefined, { confirm: 'Delete every index?' })}</p>
    <p><input type="search" id="crate-filter" placeholder="Filter by name" aria-label="Filter crates by name"></p>
    <div id="crates">${renderCrates(buildTree(objects))}</div>`;
  return { head: changing ? html`<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : undefined, body };
};
