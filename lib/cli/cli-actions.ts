// Re-export from new modules
export {
  isDaemonRunning,
  stopDaemon
} from './daemon-manager.js'

export {
  handleListProjects,
  handleDeleteProject
} from '../managers/project-manager.js'

export {
  ensureQdrantConnection,
  isQdrantUp,
  isOllamaUp,
  countIndexed,
  handleListCollections,
  handleDeleteCollection,
  handlePruneAll
} from '../managers/collection-manager.js'

export {
  handleTestSearchCodebase,
  handleTestSearchSymbols,
  handleTestGetFileOutline,
  handleTestGetProjectStructure,
  handleTestFindUsages,
  handleTestAll,
  handleTestCommand
} from '../mcp/mcp-test-runner.js'

export {
  ensureInitialized,
  checkAndAutoUpdate,
  handleInit,
  handleStatus,
  handleCleanIndex,
  handleLogs,
  handleUninstall,
  handleMcp,
  handleUpdateMcp
} from './cli-commands.js'
