import type { Entity } from '../types.ts';

type PropertyMapperFn = (value: unknown, deferredEntities?: Entity[]) => unknown|undefined;

const indexableText: PropertyMapperFn = (value, deferredEntities) => {
    if ('@id' in (value as object) && deferredEntities) {
      deferredEntities.push(value as Entity);
    }
    return value;
  };

const defaultText:PropertyMapperFn = (value) => (value as { '@value'?: unknown })['@value'] || value;

const defaultEntityName: PropertyMapperFn = (value) => (value as { name?: unknown[] }).name?.map(v => defaultText(v))[0] || (value as { '@value'?: unknown })['@value'] || value;

const dataTypeDate: PropertyMapperFn = (value) => {
  const datestr = typeof value !== 'string' ? '' + value : value;
  let [gte, lte] = datestr.split('/').map((d) => new Date(d).valueOf());
  if (lte == null) lte = gte;
  else return { gte, lte };
}

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
};
