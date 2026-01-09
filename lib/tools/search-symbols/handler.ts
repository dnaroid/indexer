import type { ToolHandlersDeps } from '../common/types.js'

export async function searchSymbols(
  deps: ToolHandlersDeps,
  {name, kind = 'any', top_k = 10}: {name: string, kind?: string, top_k?: number}
) {
  const results = await deps.searchSymbols(name, kind, top_k)

  const formatted = results.map((r, i) => {
    const p = r.payload || {}
    return {
      rank: i + 1,
      path: p.path,
      start_line: p.start_line,
      end_line: p.end_line,
      symbol_names: p.symbol_names,
      symbol_kinds: p.symbol_kinds,
      unity_tags: p.unity_tags,
      snippet: p.text,
      score: r.score
    }
  })

  return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
}
