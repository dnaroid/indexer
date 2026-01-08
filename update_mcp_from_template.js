import { renderMcpProxyScript, getPaths } from './build/lib/cli/cli-config.js';
import { getProjectCollectionName } from './build/lib/utils/config-global.js';
import fs from 'fs/promises';
import path from 'path';

const root = process.cwd();
const paths = getPaths(root);
const collectionName = getProjectCollectionName(root);
const script = await renderMcpProxyScript(paths, collectionName);
const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js');
await fs.writeFile(mcpProxyPath, script, 'utf8');
await fs.chmod(mcpProxyPath, 0o755);
console.log('Updated mcp-server.js from template');
