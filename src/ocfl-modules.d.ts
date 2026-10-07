declare module '@ocfl/ocfl' {
  export interface OcflObjectFile {
    contentPath?: string;
    size?: string;
    fixity?: Record<string, string>;
    text(encoding?: string): Promise<string>;
    stream(options?: unknown): Promise<ReadableStream>;
    stat(options?: unknown): Promise<{ size?: number; atime?: Date; mtime?: Date; ctime?: Date }>;
  }

  export interface OcflObject {
    id: string;
    root: string;
    load(): Promise<void>;
    import(source: string): Promise<void>;
    getInventory(): Promise<{ id: string }>;
    getFile(ref: { logicalPath: string }): OcflObjectFile;
  }

  export interface OcflStorage extends AsyncIterable<OcflObject> {
    load(): Promise<void>;
    create(): Promise<void>;
    exists(): Promise<boolean>;
    object(id: string): OcflObject;
    objectRoot(id: string): string;
  }
}

declare module '@ocfl/ocfl-fs' {
  import type { OcflStorage } from '@ocfl/ocfl';

  function storage(options: {
    root: string;
    workspace?: string;
    ocflVersion?: string;
    fixityAlgorithms?: string[];
    layout?: { extensionName: string };
  }): OcflStorage;

  const ocfl: { storage: typeof storage };
  export default ocfl;
}
