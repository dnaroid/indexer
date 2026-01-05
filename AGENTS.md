# Repository Guidelines

This guide keeps contributions consistent across the AI indexer stack (Ollama embeddings → Qdrant vectors → MCP server).
Keep changes small and reproducible.

## Project Structure & Module Organization

- `docker-compose.yaml` — orchestrates `qdrant`, `indexer`, `mcp` (legacy Docker mode).
- `indexer/` — Node indexer that walks `code/`, chunks files, embeds with Ollama, and upserts to Qdrant.
- `mcp/` — MCP server exposing semantic/symbol search against Qdrant.
- `code/` — workspace mounted into the indexer; add application or sample sources here.
- `scripts/` — helper utilities (template syncing, local startup).
- `volumes/` — named storage for Ollama and Qdrant (Docker mode).
- `plans/` — migration plans and documentation.
- `.mcp/` — local MCP client config; do not commit secrets.

## Build, Test, and Development Commands

### Local Mode (Recommended)

- Install dependencies: `make local-install`
- Start all services: `./scripts/local-start.sh` or `make local-start`
- Check services: `make local-check`
- Index project: `make local-index CODE_DIR=/path/to/project`
- Reindex with reset: `make local-reindex CODE_DIR=/path/to/project`
- Run tests: `make local-test`
- Run linter: `make local-lint`
- Stop Qdrant: `make local-stop`

### Docker Mode (Legacy)

- Start stack: `docker compose up -d` (builds images and launches Qdrant + services).
- Logs: `docker compose logs -f indexer` or `docker compose logs -f mcp`.
- Reindex after code edits: `docker compose exec indexer npm start` (uses mounted `code/`).
- Stop: `docker compose down` (keeps volumes); add `-v` to reset data.

## Coding Style & Naming Conventions

- JavaScript/Node uses ES modules; prefer 2-space indent, 120c max line length.
- Use snake_case files by default; PascalCase only for React-style components you add.
- Add formatters/lint tools per language (`prettier`, `eslint`, etc.) and surface commands in a `Makefile` when added.

## Testing Guidelines

- Run tests with `make local-test` or `cd indexer && npm test`.
- Add unit tests under `code/` or `tests/` using language norms (`*.spec.ts`, `test_*.py`, `*_test.go`).
- Aim for ≥80% coverage on new modules and include regression tests for bug fixes.
- Keep tests fast; stub Qdrant/Ollama where possible.

## Commit & Pull Request Guidelines

- History is empty; adopt Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`). Subjects ≤72 chars with a
  brief body.
- PRs should state what changed, why, how to verify (`make local-test` + manual check), linked issue, and screenshots for
  UX/API response changes.
- Keep PRs small and focused; split refactors from feature work.

## Security & Configuration Tips

- Never commit secrets. Store runtime config in `.env` and add a scrubbed `.env.example`
  when introducing new vars.
- Qdrant/Ollama endpoints default to localhost; if exposing outside, lock down with network rules and auth.

Answer in chat **in Russian**
