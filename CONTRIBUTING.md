# Contributing to Hippo

## Development setup

```bash
git clone https://github.com/dungle-scrubs/hippo.git
cd hippo
pnpm install
just ci    # build + lint + test
```

## Workflow

1. Create a branch from `main`
2. Make changes, write tests
3. Run `just ci` to verify
4. Open a PR against `main`

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add tag filtering to recall_memories
fix(extractor): handle empty LLM response gracefully
docs: update MCP server env var table
test(strength): add edge cases for zero access count
chore: bump biome to 2.4
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`.

Breaking changes use `!`: `feat!: change HippoOptions interface`.

## Code style

- **Biome** handles linting and formatting — run `just check` or `just fix`
- **Pre-commit hooks** run biome and typecheck automatically
- Write JSDoc for all public functions
- Tests go next to source files as `*.test.ts`

## Testing

```bash
just test         # run once
just test-watch   # watch mode
```

Tests use vitest with better-sqlite3 in-memory databases. No network
calls — embedding and LLM functions are stubbed in tests.

## Architecture

See `plan.md` for detailed design documentation covering the strength
model, conflict resolution pipeline, and data model.
