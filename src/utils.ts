export function firstStringOrId(values: unknown[]): string | undefined {
  for (const value of values || []) {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null && '@id' in value && typeof value['@id'] === 'string') {
      return value['@id'];
    }
  }
}
