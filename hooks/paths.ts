const VIDEO = 'mp4|mov|m4v|webm'
// A file extension the mod draws, dot included.
const EXT = `\\.(?:png|jpe?g|gif|webp|heic|bmp|tiff?|${VIDEO})`
const VIDEO_PATH = new RegExp(`\\.(?:${VIDEO})$`, 'i')

/** Whether a path names a video, shown by its first frame. */
export function isVideo(path: string): boolean {
  return VIDEO_PATH.test(path)
}

// A `code span` naming an image: taken whole, so it may hold spaces or Japanese.
const QUOTED = `\`([^\`\\n]+?${EXT})\``
// An absolute or ~/ path. The lookbehind keeps it out of URLs (https://x/a.png); spaces end it.
const ABSOLUTE = `(?<![\\w.:/~-])(?:~/|/)[^\\s\`'"<>()\\[\\]|*,、。）」]*?${EXT}(?!\\w)`
// A relative path or a bare file name, ASCII only so it doesn't swallow the Japanese prose
// around it (画像は20.pngです finds 20.png).
const RELATIVE = `(?<![\\w.:/~@-])(?:\\.{1,2}/)?[\\w@+-][\\w.@+-]*(?:/[\\w.@+-]+)*${EXT}(?!\\w)`
// An absolute path between quotes, as a JSON value or a shell argument: may hold spaces.
const QUOTED_ABSOLUTE = `\\\\?["'](/[^"'\\\\\\n]+?${EXT})\\\\?["']`

// One alternation scans left to right without overlaps, so a code span's inside is never
// matched again and the matches come out in reading order.
const REFERENCE = new RegExp(`${QUOTED}|${ABSOLUTE}|${RELATIVE}`, 'gi')
const TOOL_PATH = new RegExp(`${QUOTED_ABSOLUTE}|${ABSOLUTE}`, 'gi')

/** The distinct image references a reply makes, as written, in the order they appear; at most `limit`. */
export function imageRefs(text: string, limit = 6): string[] {
  const refs = [...text.matchAll(REFERENCE)].map(([whole, quoted]) => (quoted ?? whole).trim())
  return [...new Set(refs)].slice(0, limit)
}

/** Absolute image paths anywhere in `text` (a tool call's input or output). */
export function absoluteImagePaths(text: string): string[] {
  const paths = [...text.matchAll(TOOL_PATH)].map(([whole, quoted]) => quoted ?? whole)
  return [...new Set(paths.filter(path => path.startsWith('/')))]
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
  const seen = [...where.seen].reverse().filter(path => path.endsWith(tail))
  return where.cwd === undefined ? seen : [...seen, `${where.cwd}${tail}`]
}
