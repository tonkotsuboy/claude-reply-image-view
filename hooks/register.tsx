import type { EngineInterface, Register } from 'claude-code'

import { blockCells, drawsPictures, fitRow, pngSize } from './layout'
import type { Size } from './layout'
import { absoluteImagePaths, candidates, imageRefs, isVideo } from './paths'
import { decodeThumb } from './png'
import type { Thumb } from './png'

/** A file a reply names, ready to draw: its PNG, size, and a block thumbnail where pictures can't be drawn. */
type Shown = { source: string; png: string; size: Size | null; thumb: Thumb | null }

// Files that exist, keyed by path: drawn (Shown) or not drawable (null, e.g. no converter), so
// neither is converted or read again. A path whose file doesn't exist yet isn't cached: the reply
// may name it before the file is written.
const looked = new Map<string, Shown | null>()
let pictures: boolean | undefined
let tmpRoot: string | undefined
let home: string | undefined

// Absolute image paths this session's tool calls touched, oldest first, so a reply that names
// only `out.png` finds the file. Limit: this is module memory, so a reload forgets it until the
// next tool call; move it to $.state if old replies must keep resolving across reloads.
const seen = new Set<string>()
const SEEN_MAX = 500
// Past this a tool's output (a whole file read) isn't scanned.
const SCAN_MAX = 200_000

function remember(text: string) {
  for (const path of absoluteImagePaths(text)) {
    seen.delete(path)
    seen.add(path)
  }
  for (const path of seen) {
    if (seen.size <= SEEN_MAX) {
      break
    }
    seen.delete(path)
  }
}

// $.env.get takes a literal name, so the variables are listed one by one; read once per session.
async function canDrawPictures($: EngineInterface): Promise<boolean> {
  if (pictures === undefined) {
    pictures = drawsPictures({
      TERM: await $.env.get('TERM'),
      TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
      TMUX: await $.env.get('TMUX'),
      STY: await $.env.get('STY'),
      KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
      GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
      CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
      CLAUDE_CODE_SESSION_KIND: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
      CLAUDE_IMAGE_VIEW_RENDERER: await $.env.get('CLAUDE_IMAGE_VIEW_RENDERER'),
    })
  }
  return pictures
}

// The terminal draws PNG only, so other formats are converted once into Claude Code's temp
// folder: images by sips (macOS), videos to their first frame by ffmpeg (on PATH).
// Limit: no sips on Linux and no ffmpeg anywhere means no tile; nothing falls back.
async function convertedPng($: EngineInterface, source: string): Promise<string | undefined> {
  if (tmpRoot === undefined) {
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    tmpRoot = `${((await $.env.get('CLAUDE_CODE_TMPDIR')) ?? '/tmp').replace(/\/+$/, '')}/claude-${uid}`
  }
  let hash = 2166136261
  for (const char of source) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0
  }
  const out = `${tmpRoot}/reply-image-view-${hash.toString(16)}.png`
  if (await $.fs.exists(out)) {
    return out
  }
  const command = isVideo(source)
    ? ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", out]
    : ['sips', '-s', 'format', 'png', '-Z', '1600', source, '--out', out]
  const { exitCode } = await $.process.run(command).catch(() => ({ exitCode: 1 }))
  return exitCode === 0 ? out : undefined
}

async function describe($: EngineInterface, source: string): Promise<Shown | null> {
  const png = /\.png$/i.test(source) ? source : await convertedPng($, source)
  if (png === undefined) {
    return null
  }
  // Over $.fs.read's 4 MiB cap the picture still draws, only without its aspect ratio.
  const base64 = await $.fs.read(png, { as: 'bytes' }).then(bytes => bytes.base64, () => undefined)
  if (base64 === undefined) {
    return { source, png, size: null, thumb: null }
  }
  const size = pngSize(base64)
  if (size === null) {
    return null // named .png but not a PNG
  }
  const thumb = (await canDrawPictures($)) ? null : decodeThumb(Uint8Array.fromBase64(base64))
  return { source, png, size, thumb }
}

/** The file at `source` ready to draw; undefined when there is no file, null when it can't be drawn. */
async function lookUp($: EngineInterface, source: string): Promise<Shown | null | undefined> {
  if (looked.has(source)) {
    return looked.get(source)
  }
  if (!(await $.fs.exists(source))) {
    return undefined
  }
  const shown = await describe($, source)
  looked.set(source, shown)
  return shown
}

/** The first of `ref`'s candidate paths that can be drawn. */
async function resolve($: EngineInterface, ref: string, where: Parameters<typeof candidates>[1]): Promise<Shown | undefined> {
  for (const source of candidates(ref, where)) {
    const shown = await lookUp($, source)
    if (shown !== undefined) {
      return shown ?? undefined
    }
  }
  return undefined
}

function fit(label: string, columns: number): string {
  return label.length > columns ? `${label.slice(0, Math.max(1, columns - 1))}…` : label
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Remembering paths is a side job: a failure here must never fail the tool call.
    try {
      const input = JSON.stringify(e)
      if (input.length <= SCAN_MAX) {
        remember(input)
      }
      if (result.text !== undefined && result.text.length <= SCAN_MAX) {
        remember(result.text)
      }
    } catch {}
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) {
      return next(e)
    }
    const refs = imageRefs(e.props.text)
    if (refs.length === 0) {
      return next(e)
    }
    home ??= await $.env.get('HOME')
    const where = { home, cwd: await $.session.cwd(), seen: [...seen] }
    // Each reference resolves on its own, so they look up in parallel; the order is kept.
    const resolved = await Promise.all(refs.map(ref => resolve($, ref, where)))
    const list = [...new Map(resolved.flatMap(shown => (shown ? [[shown.source, shown] as const] : []))).values()]
    // The reply's bullet indent (2) is left of the tiles; fitRow caps the height itself.
    const cells = fitRow(list.map(image => image.size), Infinity, (e.viewport?.columns ?? 80) - 2)
    const body = await next(e)
    if (cells.length === 0) {
      return body
    }

    const { Box, Image, Link, Raster, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {body}
        <Box flexDirection="row" columnGap={1} paddingLeft={2}>
          {cells.map(({ columns, rows }, i) => {
            const image = list[i]!
            const base = image.source.split('/').pop() ?? image.source
            const name = isVideo(image.source) ? `▶ ${base}` : base
            return (
              <Box key={image.source} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.thumb ? (
                  <Raster key={`blocks-${i}`} columns={columns} rows={rows} cells={blockCells(image.thumb, columns, rows)} />
                ) : (
                  <Image source={{ file: image.png, format: 'png' }} columns={columns} rows={rows} alt={name} />
                )}
                {/* The name links to the file, so cmd+click opens it in its default app (a video in
                    the player). A Button would not do: clicks reach a mod only in the fullscreen
                    terminal, not on the main screen. */}
                <Text dimColor>
                  <Link href={`file://${image.source}`} label={fit(name, columns)} />
                </Text>
              </Box>
            )
          })}
          {list.length > cells.length && <Text dimColor>+{list.length - cells.length}</Text>}
        </Box>
      </Box>
    )
  })
}
