# Hippo — Persistent memory for AI agents
# Run `just` to see all available commands.

# Default: list available commands
default:
    @just --list --unsorted

# ── Development ───────────────────────────────────────────────────────

# Build TypeScript to dist/
build:
    pnpm build

# Run all tests
test:
    pnpm test

# Run tests in watch mode
test-watch:
    pnpm test:watch

# Type-check without emitting
typecheck:
    pnpm typecheck

# Run biome linter + formatter check
check:
    pnpm check

# Auto-fix lint and format issues
fix:
    pnpm lint:fix && pnpm format

# Build, check, and test (full CI pipeline)
ci: build check test

# ── CLI (database inspection) ─────────────────────────────────────────
# All database commands require a db path: just <command> <db-path> [args]
# Or set HIPPO_DB env var: export HIPPO_DB=agent.db

# Initialize a hippo database (creates tables, idempotent)
init db:
    node dist/cli.js --db {{db}} init

# Show database statistics (agents, chunks, blocks, size)
stats db:
    node dist/cli.js --db {{db}} stats

# List all agent IDs in the database
agents db:
    node dist/cli.js --db {{db}} agents

# List chunks (facts + memories) for an agent
chunks db agent *args='':
    node dist/cli.js --db {{db}} chunks {{agent}} {{args}}

# List memory blocks for an agent
blocks db agent:
    node dist/cli.js --db {{db}} blocks {{agent}}

# Get contents of a named block
block db agent key:
    node dist/cli.js --db {{db}} block {{agent}} {{key}}

# Search chunk content by text (case-insensitive)
search db text *args='':
    node dist/cli.js --db {{db}} search "{{text}}" {{args}}

# Delete chunks by ID (requires --force)
delete db +ids:
    node dist/cli.js --db {{db}} delete {{ids}}

# Remove superseded chunks (requires --force)
purge db *args='':
    node dist/cli.js --db {{db}} purge {{args}}

# Export all data for an agent as JSON
export db agent:
    node dist/cli.js --db {{db}} export {{agent}}

# Import agent data from JSON file
import db file:
    node dist/cli.js --db {{db}} import {{file}}
