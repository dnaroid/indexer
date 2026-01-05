import {spawn} from 'child_process'
import os from 'os'

async function checkCommand(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {stdio: 'ignore'})
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

export async function checkSystemRequirements() {
  const platform = os.platform()
  const isMac = platform === 'darwin'
  const isLinux = platform === 'linux'

  const results = {
    ripgrep: await checkCommand('rg'),
    ollama: await checkCommand('ollama'),
    qdrant: await checkCommand('qdrant'),
    docker: await checkCommand('docker')
  }

  const missing = []
  
  if (!results.ripgrep) {
    missing.push({
      name: 'ripgrep',
      install: isMac ? 'brew install ripgrep' : (isLinux ? 'sudo apt-get install ripgrep' : 'See https://github.com/BurntSushi/ripgrep')
    })
  }

  if (!results.ollama) {
    missing.push({
      name: 'Ollama',
      install: 'curl -fsSL https://ollama.com/install.sh | sh'
    })
  }

  // Qdrant is tricky. We prefer binary, but Docker is okay.
  if (!results.qdrant && !results.docker) {
     missing.push({
       name: 'Qdrant (or Docker)',
       install: 'See https://github.com/qdrant/qdrant/releases or install Docker'
     })
  }

  return {
    ok: missing.length === 0,
    missing,
    hasDocker: results.docker,
    hasQdrantBinary: results.qdrant
  }
}

export async function setupOllamaModel(modelName) {
  console.log(`[setup] Checking Ollama model: ${modelName}...`)
  
  // Check if model exists
  const check = spawn('ollama', ['list'], {encoding: 'utf8'})
  let output = ''
  
  // Wait for check
  await new Promise(r => {
      check.stdout.on('data', d => output += d)
      check.on('close', r)
  })

  if (output.includes(modelName)) {
    console.log(`[setup] Model ${modelName} is already present.`)
    return true
  }

  console.log(`[setup] Pulling ${modelName} (this may take a while)...`)
  return new Promise((resolve) => {
    const pull = spawn('ollama', ['pull', modelName], {stdio: 'inherit'})
    pull.on('close', (code) => {
      if (code === 0) {
        console.log(`[setup] Successfully pulled ${modelName}.`)
        resolve(true)
      } else {
        console.error(`[setup] Failed to pull model.`)
        resolve(false)
      }
    })
  })
}
