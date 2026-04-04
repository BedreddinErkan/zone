# Zone ⚡
> AI Code Agent — deterministic, explainable, safe

## Install
```bash
npm install -g zone
```

## Usage
```bash
# Test Engineer — write tests for any framework
zone --task "write a cucumber scenario for flight search" --role test_engineer --repo /path/to/repo --apply --confirm-apply

# Data Analyst — generate SQL migrations
zone --task "create a users table with email and created_at" --role data_analyst --repo /path/to/repo --apply --confirm-apply

# Developer — modify existing code
zone --task "add input validation to login form" --repo /path/to/repo
```

## Supported Frameworks
- Test Engineer: Playwright (TS/JS), Cypress, Cucumber+Java, Selenium, TestNG, pytest
- Data Analyst: PostgreSQL, MySQL, SQLite — Flyway, raw SQL, Alembic

## Web UI
```bash
npx tsx src/api/server.ts
# Open http://localhost:3000
```
