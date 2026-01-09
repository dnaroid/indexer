import type { ToolHandlersDeps } from '../common/types.js'

export async function getProjectStructure(deps: ToolHandlersDeps) {
  const files = await deps.listProjectFiles()
  const treeText = deps.buildTreeText(files)
  return {content: [{type: 'text', text: treeText || '(empty project)'}]}
}
