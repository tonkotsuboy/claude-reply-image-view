const VIDEO = 'mp4|mov|m4v|webm'
const EXTENSIONS = `png|jpe?g|gif|webp|heic|bmp|tiff?|${VIDEO}`

/** Whether a path names a video, shown by its first frame. */
export function isVideo(path: string): boolean {
  return new RegExp(`\\.(?:${VIDEO})$`, 'i').test(path)
}

// A `code span` naming an image: taken whole, so it may hold spaces or Japanese.
const QUOTED = new RegExp(`\`([^\`\\n]+?\\.(?:${EXTENSIONS}))\``, 'gi')
// An absolute or ~/ path. The lookbehind keeps it out of URLs (https://x/a.png); spaces end it.
const ABSOLUTE = new RegExp(
  `(?<![\\w.:/~-])(?:~/|/)[^\\s\`'"<>()\\[\\]|*,、。）」]*?\\.(?:${EXTENSIONS})(?!\\w)`,
  'gi',
)
// A relative path or a bare file name, ASCII only so it doesn't swallow the Japanese prose
// around it (画像は20.pngです finds 20.png).
const RELATIVE = new RegExp(
  `(?<![\\w.:/~@-])(?:\\.{1,2}/)?[\\w@+-][\\w.@+-]*(?:/[\\w.@+-]+)*\\.(?:${EXTENSIONS})(?!\\w)`,
  'gi',
)

/** The distinct image references a reply makes, as written, in the order they appear; at most `limit`. */
export function imageRefs(text: string, limit = 6): string[] {
  const found: { at: number; ref: string }[] = []
  const quoted: [number, number][] = []
  for (const match of text.matchAll(QUOTED)) {
    found.push({ at: match.index, ref: match[1]!.trim() })
    quoted.push([match.index, match.index + match[0].length])
  }
  for (const pattern of [ABSOLUTE, RELATIVE]) {
    for (const match of text.matchAll(pattern)) {
      if (!quoted.some(([start, end]) => match.index >= start && match.index < end)) {
        found.push({ at: match.index, ref: match[0] })
      }
    }
  }
  const refs = new Set(found.sort((a, b) => a.at - b.at).map(({ ref }) => ref))
  return [...refs].slice(0, limit)
}

// An absolute path between quotes, as a JSON value or a shell argument: may hold spaces.
const QUOTED_ABSOLUTE = new RegExp(`\\\\?["'](/[^"'\\\\\\n]+?\\.(?:${EXTENSIONS}))\\\\?["']`, 'gi')

/** Absolute image paths anywhere in `text` (a tool call's input or output). */
export function absoluteImagePaths(text: string): string[] {
  const quoted = [...text.matchAll(QUOTED_ABSOLUTE)].map(match => match[1]!)
  const bare = [...text.matchAll(ABSOLUTE)].map(([path]) => path).filter(path => path.startsWith('/'))
  return [...new Set([...quoted, ...bare])]
}

/**
 * The absolute paths `ref` may name, best first: itself when absolute; for a relative path or bare
 * name, the most recently seen path ending in it, then `cwd`/`ref`.
 */
export function candidates(ref: string, where: { home?: string; cwd?: string; seen: readonly string[] }): string[] {
  if (ref.startsWith('/')) {
    return [ref]
  }
  if (ref.startsWith('~/')) {
    return where.home === undefined ? [] : [`${where.home}${ref.slice(1)}`]
  }
  const tail = `/${ref.replace(/^\.\//, '')}`
  const out: string[] = []
  for (let i = where.seen.length - 1; i >= 0; i--) {
    if (where.seen[i]!.endsWith(tail)) {
      out.push(where.seen[i]!)
    }
  }
  if (where.cwd !== undefined) {
    out.push(`${where.cwd}${tail}`)
  }
  return out
}
