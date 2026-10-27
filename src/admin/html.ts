/** HTML that is already safe to include in a page */
export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeValue = (value: unknown): string => {
  if (value instanceof Html) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(escapeValue).join('');
  }
  if (value === undefined || value === null || value === false) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, (char) => escapes[char] ?? char);
};

/** Builds HTML, escaping every interpolated value that isn't already `Html` */
export const html = (strings: TemplateStringsArray, ...values: unknown[]) =>
  new Html(strings.reduce((built, string, i) => built + escapeValue(values[i - 1]) + string));
