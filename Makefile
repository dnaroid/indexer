SHELL := /bin/sh

.PHONY: cli-pack cli-install cli-uninstall clean

# ============================================
# CLI Distribution
# ============================================

# Pack the package into the build directory
cli-pack:
	mkdir -p build
	rm -f build/*.tgz
	npm pack --pack-destination ./build

# Build and install the package globally
cli-install: cli-pack
	npm install -g ./build/*.tgz

# Uninstall the package from global scope
cli-uninstall:
	npm uninstall -g @dnaroid/mcp-code-indexer || true

# Remove build artifacts
clean:
	rm -rf build