import type { Client } from '@opensearch-project/opensearch';
import type { FieldDeclarations, SearchDocument } from 'arocapi';
import { OpenSearchBackend } from 'arocapi/search/opensearch';
import { config } from './configuration.ts';

const fields = {
  name: { type: 'text', label: 'Name', weight: 3, advanced: true, sort: true },
  description: { type: 'text', label: 'Description', advanced: true },
  text: { type: 'text', label: 'Text', advanced: true },
  entityType: { type: 'keyword', label: 'Entity Type', filter: true },
  recordType: { type: 'keyword', label: 'Record Type', facet: true },
  inLanguage: { type: 'keyword', label: 'Language', advanced: true, facet: true },
  communicationMode: { type: 'keyword', label: 'Communication Mode', facet: true },
  linguisticGenre: { type: 'keyword', label: 'Linguistic Genre', facet: true },
  annotationType: { type: 'keyword', label: 'Annotation Type', facet: true },
  encodingFormat: { type: 'keyword', label: 'File Format', facet: true },
  rootCollection: { type: 'keyword', label: 'Collection', facet: true },
  memberOf: { type: 'keyword', label: 'Member Of', facet: true },
  license: { type: 'keyword', label: 'License', facet: true },
  datePublished: { type: 'date', label: 'Date Published', filter: true, sort: true },
  dateCreated: { type: 'date', label: 'Date Created', filter: true },
  temporalCoverage: { type: 'date', label: 'Temporal Coverage', filter: true },
  location: { type: 'geo' },
} as const satisfies FieldDeclarations;

export type Document = SearchDocument<typeof fields>;

export const createSearchBackend = (client: Client) => OpenSearchBackend({ client, fields, indexName: config.search.entityIndex });

export type SearchBackend = ReturnType<typeof createSearchBackend>;

/** Creates the search index if it is missing, as each worker does on starting. arocapi creates it with its mapping only, so a template supplies our settings */
export async function prepareSearchIndex(client: Client, search: SearchBackend) {
  const name = config.search.entityIndex;
  await client.indices.putIndexTemplate({
    name,
    body: {
      index_patterns: [name],
      template: { settings: { index: { auto_expand_replicas: '0-1', max_result_window: 100000 } } },
    },
  });
  try {
    await search.createIndex();
  } catch (error) {
    // Another worker created it after this one found it missing: check its mapping instead
    if ((error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type !== 'resource_already_exists_exception') {
      throw error;
    }
    await search.createIndex();
  }
}

/** Makes changes searchable now, rather than at OpenSearch's next periodic refresh */
export const refreshSearchIndex = (client: Client, index = config.search.entityIndex) => client.indices.refresh({ index, ignore_unavailable: true });

/** Deletes the search index and every document in it */
export const deleteSearchIndex = (client: Client, index = config.search.entityIndex) => client.indices.delete({ index, ignore_unavailable: true });
