export type Entity = {
  '@id': string;
} & {
  [key: string]: unknown[];
}
