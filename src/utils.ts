/** The first string or `@id` of a JSON-LD value, which may be a single value or an array */
export function firstStringOrId(values: unknown): string | undefined {
  for (const value of [values ?? []].flat()) {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null && '@id' in value && typeof value['@id'] === 'string') {
      return value['@id'];
    }
  }
}
