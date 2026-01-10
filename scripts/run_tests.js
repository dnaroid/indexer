
import { spawn } from 'child_process';
import fg from 'fast-glob';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function runTests() {
  // Find all .test.js files in the build directory
  // We ignore node_modules just in case, though they shouldn't be in build/
  const files = await fg('build/**/*.test.js', { 
    cwd: projectRoot,
    absolute: true,
    ignore: ['**/node_modules/**']
  });

  if (files.length === 0) {
    console.error('No test files found in build/ directory. Did you run "npm run build"?');
    process.exit(1);
  }

  console.log(`Found ${files.length} test files. Running tests...`);

  // Run node --test with all found files
  const args = ['--test', ...files];
  
  const child = spawn('node', args, { 
    stdio: 'inherit',
    cwd: projectRoot
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
  
  child.on('error', (err) => {
    console.error('Failed to start test runner:', err);
    process.exit(1);
  });
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
