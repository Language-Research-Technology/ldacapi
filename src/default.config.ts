import { env } from 'node:process';
import packageJson from '../package.json' with { type: 'json' };

export const DEFAULT_DATABASE_URL = `postgresql://ldacapi:ldacapi@localhost:5432/ldacapi${env.NODE_ENV === 'test' ? '_test' : ''}`;

const isDev = env.NODE_ENV ? env.NODE_ENV === 'development' || env.NODE_ENV === 'dev' : true;
export default {
  package: packageJson,
  isDev,
  databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,
  opensearchUrl: env.OPENSEARCH_URL || 'http://localhost:9200',
  port: parseInt(env.LDACAPI_PORT || '8080', 10),
  host: env.LDACAPI_HOST,
  logLevel: env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  maxParamLength: parseInt(env.LDACAPI_MAX_PARAM_LENGTH || '500', 10),
  tokenAdmin: env.TOKEN_ADMIN || '1234-1234-1234-1234',
  defaultLicense: '',
  defaultMetadataLicense: '',
  openLicenses: [
    'https://creativecommons.org/licenses/by/3.0/au/',
    'https://creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://creativecommons.org/licenses/by-nd/3.0/au/',
  ],
  prefix: '/api',
  prefixAuth: '',
  rems: {
    user: env.REMS_USER || '',
    key: env.REMS_KEY || '',
    endpoint: env.REMS_ENDPOINT || '',
  },
  enrollmentUrl: env.ENROLLMENT_URL || '',
  oidc: {
    endpoint: env.OIDC_ENDPOINT || '',
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    userinfoEndpoint: '',
  },
  indexType: {
    RepositoryCollection: 'https://w3id.org/ldac/profile#Collection',
    RepositoryObject: 'https://w3id.org/ldac/profile#Object',
    File: '',
    Person: 'https://w3id.org/ldac/profile#Person',
    Organization: 'https://w3id.org/ldac/profile#Organization',
    SoftwareApplication: 'https://w3id.org/ldac/profile#SoftwareApplication',
  },
  search: {
    cluster: {
      persistent: {
        'search.max_open_scroll_context': 5000,
      },
      transient: {
        'search.max_open_scroll_context': 5000,
      },
    },
    create: {
      settings: {
        index: {
          max_result_window: 100000,
          highlight: {
            max_analyzed_offset: 1000000,
          },
          mapping: {
            total_fields: {
              limit: 1000,
            },
          },
        },
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
            },
          },
          //recordType: { type: 'keyword' },
          //root: { type: 'keyword' },
          inLanguage: { type: 'keyword' },
          location: { type: 'geo_shape' }, //the property name `location` used for map search is hardcoded.
          //location: { type: 'geo_shape', doc_values: false },
          mediaType: { type: 'keyword' },
          datePublished: { type: 'date_range' },
          dateCreated: { type: 'date_range' },
          temporalCoverage: { type: 'date_range' },
          _text: { type: 'text' },
          //communicationMode: { type: 'keyword' },
          // createdAt: { type: 'date' },
          // updatedAt: { type: 'date' },
        },
      },
    },
    aggregations: {
      //      entityType: { terms: { field: 'entityType' } },
      '@type': { terms: { field: '@type' } },
      inLanguage: { terms: { field: 'inLanguage' } },
    },
    entityIndex: env.ENTITY_INDEX || 'entities',
  },
};
