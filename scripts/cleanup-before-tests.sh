#!/bin/bash

# Kill any running indexer daemon processes
pkill -f "indexer-service.js" || true

# Clean up PID and port files
rm -f ~/.indexer/daemon.pid ~/.indexer/daemon.port

# Wait a moment for processes to fully exit
sleep 0.5

echo "Cleanup complete"
