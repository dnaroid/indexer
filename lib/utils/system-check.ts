import { spawn } from 'child_process'
import os from 'os'

async function checkCommand(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
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

  const missing: Array<{ name: string; install: string }> = []

  if (!results.ripgrep) {
    missing.push({
      name: 'ripgrep',
      install: isMac
        ? 'brew install ripgrep'
        : isLinux
        ? 'sudo apt-get install ripgrep'
        : 'See https://github.com/BurntSushi/ripgrep'
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

export async function setupOllamaModel(modelName: string): Promise<boolean> {
  console.log(`[setup] Checking Ollama model: ${modelName}...`)

  // Check if model exists using exec for simpler output handling
  const { exec } = await import('child_process')
  
  return new Promise<boolean>((resolve) => {
    exec('ollama list', (error: any, stdout: string, _stderr: string) => {
      const output = stdout || ''
      
      if (output.includes(modelName)) {
        console.log(`[setup] Model ${modelName} is already present.`)
        resolve(true)
        return
      }

      console.log(`[setup] Pulling ${modelName} (this may take a while)...`)
      const pull = spawn('ollama', ['pull', modelName], { stdio: 'inherit' })
      pull.on('close', (code: number | null) => {
        if (code === 0) {
          console.log(`[setup] Successfully pulled ${modelName}.`)
          resolve(true)
        } else {
          console.error(`[setup] Failed to pull model.`)
          resolve(false)
        }
      })
    })
  })
}
