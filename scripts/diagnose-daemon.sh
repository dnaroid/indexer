#!/bin/bash

# Диагностический скрипт для проверки состояния демона indexer

echo "=========================================="
echo "DIAGNOSTIC: Indexer Daemon Status"
echo "=========================================="
echo ""

# Пути
HOME_DIR="$HOME"
INDEXER_DIR="$HOME_DIR/.indexer"
PID_FILE="$INDEXER_DIR/daemon.pid"
LOG_FILE="$INDEXER_DIR/log.txt"
CONFIG_FILE="$INDEXER_DIR/config.json"

# Получаем порт из конфига или используем дефолтный
SERVICE_PORT=$(node -e "
const fs = require('fs');
try {
    const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
    const projects = config.projects || {};
    const firstProject = Object.keys(projects)[0];
    if (firstProject && projects[firstProject].settings && projects[firstProject].settings.SERVICE_PORT) {
        console.log(projects[firstProject].settings.SERVICE_PORT);
    } else {
        console.log('34567');
    }
} catch (e) {
    console.log('34567');
}
" 2>/dev/null || echo "34567")

echo "1. Checking PID file..."
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    echo "   ✓ PID file exists: $PID_FILE"
    echo "   PID: $PID"

    # Проверяем, запущен ли процесс
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "   ✓ Process is RUNNING with PID $PID"
        echo ""
        echo "   Process details:"
        ps -p "$PID" -o pid,ppid,cmd,etime,stat
    else
        echo "   ✗ Process is NOT running (stale PID file)"
        echo "   The PID file exists but no process with PID $PID is running"
    fi
else
    echo "   ✗ PID file does NOT exist: $PID_FILE"
    echo "   This means the daemon has never been started or has been properly shut down"
fi

echo ""
echo "2. Checking log file..."
if [ -f "$LOG_FILE" ]; then
    echo "   ✓ Log file exists: $LOG_FILE"
    LOG_SIZE=$(wc -l < "$LOG_FILE")
    echo "   Log file size: $LOG_SIZE lines"
    echo ""
    echo "   Last 10 log entries:"
    echo "   -------------------"
    tail -n 10 "$LOG_FILE" | sed 's/^/   /'
else
    echo "   ✗ Log file does NOT exist: $LOG_FILE"
    echo "   The daemon may not have been started yet"
fi

echo ""
echo "3. Checking global config..."
if [ -f "$CONFIG_FILE" ]; then
    echo "   ✓ Config file exists: $CONFIG_FILE"
    echo ""
    echo "   Registered projects:"
    echo "   --------------------"
    node -e "
    const fs = require('fs');
    try {
        const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        const projects = config.projects || {};
        const projectPaths = Object.keys(projects);
        if (projectPaths.length === 0) {
            console.log('   No projects registered');
        } else {
            projectPaths.forEach((path, i) => {
                console.log('   [' + (i+1) + '] ' + path);
            });
        }
    } catch (e) {
        console.log('   Error reading config: ' + e.message);
    }
    "
else
    echo "   ✗ Config file does NOT exist: $CONFIG_FILE"
fi

echo ""
echo "4. Checking HTTP service (port $SERVICE_PORT)..."
if curl -s http://127.0.0.1:$SERVICE_PORT/health > /dev/null 2>&1; then
    echo "   ✓ HTTP service is RESPONDING on port $SERVICE_PORT"
    echo ""
    echo "   Health check response:"
    curl -s http://127.0.0.1:$SERVICE_PORT/health | sed 's/^/   /'
else
    echo "   ✗ HTTP service is NOT responding on port $SERVICE_PORT"
    echo "   The indexer-service may not be running"
fi

echo ""
echo "5. Checking for running indexer processes..."
echo "   Running processes:"
ps aux | grep -E "(indexer-service|mcp-server)" | grep -v grep | sed 's/^/   /' || echo "   No indexer processes found"

echo ""
echo "=========================================="
echo "DIAGNOSTIC COMPLETE"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. If daemon is not running, start it with: node lib/indexer-service.js"
echo "2. Check logs for errors: tail -f $LOG_FILE"
echo "3. Run 'indexer status' to see the current status"
echo ""
