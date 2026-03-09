import packageJson from '../package.json' with { type: 'json' };
export default {
  package: packageJson,
  tokenAdmin: process.env.TOKEN_ADMIN || '1234-1234-1234-1234',
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
        properties: {
          '@id': { type: 'keyword' },
          '@type': { type: 'keyword' },
          rocrateRootId: { type: 'keyword' },
          rocrateId: { type: 'keyword' },
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
          location: { type: 'geo_point' },
          mediaType: { type: 'keyword' },
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
    entityIndex: process.env.ENTITY_INDEX || 'entities'
  }
}