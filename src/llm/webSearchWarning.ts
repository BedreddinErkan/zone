const _warnedProviders = new Set<string>();

export function warnWebSearchDegradationOnce(opts: {
  provider: string;
  webSearchEnabled: boolean;
  isSubagent: boolean;
  onProgress?: (msg: string) => void;
}): void {
  if (opts.isSubagent || !opts.webSearchEnabled || opts.provider === "anthropic") return;
  if (_warnedProviders.has(opts.provider)) return;
  _warnedProviders.add(opts.provider);
  opts.onProgress?.(
    `Web search requires the Anthropic provider — current provider is "${opts.provider}", web search is disabled for this session.`
  );
}

export function _resetWebSearchDegradationWarnedForTest(): void {
  _warnedProviders.clear();
}
