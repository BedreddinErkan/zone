import type {
  DetectSemanticRiskInput,
  SemanticRisk,
  SemanticRiskCode,
  SemanticRiskRule,
  SemanticRiskSeverity,
} from "./semanticRiskTypes.js";

function countPatternMatches(content: string, pattern: RegExp): number {
  return content.match(pattern)?.length ?? 0;
}

function findMatchedTokens(content: string, patterns: RegExp[]): string[] {
  return patterns
    .flatMap((pattern) => content.match(pattern) ?? [])
    .map((match) => match.trim())
    .filter((match, index, values) => values.indexOf(match) === index);
}

function buildRisk(
  input: DetectSemanticRiskInput,
  code: SemanticRiskCode,
  severity: SemanticRiskSeverity,
  category: SemanticRisk["category"],
  message: string,
  evidence?: SemanticRisk["evidence"]
): SemanticRisk {
  return {
    code,
    severity,
    category,
    message,
    filePath: input.filePath,
    evidence,
  };
}

const authGuardPatterns = [
  /\brequireAuth\b/g,
  /\bauthenticate\b/g,
  /\bProtectedRoute\b/g,
];

const roleCheckPatterns = [
  /\bhasRole\b/g,
  /\brequireRole\b/g,
  /\bcheckRole\b/g,
  /\brole\s*===\s*["'`][^"'`]+["'`]/g,
  /\broles?\s*\.includes\(/g,
  /\bpermissions?\s*\.includes\(/g,
];

const validationPatterns = [
  /\bz\.object\s*\(/g,
  /\bz\.string\s*\(/g,
  /\bz\.number\s*\(/g,
  /\bjoi\./gi,
  /\byup\./gi,
  /\bvalidator\./gi,
  /\bvalidate\w*\s*\(/g,
];

const rateLimitPatterns = [
  /\brateLimit\b/g,
  /\brateLimiter\b/g,
  /\bapplyRateLimit\b/g,
  /\bthrottle\b/g,
  /\btoo many requests\b/gi,
];

function collectRemovedRisk(
  input: DetectSemanticRiskInput,
  code: SemanticRiskCode,
  category: SemanticRisk["category"],
  message: string,
  patterns: RegExp[],
  severity: SemanticRiskSeverity
): SemanticRisk[] {
  const beforeMatches = findMatchedTokens(input.beforeContent, patterns);
  const afterMatches = findMatchedTokens(input.afterContent, patterns);

  if (beforeMatches.length === 0 || afterMatches.length > 0) {
    return [];
  }

  return [
    buildRisk(input, code, severity, category, message, {
      beforeMatches,
      afterMatches,
    }),
  ];
}

export const detectAuthGuardRemoved: SemanticRiskRule = (input) =>
  collectRemovedRisk(
    input,
    "AUTH_GUARD_REMOVED",
    "auth",
    "Authentication guard was removed from the file.",
    authGuardPatterns,
    "high"
  );

export const detectRoleCheckRemoved: SemanticRiskRule = (input) =>
  collectRemovedRisk(
    input,
    "ROLE_CHECK_REMOVED",
    "authorization",
    "Authorization or role-based access check was removed from the file.",
    roleCheckPatterns,
    "high"
  );

export const detectValidationRemoved: SemanticRiskRule = (input) =>
  collectRemovedRisk(
    input,
    "VALIDATION_REMOVED",
    "validation",
    "Validation logic appears to have been removed from the file.",
    validationPatterns,
    "high"
  );

export const detectRateLimitRemoved: SemanticRiskRule = (input) =>
  collectRemovedRisk(
    input,
    "RATE_LIMIT_REMOVED",
    "safety_guard",
    "Rate limiting or throttling protection was removed from the file.",
    rateLimitPatterns,
    "high"
  );

export const detectTestAssertionRemoved: SemanticRiskRule = (input) => {
  const expectCountBefore = countPatternMatches(input.beforeContent, /\bexpect\s*\(/g);
  const expectCountAfter = countPatternMatches(input.afterContent, /\bexpect\s*\(/g);
  const assertCountBefore = countPatternMatches(input.beforeContent, /\bassert\b/g);
  const assertCountAfter = countPatternMatches(input.afterContent, /\bassert\b/g);

  const beforeCount = expectCountBefore + assertCountBefore;
  const afterCount = expectCountAfter + assertCountAfter;

  if (beforeCount === 0 || afterCount >= beforeCount) {
    return [];
  }

  const removedCount = beforeCount - afterCount;
  const severity: SemanticRiskSeverity = afterCount === 0 ? "high" : "medium";

  return [
    buildRisk(
      input,
      "TEST_ASSERTION_REMOVED",
      severity,
      "tests",
      `Test assertions were reduced from ${beforeCount} to ${afterCount}.`,
      {
        details: `${removedCount} assertion(s) removed`,
      }
    ),
  ];
};

export const detectSecretExposedToLog: SemanticRiskRule = (input) => {
  const secretLoggingPatterns = [
    /console\.log\s*\(\s*process\.env\b/g,
    /logger\.[a-z]+\s*\(\s*process\.env\b/g,
  ];

  const afterMatches = findMatchedTokens(input.afterContent, secretLoggingPatterns);

  if (afterMatches.length === 0) {
    return [];
  }

  return [
    buildRisk(
      input,
      "SECRET_EXPOSED_TO_LOG",
      "critical",
      "secrets",
      "Environment secrets are being written to application logs.",
      {
        afterMatches,
      }
    ),
  ];
};

export const detectBroadErrorSwallowing: SemanticRiskRule = (input) => {
  const broadCatchPatterns = [
    /catch\s*\(\s*[^)]*\s*\)\s*\{\s*\}/g,
    /catch\s*\{\s*\}/g,
  ];

  const beforeMatches = findMatchedTokens(input.beforeContent, broadCatchPatterns);
  const afterMatches = findMatchedTokens(input.afterContent, broadCatchPatterns);

  if (afterMatches.length === 0 || afterMatches.length <= beforeMatches.length) {
    return [];
  }

  return [
    buildRisk(
      input,
      "BROAD_ERROR_SWALLOWING",
      "high",
      "safety_guard",
      "Broad catch block swallows errors without handling or rethrowing.",
      {
        beforeMatches,
        afterMatches,
      }
    ),
  ];
};

export const semanticRiskRules: SemanticRiskRule[] = [
  detectAuthGuardRemoved,
  detectRoleCheckRemoved,
  detectSecretExposedToLog,
  detectTestAssertionRemoved,
  detectValidationRemoved,
  detectRateLimitRemoved,
  detectBroadErrorSwallowing,
];
