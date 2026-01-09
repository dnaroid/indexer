import type { ToolHandlersDeps } from '../common/types.js'

export async function findUsages(
  deps: ToolHandlersDeps,
  {symbol, context}: {symbol: string, context?: string}
) {
  let searchName = symbol
  let autoContext = context

  if (symbol.includes('.') && !context) {
    const parts = symbol.split('.')
    searchName = parts.pop()
    autoContext = parts.join('.')
  }

  const rawResults = await deps.runRipgrep(searchName)
  const filteredResults = await deps.filterReferences(rawResults, null, deps.readFile)

  let finalResults = filteredResults

  if (autoContext) {
    const points = await deps.searchSymbols(autoContext, 'any', 100)
    const filesWithContext = new Set(points.map(p => p.payload?.path))
    finalResults = filteredResults.filter(r => filesWithContext.has(r.path))
    if (finalResults.length === 0 && filteredResults.length > 0) {
      finalResults = filteredResults
    }
  }

  return {content: [{type: 'text', text: JSON.stringify(finalResults, null, 2)}]}
}
