import { env } from 'node:process';
import packageJson from '../package.json' with { type: 'json' };

const isDev = env.NODE_ENV ? (env.NODE_ENV === 'development' || env.NODE_ENV === 'dev') : true;
export default {
  package: packageJson,
  isDev,
  databaseUrl: env.DATABASE_URL || 'postgresql://ldaca:ldaca@localhost:5432/ldaca',
  opensearchUrl: env.OPENSEARCH_URL || 'http://localhost:9200',
  port: parseInt(env.LDACAPI_PORT || '8080'),
  host: env.LDACAPI_HOST,
  logLevel: env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  tokenAdmin: env.TOKEN_ADMIN || '1234-1234-1234-1234',
  defaultLicense: '',
  defaultMetadataLicense: '',
  prefix: '/api',
  indexType: {
    RepositoryCollection: 'https://w3id.org/ldac/profile#Collection',
    RepositoryObject: 'https://w3id.org/ldac/profile#Object',
    File: '',
    Person: 'https://w3id.org/ldac/profile#Person',
    Organization: 'https://w3id.org/ldac/profile#Organization',
    SoftwareApplication: 'https://w3id.org/ldac/profile#SoftwareApplication'
  },
  search: {
    cluster: {
      persistent: {
        "search.max_open_scroll_context": 5000
      },
      transient: {
        "search.max_open_scroll_context": 5000
      }
    },
    create: {
      settings: {
        index: {
          max_result_window: 100000,
          highlight: {
            max_analyzed_offset: 1000000
          },
          mapping: {
            total_fields: {
              limit: 1000
            }
          }
        }
      },
      mappings: {
        // _source: {
        //   excludes: ['_text']
        // },
        // _source: { enabled: false },
        dynamic: true,
        date_detection: false,
        properties: {
          '@id': { type: 'keyword' },
          '@type': { type: 'keyword' },
          rocrateRootId: { type: 'keyword' },
          id: { type: 'keyword' },
          entityId: { type: 'keyword' },
          entityType: { type: 'keyword' },
          memberOf: { type: 'keyword' },
          rootCollection: { type: 'keyword' },
          metadataLicenseId: { type: 'keyword' },
          contentLicenseId: { type: 'keyword' },
          name: {
            type: 'text',
            fields: {
              keyword: { type: 'keyword' },
            },
          },
          description: { type: 'text' },
          conformsTo: {
            properties: {
              '@id': { type: 'keyword' },
            }
          },
          //recordType: { type: 'keyword' },
          //root: { type: 'keyword' },
          inLanguage: { type: 'keyword' },
          location: { type: 'geo_shape', doc_values: false }, //at the moment the property name location is hardcoded.
          mediaType: { type: 'keyword' },
          datePublished: { type: 'date_range' },
          dateCreated: { type: 'date_range' },
          temporalCoverage: { type: 'date_range' },
          _text: { type: 'text' }
          //communicationMode: { type: 'keyword' },
          // createdAt: { type: 'date' },
          // updatedAt: { type: 'date' },
        }
      }
    },
    aggregations: {
//      entityType: { terms: { field: 'entityType' } },
      '@type': { terms: { field: '@type' } },
      inLanguage: { terms: { field: 'inLanguage' } }
    },
    entityIndex: env.ENTITY_INDEX || 'entities'
  }
}