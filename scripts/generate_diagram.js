
import { getNodesByCollection, getEdgesBySource } from '../build/lib/utils/dependency-graph-db.js';
import fs from 'fs/promises';
import path from 'path';

async function main() {
  // Try to find a collection ID if not provided
  const collectionId = process.argv[2] || 'idx_0caf200a0da9f010'; 
  
  console.log(`Fetching graph data for collection: ${collectionId}...`);
  let nodes;
  try {
    nodes = await getNodesByCollection(collectionId);
  } catch (e) {
    console.error('Failed to fetch nodes. Make sure the database exists and collection ID is correct.');
    process.exit(1);
  }
  
  // Filter for lib/ files only to keep it focused
  const libNodes = nodes.filter(n => n.file_path.startsWith('lib/'));
  const libFiles = new Set(libNodes.map(n => n.file_path));
  
  if (libNodes.length === 0) {
    console.error('No nodes found in lib/ for this collection.');
    return;
  }

  console.log(`Found ${libNodes.length} nodes in lib/`);

  let mermaid = '```mermaid\ngraph TD\n';
  
  // Group by directory
  const dirs = {};
  for (const node of libNodes) {
    const dir = path.dirname(node.file_path);
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(node);
  }
  
  // Create subgraphs
  const sortedDirs = Object.keys(dirs).sort();
  
  for (const dir of sortedDirs) {
    const files = dirs[dir];
    const safeDir = dir.replace(/[/\.-]/g, '_');
    mermaid += `  subgraph ${safeDir} ["${dir}"]\n`;
    mermaid += `    direction TB\n`;
    for (const file of files) {
        const safeId = file.file_path.replace(/[/\.-]/g, '_');
        const label = path.basename(file.file_path);
        mermaid += `    ${safeId}["${label}"]\n`;
    }
    mermaid += `  end\n`;
  }
  
  mermaid += '\n  %% Edges\n';
  
  let edgeCount = 0;
  for (const node of libNodes) {
    const edges = await getEdgesBySource(collectionId, node.file_path);
    const safeSource = node.file_path.replace(/[/\.-]/g, '_');
    
    for (const edge of edges) {
        if (!edge.target_file) continue; 
        if (!libFiles.has(edge.target_file)) continue; 
        
        const safeTarget = edge.target_file.replace(/[/\.-]/g, '_');
        mermaid += `  ${safeSource} --> ${safeTarget}\n`;
        edgeCount++;
    }
  }
  
  mermaid += '```\n';
  
  const outputPath = path.join(process.cwd(), 'graph.md');
  await fs.writeFile(outputPath, mermaid);
  console.log(`Graph written to ${outputPath} with ${edgeCount} edges.`);
}

main().catch(console.error);

