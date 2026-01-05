# AI Indexer

Local code indexer and MCP server for AI agents. It provides semantic search, symbol navigation, and project exploration
tools without requiring Docker or cloud services.

## Quick Start

1. **Install globally via NPM:**
   ```bash
   npm install -g @dnaroid/mcp-code-indexer
   ```
   *Alternatively, if you are developing this tool, run `make cli-install` in this directory.*

2. **Initialize in your project:**
   Go to your target project's root and run:
   ```bash
   indexer init
   ```

3. **Explore your code:**
   AI agents (like Claude with Desktop app) will now have access to powerful tools to understand your project.

## Features

- **Semantic Search:** Find code by meaning using local embeddings (via Ollama).
- **Symbol Navigation:** Instantly jump to definitions of classes, methods, or Unity-specific components.
- **File Outlining:** Get a high-level view of any file's structure (JS/TS, Python, Go, Rust, C#).
- **Project Tree:** View the recursive structure of your project, respecting `.gitignore`.
- **Reference Finding:** Fast, exact textual search for symbol occurrences using `ripgrep`.

## Prerequisites & Installation

To use the AI Indexer, you need the following tools installed and available in your system.

### 1. ripgrep (Required)
Used for fast text search (`find_references`).

- **macOS:**
  ```bash
  brew install ripgrep
  ```
- **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt-get install ripgrep
  ```

### 2. Ollama (Required)
Provides local embedding models. The MCP server can auto-start it if found in `PATH`.

- **macOS / Linux:**
  Download from [ollama.com](https://ollama.com) or run:
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ```
- **Setup Model:**
  After installing, make sure to pull the embedding model once:
  ```bash
  ollama serve &                # Start server (if not running)
  ollama pull nomic-embed-text  # Download model
  ```

### 3. Qdrant (Required)
Vector database.

**Option A: Local Binary (Recommended for Auto-Start)**
If the `qdrant` binary is in your `PATH`, the MCP server can automatically manage its lifecycle (start/stop).
1. Download the latest release from [Qdrant Releases](https://github.com/qdrant/qdrant/releases).
2. Unpack and move the binary to your path (e.g., `/usr/local/bin/qdrant`).
3. Verify: `qdrant --version`.

**Option B: Docker**
Alternatively, you can run Qdrant manually. The indexer will connect to `localhost:6333`.
```bash
docker run -d -p 6333:6333 -v qdrant_data:/qdrant/storage qdrant/qdrant
```

## Available Tools (MCP)

- `search_codebase`: Conceptual search (e.g., "how is auth handled?").
- `search_symbols`: Locate specific class or method definitions.
- `get_file_outline`: See classes and methods in a file without reading full code.
- `get_project_structure`: Recursive visual file tree.
- `find_references`: Find all places where a symbol is used.

## Development

Run tests to ensure everything is working correctly:

```bash
npm test
```

Collect coverage report:

```bash
node --experimental-test-coverage --test lib/mcp-tools.test.js lib/indexer-core.test.js tests/*.test.js
```

## License

MIT

<!-- indexer-cli-start -->
### Indexer CLI (Local Mode)

- `indexer init` — creates `.indexer/`, sets up local config, and appends the `indexer` MCP server to `.mcp.json`.
- `indexer status` — shows status.
- `indexer clean` — drops the collection and reindexes.
- `indexer uninstall` — removes `.indexer/` and the `indexer` entry in `.mcp.json`.

MCP hookup for Claude is automatic: `.mcp.json` is updated during `indexer init`.
<!-- indexer-cli-end -->
