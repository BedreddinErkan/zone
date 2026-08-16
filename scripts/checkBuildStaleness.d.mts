export declare function isBuildRelevantSource(relPath: string): boolean;

export interface SourceFileMtime {
  relPath: string;
  mtimeMs: number;
}

export declare function describeBuildStaleness(input: {
  buildTimeMs: number | null;
  sourceFiles: SourceFileMtime[];
}): string | null;
