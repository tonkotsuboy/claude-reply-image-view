import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import { blockCells, drawsPictures, fitRow, pngSize } from './layout'
import type { Size } from './layout'
import { absoluteImagePaths, candidates, imageRefs, isVideo, showsImages, toolImages } from './paths'
import { decodeThumb } from './png'
import type { Thumb } from './png'

/**
 * One tile, ready to draw: a PNG file or inline PNG bytes, its size, a block thumbnail where the
 * terminal can't draw pictures, and the file it opens on cmd+click.
 */
type Shown = {
  key: string
  label: string
  picture: { file: string } | { png: string }
  size: Size | null
  thumb: Thumb | null
  href?: string
}

// Files that exist, keyed by path, and inline pictures, keyed by tool call: drawn (Shown) or not
// drawable (null, e.g. no converter), so neither is converted or decoded again. A path whose file
// doesn't exist yet isn't cached: the reply may name it before the file is written.
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
// The Image element takes inline PNG bytes up to 2 MiB.
const INLINE_MAX = 2 * 1024 * 1024

// A finished call's standalone result row (ToolResult) carries no input, so the input of each
// call to a showing tool is kept by its id. Limit: module memory, like `seen`.
const inputs = new Map<string, unknown>()
const INPUTS_MAX = 200

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

async function thumbFor($: EngineInterface, base64: string): Promise<Thumb | null> {
  return (await canDrawPictures($)) ? null : decodeThumb(Uint8Array.fromBase64(base64))
}

async function describe($: EngineInterface, source: string): Promise<Shown | null> {
  const png = /\.png$/i.test(source) ? source : await convertedPng($, source)
  if (png === undefined) {
    return null
  }
  const base = source.split('/').pop() ?? source
  const tile = { key: source, label: isVideo(source) ? `▶ ${base}` : base, picture: { file: png }, href: `file://${source}` }
  // Over $.fs.read's 4 MiB cap the picture still draws, only without its aspect ratio.
  const base64 = await $.fs.read(png, { as: 'bytes' }).then(bytes => bytes.base64, () => undefined)
  if (base64 === undefined) {
    return { ...tile, size: null, thumb: null }
  }
  const size = pngSize(base64)
  if (size === null) {
    return null // named .png but not a PNG
  }
  return { ...tile, size, thumb: await thumbFor($, base64) }
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

/** The tiles for `refs`, each resolved on its own (in parallel, order kept), duplicates dropped. */
async function resolveAll($: EngineInterface, refs: readonly string[]): Promise<Shown[]> {
  if (refs.length === 0) {
    return []
  }
  home ??= await $.env.get('HOME')
  const where = { home, cwd: await $.session.cwd(), seen: [...seen] }
  const resolved = await Promise.all(refs.map(ref => resolve($, ref, where)))
  return [...new Map(resolved.flatMap(shown => (shown ? [[shown.key, shown] as const] : []))).values()]
}

/** A PNG a tool returned inline (a screenshot), as a tile; null when it isn't a PNG or is too big. */
async function inline($: EngineInterface, key: string, base64: string, label: string): Promise<Shown | null> {
  if (!looked.has(key)) {
    const size = base64.length * 0.75 <= INLINE_MAX ? pngSize(base64) : null
    looked.set(key, size && { key, label, picture: { png: base64 }, size, thumb: await thumbFor($, base64) })
  }
  return looked.get(key) ?? null
}

function fit(label: string, columns: number): string {
  return label.length > columns ? `${label.slice(0, Math.max(1, columns - 1))}…` : label
}

/** `body` with a row of `list`'s tiles under it, indented past the row's bullet. */
async function withTiles(
  $: EngineInterface,
  e: RenderInput<'AssistantMessage' | 'ToolUse' | 'ToolResult' | 'ToolGroup', 'terminal'>,
  body: RenderElement,
  list: readonly Shown[],
): Promise<RenderElement> {
  // fitRow caps the height itself; the width is what's left of the viewport after the indent.
  const cells = fitRow(list.map(image => image.size), Infinity, (e.viewport?.columns ?? 80) - 2)
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
          const label = fit(image.label, columns)
          return (
            <Box key={image.key} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
              {image.thumb ? (
                <Raster key={`blocks-${i}`} columns={columns} rows={rows} cells={blockCells(image.thumb, columns, rows)} />
              ) : (
                <Image source={{ ...image.picture, format: 'png' }} columns={columns} rows={rows} alt={image.label} />
              )}
              {/* The name links to the file, so cmd+click opens it in its default app (a video in
                  the player). A Button would not do: clicks reach a mod only in the fullscreen
                  terminal, not on the main screen. */}
              <Text dimColor>{image.href ? <Link href={image.href} label={label} /> : label}</Text>
            </Box>
          )
        })}
        {list.length > cells.length && <Text dimColor>+{list.length - cells.length}</Text>}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Remembering paths is a side job: a failure here must never fail the tool call.
    try {
      if (showsImages(e.tool)) {
        inputs.set(e.tool_use_id, e)
        if (inputs.size > INPUTS_MAX) {
          inputs.delete(inputs.keys().next().value!)
        }
      }
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
    const list = await resolveAll($, refs)
    return withTiles($, e, await next(e), list)
  })

  // Tools whose job is to show the user something (SendUserFile, SendUserMessage, screenshots)
  // get the same tiles once they finish. Where depends on how the call is drawn: a standalone
  // call's use row only draws while it runs and its result goes to its own ToolResult row, so
  // the tiles go under that; a row of an unfolded group carries its output itself.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) {
      return next(e)
    }
    const id = e.props.tool_use_id
    const list = await toolTiles($, [{ id, ...e.props, input: inputs.get(id), isRunning: false }])
    return list.length === 0 ? next(e) : withTiles($, e, await next(e), list)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.output === undefined) {
      return next(e)
    }
    const list = await toolTiles($, [{ id: e.props.tool_use_id, ...e.props }])
    return list.length === 0 ? next(e) : withTiles($, e, await next(e), list)
  })

  // A run of calls folded into one count line draws no ToolUse rows, so its tiles go under that
  // line; unfolded (ctrl+o), each row draws its own.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) {
      return next(e)
    }
    const list = await toolTiles($, e.props.calls.map((call, i) => ({ id: call.tool_use_id ?? `${e.requestId}#${i}`, ...call })))
    return list.length === 0 ? next(e) : withTiles($, e, await next(e), list)
  })
}

type Call = { id: string; tool: string; input: unknown; output?: unknown; isRunning: boolean; isErrored: boolean }

/** The tiles for the finished calls among `calls` that show the user an image. */
async function toolTiles($: EngineInterface, calls: readonly Call[]): Promise<Shown[]> {
  const done = calls.filter(call => !call.isRunning && !call.isErrored)
  const found = done.map(call => ({ call, ...toolImages(call.tool, call.input, call.output) }))
  const files = await resolveAll($, found.flatMap(({ refs }) => refs))
  const shots = await Promise.all(
    found.flatMap(({ call, pngs }) => pngs.map((png, i) => inline($, `${call.id}#${i}`, png, `screenshot ${i + 1}`))),
  )
  return [...files, ...shots.filter(shot => shot !== null)]
}
