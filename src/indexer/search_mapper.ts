import type { Entity } from '../types.ts';

type PropertyMapperFn = (
  value: unknown,
  opt?: { deferredEntities?: Entity[]; properties?: Record<string, any> },
) => unknown | undefined;

const indexableText: PropertyMapperFn = (value, { deferredEntities }) => {
  if ('@id' in (value as object) && deferredEntities) {
    deferredEntities.push(value as Entity);
  }
  return value;
};

const defaultText: PropertyMapperFn = (value) => (value as { '@value'?: unknown })['@value'] || value;

const defaultEntityName: PropertyMapperFn = (value) =>
  (value as { name?: unknown[] }).name?.map((v) => defaultText(v))[0] ||
  (value as { '@value'?: unknown })['@value'] ||
  value;

const dataTypeDate: PropertyMapperFn = (value) => {
  const datestr = typeof value !== 'string' ? '' + value : value;
  let [gte, lte] = datestr.split('/').map((d) => new Date(d).valueOf());
  if (lte == null) lte = gte;
  else return { gte, lte };
};

const location: PropertyMapperFn = (value, { properties }) => {
  const place = value as { longitude?: number | string; latitude?: number | string; geo?: unknown[] };
  const location = []; // index geolocation in a separate field to support geo search, this location name is hardcoded
  if (place.longitude != null && place.latitude != null) {
    location.push({ type: 'point', coordinates: [place.longitude, place.latitude] });
  }
  for (const geo of place.geo || []) {
    if (typeof geo === 'string') {
      location.push(geo);
    } else if (geo.asWKT) {
      location.push(geo.asWKT);
    }
  }
  console.log('location', location);
  if (location.length) properties.location = location;
  if (value['@id']) return { '@id': value['@id'] };
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

export function mapDefaultProperties(value: any) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { '@value': value };
    case 'object':
      if (value['@id']) {
        const o = { '@id': value['@id'] } as any;
        for (const prop of ['name', 'alternateName']) {
          if (value[prop]?.length) o[prop] = value[prop].map(mapDefaultProperties);
        }
        return o;
      } else {
        return value;
      }
    default:
      return { '@value': value.toString() };
  }
}
