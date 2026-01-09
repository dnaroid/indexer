import type { ToolHandlersDeps } from '../common/types.js'

export async function searchCodebase(
  deps: ToolHandlersDeps,
  {query, top_k = 5, path_prefix}: {query: string, top_k?: number, path_prefix?: string}
) {
  const queryVector = await deps.embed(query)
  const results = await deps.searchQdrant(queryVector, top_k, path_prefix)

  const formatted = results.map((r, i) => {
    const p = r.payload || {}
    return {
      rank: i + 1,
      path: p.path,
      start_line: p.start_line,
      end_line: p.end_line,
      snippet: p.text,
      score: r.score,
      symbol_names: p.symbol_names,
      symbol_kinds: p.symbol_kinds,
      unity_tags: p.unity_tags
    }
  })

  return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
}
