export declare function isBuildRelevantSource(relPath: string): boolean;

export interface SourceFileMtime {
  relPath: string;
  mtimeMs: number;
}

export declare function describeBuildStaleness(input: {
  buildTimeMs: number | null;
  sourceFiles: SourceFileMtime[];
}): string | null;

export declare function computeBuildStaleness(input?: {
  srcDir?: string;
  proxyPath?: string;
}): { message: string | null; srcDir: string; proxyPath: string | null };

export declare function assertBuildFresh(label: string): void;
