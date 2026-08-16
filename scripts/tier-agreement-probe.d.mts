export interface FallbackMarker {
  reason: string;
  taskHash: string;
}

export declare function hashTask(taskDescription: string): string;

export declare function hasTaskHashMismatch(
  markers: FallbackMarker[],
  expectedTaskHash: string
): boolean;

export declare function isFallbackUnattributed(
  fallbackUsed: boolean,
  markers: FallbackMarker[]
): boolean;

export declare function parseFallbackMarkers(capturedWarnLines: string[]): FallbackMarker[];

export declare function deriveFallbackKind(
  fallbackUsed: boolean,
  markers: FallbackMarker[]
): "invalid_tier" | "truncated" | "low_confidence" | "error" | null;
