# AI Indexer

Local code indexer and MCP server for AI agents. It provides semantic search, symbol navigation, and project exploration tools without requiring Docker or cloud services.

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
- **Project Tree:** View recursive structure of your project, respecting `.gitignore`.
- **Reference Finding:** Fast, exact textual search for symbol occurrences using `ripgrep`.
- **Background Indexing:** A singleton daemon monitors all initialized projects and keeps the index up-to-date automatically.

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
  ollama pull unclemusclez/jina-embeddings-v2-base-code  # Download model
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

### 4. TypeScript Language Server (Optional, for LSP features)
Enables precise code intelligence features like go-to-definition and find-references.

- **Install globally:**
  ```bash
  npm install -g typescript-language-server typescript
  ```
- **Verify:**
  ```bash
  typescript-language-server --version
  ```

**Note:** LSP features are enabled by default but gracefully degrade if the language server is not installed. You can disable LSP in `~/.indexer/config.json` by setting `lsp.enabled: false`.

## Available Tools (MCP)

### Semantic Search & Navigation
- `search_codebase`: Conceptual search (e.g., "how is auth handled?").
- `search_symbols`: Locate specific class or method definitions.
- `get_file_outline`: See classes and methods in a file without reading all its code.
- `get_project_structure`: Recursive visual file tree.
- `find_usages`: Find all places where a symbol is used (text-based via ripgrep).
- `get_dependency_graph`: Analyze imports/dependencies starting from a file or path prefix.
- `get_reverse_dependencies`: Find which files import/depend on a specific file.

### LSP-Powered Tools (TypeScript/JavaScript)
Requires `typescript-language-server` to be installed (see Prerequisites).

- `lsp_document_symbols`: Get precise AST-based list of all symbols in a file (classes, methods, interfaces, types).
- `lsp_definition`: Go to the exact definition of a symbol at a cursor position (line/column).
- `lsp_references`: Find all references to a symbol with precise location information.

## CLI Commands

- `indexer init`: Initialize the current project. Adds it to the global daemon's watch list and creates `.indexer/`.
- `indexer status`: Show status of the current project and services (Qdrant, Ollama).
- `indexer index`: Force a full re-index of the current project (formerly `clean`).
- `indexer logs`: Tail the logs of the background daemon process.
- `indexer collections`: List all vector collections in Qdrant.
- `indexer uninstall`: Remove the current project from the global watch list and delete its index.

## Architecture

The indexer runs as a **singleton background service** (daemon).
- **Single Process:** One Node.js process manages file watching and indexing for ALL your initialized projects.
- **Resource Efficient:** Prevents multiple MCP servers from eating up CPU/RAM.
- **Instant Connect:** New IDE windows connect to the running daemon instantly.
- **Offline Sync:** If the daemon was stopped, it automatically resyncs changed files upon restart.
- **Auto-Config Sync:** The daemon automatically detects changes to `~/.indexer/config.json` and adds/removes projects accordingly.

Global config is stored in `~/.indexer/config.json`. Logs are in `~/.indexer/log.txt`.

### Modular Architecture

The codebase is organized into modular components with clear responsibilities, grouped by functional layers:

**CLI Layer** (`lib/cli/`):
- `cli-commands.js` - Core CLI command handlers
- `cli-actions.js` - CLI action implementations
- `cli-config.js` - CLI configuration utilities
- `cli-ui.js` - CLI user interface helpers
- `daemon-manager.js` - Daemon process management

**Service Layer** (`lib/services/`):
- `service-lifecycle.js` - Service lifecycle management (start/stop/shutdown)
- `inactivity-manager.js` - Activity tracking and inactivity timers
- `project-watcher.js` - File watching and project synchronization
- `mcp-service.js` - Main MCP server implementation and request handling
- `indexer-service.js` - Main indexer service coordinator

**Core Layer** (`lib/core/`):
- `file-indexer.js` - File indexing, embeddings, and chunking
- `qdrant-client.js` - All Qdrant database operations
- `file-filters.js` - File filtering and ignore patterns
- `indexer-core.js` - Core indexing operations coordinator
- `project-detector.js` - Project type detection
- `dependency-graph-builder.js` - Builds and updates import dependency graphs

**MCP Layer** (`lib/mcp/`):
- `mcp-tools.test.js` - MCP tool testing utilities
- `mcp-test-runner.js` - MCP tool testing runner
- (Legacy) `mcp-server.js` - Deprecated adapter, logic moved to `lib/services/mcp-service.js`

**Managers Layer** (`lib/managers/`):
- `project-manager.js` - Project registration and management
- `collection-manager.js` - Qdrant collection operations

**Utils Layer** (`lib/utils/`):
- `config-global.js` - Global configuration management
- `snapshot-manager.js` - File system snapshot management
- `dependency-graph-db.js` - SQLite database for dependency graph storage
- `tree-sitter.js` - Tree-sitter parser integration
- `ast-js.js` - JavaScript AST parser
- `system-check.js` - System requirements checker

### Automatic Project Management

The daemon monitors the global configuration file and automatically:
- **Registers new projects** when they are added to `config.json`
- **Unregisters projects** when they are removed from `config.json`
- **Handles errors gracefully** - if `config.json` contains invalid JSON, the error is logged but the daemon continues running without modifying projects

This means you can add or remove projects by editing `~/.indexer/config.json` directly, and the daemon will automatically pick up the changes without requiring a restart.

## LSP Configuration

The Language Server Protocol (LSP) integration provides precise code intelligence features. Configuration is stored in `~/.indexer/config.json` under the `lsp` section.

### Default Configuration

```json
{
  "lsp": {
    "enabled": true,
    "idleTimeoutMs": 300000,
    "requestTimeoutMs": 30000,
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "initializationOptions": {}
      },
      "javascript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "initializationOptions": {}
      }
    }
  }
}
```

### Configuration Options

- **`enabled`** (boolean, default: `true`): Enable/disable LSP features globally
- **`idleTimeoutMs`** (number, default: `300000`): Time in milliseconds before an idle LSP server is shut down (5 minutes)
- **`requestTimeoutMs`** (number, default: `30000`): Timeout for individual LSP requests (30 seconds)
- **`servers`** (object): Language-specific LSP server configurations

### Adding Support for Other Languages

To add support for additional languages (Python, C++, etc.), add entries to the `servers` object:

```json
{
  "lsp": {
    "servers": {
      "python": {
        "command": "pyright-langserver",
        "args": ["--stdio"],
        "initializationOptions": {}
      },
      "cpp": {
        "command": "clangd",
        "args": [],
        "initializationOptions": {}
      }
    }
  }
}
```

Make sure the corresponding language server is installed and available in your PATH.

### Session Management

- LSP servers are started **lazily** on first request for a language
- Sessions are **cached** per project and language combination
- Idle sessions are **automatically closed** after the configured timeout
- Failed servers are **retried** on next request

## Development

Run tests to ensure everything is working correctly:

```bash
npm test
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
