import fs from 'fs/promises'
import path from 'path'
import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { confirmAction, log, warn } from '../cli/cli-ui.js'
import { deleteCollectionByName } from '../core/indexer-core.js'
import {
  addProjectToConfig,
  getProjectConfig,
  loadGlobalConfig,
  removeProjectFromConfig
} from '../utils/config-global.js'
import { isQdrantUp } from './collection-manager.js'

/**
 * List all registered projects
 * @returns {Promise<void>}
 */
export async function handleListProjects() {
  const config = await loadGlobalConfig()
  const projects = Object.entries(config.projects)

  if (projects.length === 0) {
    console.log('No projects registered.')
    return
  }

  console.log('\nTracked projects:')
  projects.forEach(([projectPath, data], i) => {
    console.log(`  [${i + 1}] ${projectPath} [${data.collectionName}]`)
  })
  console.log('')
}

/**
 * Delete a project from the registry
 * @param {string} projectIndexOrPath - Project index or path
 * @returns {Promise<void>}
 */
export async function handleDeleteProject(projectIndexOrPath) {
  const config = await loadGlobalConfig()
  const projects = Object.entries(config.projects)

  if (projects.length === 0) {
    console.log('No projects to delete.')
    return
  }

  // If no argument provided, show interactive selection
  let projectToDelete = null

  if (!projectIndexOrPath) {
    console.log('\nSelect project to delete:')
    projects.forEach(([projectPath, data], i) => {
      console.log(`  [${i + 1}] ${projectPath} [${data.collectionName}]`)
    })
    console.log('')

    const rl = createInterface({ input, output })
    const answer = await rl.question('Enter number to delete, or empty to cancel: ')
    rl.close()

    const trimmed = answer.trim()
    if (!trimmed) {
      return
    }

    const index = parseInt(trimmed, 10)
    if (isNaN(index) || index < 1 || index > projects.length) {
      throw new Error('Invalid selection.')
    }

    projectToDelete = projects[index - 1]
  } else {
    // Search by index or path
    const index = parseInt(projectIndexOrPath, 10)
    if (!isNaN(index) && index >= 1 && index <= projects.length) {
      projectToDelete = projects[index - 1]
    } else {
      projectToDelete = projects.find(([p]) => p === projectIndexOrPath)
    }
  }

  if (!projectToDelete) {
    throw new Error('Project not found.')
  }

  const [projectPath, projectData] = projectToDelete

  if (await confirmAction(`Delete project "${projectPath}"? This will remove:\n  - Project from global config\n  - Collection "${projectData.collectionName}" from Qdrant\n  - .indexer/ directory from project`)) {
    // 1. Remove from global config
    await removeProjectFromConfig(projectPath)

    // 2. Delete collection from Qdrant
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
    const qdrantUp = await isQdrantUp(qdrantUrl)

    if (qdrantUp) {
      try {
        await deleteCollectionByName(projectData.collectionName)
        log(`Deleted collection: ${projectData.collectionName}`)
      } catch (e) {
        warn(`Failed to delete collection: ${e.message}`)
      }
    } else {
      warn('Qdrant is not running. Collection will NOT be deleted.')
    }

    // 3. Delete .indexer directory
    const indexerDir = path.join(projectPath, '.indexer')
    try {
      await fs.rm(indexerDir, { recursive: true, force: true })
      log(`Removed .indexer/ directory`)
    } catch (e) {
      warn(`Failed to remove .indexer/: ${e.message}`)
    }

    log(`Project deleted: ${projectPath}`)
  }
}
