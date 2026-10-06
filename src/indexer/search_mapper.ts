import type { Entity } from '../types.ts';

type PropertyMapperFn = (value: unknown, opt?: { deferredEntities?: Entity[]; properties?: Record<string, unknown> }) => unknown | undefined;

const indexableText: PropertyMapperFn = (value, { deferredEntities } = {}) => {
  if ('@id' in (value as object) && deferredEntities) {
    deferredEntities.push(value as Entity);
  }
  return value;
};

const defaultText: PropertyMapperFn = (value) => (value as { '@value'?: unknown })['@value'] || value;

const defaultEntityName: PropertyMapperFn = (value) =>
  (value as { name?: unknown[] }).name?.map((v) => defaultText(v))[0] || (value as { '@value'?: unknown })['@value'] || value;

const dataTypeDate: PropertyMapperFn = (value) => {
  const datestr = typeof value !== 'string' ? `${value}` : value;
  let [gte, lte] = datestr.split('/').map((d) => new Date(d).valueOf());
  if (lte == null) {
    lte = gte;
  }
  return { gte, lte };
};

const location: PropertyMapperFn = (value, { properties } = {}) => {
  const place = value as {
    longitude?: number | string;
    latitude?: number | string;
    geo?: (string | { asWKT?: string[] })[];
    name?: unknown;
  };
  const locations = [];
  if (place.longitude != null && place.latitude != null) {
    locations.push(`POINT(${place.longitude} ${place.latitude})`); //{ type: 'point', coordinates: [place.longitude, place.latitude] }
  }
  for (const geo of place.geo || []) {
    if (typeof geo === 'string') {
      locations.push(geo);
    } else if (geo.asWKT) {
      locations.push(...geo.asWKT);
    }
  }
  if (locations.length && properties) {
    properties._locations = locations;
  }
  //if (value['@id']) return { '@id': value['@id'], name: value.name };
  return place.name;
};

export const dataTypeMapper: Record<string, PropertyMapperFn> = {
  date: dataTypeDate,
  date_range: dataTypeDate,
};

export const propertyMapper: Record<string, PropertyMapperFn> = {
  indexableText: indexableText,
  mainText: indexableText,
  name: defaultText,
  description: defaultText,
  '@type': defaultText,
  inLanguage: defaultEntityName,
  contentLocation: location,
  spatialCoverage: location,
};

export function mapDefaultProperties(value: unknown): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { '@value': value };
    case 'object': {
      const entity = value as Record<string, unknown[] | undefined>;
      if (entity['@id']) {
        const o: Record<string, unknown> = { '@id': entity['@id'] };
        for (const prop of ['name', 'alternateName']) {
          if (entity[prop]?.length) {
            o[prop] = entity[prop].map(mapDefaultProperties);
          }
        }
        return o;
      } else {
        return value;
      }
    }
    default:
      return { '@value': String(value) };
  }
}
