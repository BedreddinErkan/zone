export type DesignSystemSignals = {
  inlineStyleCount: number;
  styleAttributeLines: number;
  addedClassNameCount: number;
  excessiveInlineStyles: boolean;
  reusableClassPreferenceMissed: boolean;
};

export type DesignSystemSignalInput = {
  addedLines: string[];
};

export function detectDesignSystemSignals(
  input: DesignSystemSignalInput
): DesignSystemSignals {
  const inlineStyleCount = input.addedLines.filter((line) =>
    line.includes("style={{")
  ).length;
  const styleAttributeLines = input.addedLines.filter((line) =>
    line.includes("style=")
  ).length;
  const addedClassNameCount = input.addedLines.filter((line) =>
    line.includes("className=")
  ).length;

  return {
    inlineStyleCount,
    styleAttributeLines,
    addedClassNameCount,
    excessiveInlineStyles: inlineStyleCount >= 3 || styleAttributeLines >= 8,
    reusableClassPreferenceMissed:
      inlineStyleCount > 0 && addedClassNameCount === 0,
  };
}
