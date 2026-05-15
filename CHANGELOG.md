# Change Log

All notable changes to the "zone" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added — Phase K.1: Daily USD cap

- **`ZONE_DAILY_USD_CAP` env var** — set a per-user rolling 24-hour spend ceiling (USD). `0` or `-1` = unlimited. Default: `$10.00`.
- **`dailyUsdCapOverride` in `~/.zone/tier-limits.json`** — per-user override; wins over the env var. `0` = unlimited.
- Pre-run enforcement gate in `agentLoop`: checks today's spend before the first iteration; returns `terminationReason: "daily_usd_cap_exceeded"` when the cap is hit. Subagent loops are never gated (parent enforces the budget).
- Telemetry: `[zone-daily-usd-status]` log line emitted on every top-level dispatch (cap, source, spent).

- Initial release