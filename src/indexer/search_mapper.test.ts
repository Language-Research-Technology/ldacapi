import { describe, expect, it } from 'vitest';
import { dataTypeMapper } from './search_mapper.ts';

describe('dataTypeMapper.date', () => {
  const mapDate = (value: string) => dataTypeMapper.date?.(value);

  it('maps a single date to a range that starts and ends on that date', () => {
    const date = new Date('2001').valueOf();
    expect(mapDate('2001')).toEqual({ gte: date, lte: date });
  });

  it('maps a date range to its start and end', () => {
    expect(mapDate('2001/2005')).toEqual({ gte: new Date('2001').valueOf(), lte: new Date('2005').valueOf() });
  });
});
