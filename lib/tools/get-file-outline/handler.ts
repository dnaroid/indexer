import type { ToolHandlersDeps } from '../common/types.js'

export async function getFileOutline(
  deps: ToolHandlersDeps,
  {path: filePath}: {path: string}
) {
  const content = await deps.readFile(filePath)
  const symbols = await deps.extractSymbols(filePath, content)

  const formatted = symbols
    .filter(s => s.kind !== 'reference')
    .map(s => ({
      name: s.name,
      kind: s.kind,
      line: s.start
    }))

  return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
}
