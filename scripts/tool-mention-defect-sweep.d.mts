export declare function maskedLine(line: string, toolNames?: string[]): string[];

export declare function splitSentences(line: string): string[];

export declare function classifySentence(
  sentence: string
): "instruction" | "prohibition" | "incidental";

export declare function assertPlaceholderSane(placeholder: string): boolean;
