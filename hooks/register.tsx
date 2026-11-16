import type { EngineInterface, Register } from 'claude-code'

import { blockCells, drawsPictures, fitRow, pngSize } from './layout'
import type { Size } from './layout'
import { absoluteImagePaths, candidates, imageRefs, isVideo } from './paths'
import { decodeThumb } from './png'
import type { Thumb } from './png'

type Shown = { source: string; png: string; size: Size | null }

// The tile chrome (border + label) fitRow budgets on top of the picture rows.
const TILE_MAX_ROWS = 14 + 3

// Only found images are cached: a path the reply names before the file exists is looked up again
// on the next draw.
const found = new Map<string, Shown>()
const thumbs = new Map<string, Thumb | null>()
let pictures: boolean | undefined
let tmpRoot: string | undefined

// Absolute image paths this session's tool calls touched, oldest first, so a reply that names
// only `out.png` finds the file. Limit: this is module memory, so a reload forgets it until the next
// tool call; move it to $.state if old replies must keep resolving across reloads.
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

async function lookUp($: EngineInterface, source: string): Promise<Shown | undefined> {
  const cached = found.get(source)
  if (cached !== undefined) {
    return cached
  }
  if (!(await $.fs.exists(source))) {
    return undefined
  }
  const isPng = /\.png$/i.test(source)
  const png = isPng ? source : await convertedPng($, source)
  if (png === undefined) {
    return undefined
  }
  // Over $.fs.read's 4 MiB cap the picture still draws, only without its aspect ratio.
  const base64 = await $.fs.read(png, { as: 'bytes' }).then(bytes => bytes.base64, () => undefined)
  const size = base64 === undefined ? null : pngSize(base64)
  if (base64 !== undefined && size === null) {
    return undefined // named .png but not a PNG
  }
  if (base64 !== undefined && !(await canDrawPictures($))) {
    thumbs.set(png, decodeThumb(Uint8Array.fromBase64(base64)))
  }
  const shown = { source, png, size }
  found.set(source, shown)
  return shown
}

function fit(label: string, columns: number): string {
  return label.length > columns ? `${label.slice(0, Math.max(1, columns - 1))}…` : label
}

function markdownText(label: string): string {
  return label.replace(/[\\`*_[\]()#<>]/g, char => `\\${char}`)
}

function fileUrl(path: string): string {
  return `file://${encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29')}`
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
    const where = { home: await $.env.get('HOME'), cwd: await $.session.cwd(), seen: [...seen] }
    const list: Shown[] = []
    for (const ref of refs) {
      for (const source of candidates(ref, where)) {
        const shown = await lookUp($, source)
        if (shown !== undefined) {
          if (!list.some(image => image.source === shown.source)) {
            list.push(shown)
          }
          break
        }
      }
    }
    // The reply's bullet indent (2) is left of the tiles.
    const cells = fitRow(list.map(image => image.size), TILE_MAX_ROWS, (e.viewport?.columns ?? 80) - 2)
    const body = await next(e)
    if (cells.length === 0) {
      return body
    }

    const { Box, Image, Markdown, Raster, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {body}
        <Box flexDirection="row" columnGap={1} paddingLeft={2}>
          {cells.map(({ columns, rows }, i) => {
            const image = list[i]!
            const thumb = thumbs.get(image.png)
            const base = image.source.split('/').pop() ?? image.source
            const name = isVideo(image.source) ? `▶ ${base}` : base
            return (
              <Box key={image.source} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {thumb ? (
                  <Raster key={`blocks-${i}`} columns={columns} rows={rows} cells={blockCells(thumb, columns, rows)} />
                ) : (
                  <Image key={`image-${i}`} source={{ file: image.png, format: 'png' }} columns={columns} rows={rows} alt={name} />
                )}
                {/* The label is a file:// link, so the terminal opens the file in its default app
                    (a video in the player) on cmd+click. A Button's onPress would not do: clicks
                    reach a mod only in the fullscreen terminal, not on the main screen. */}
                <Box width={columns}>
                  <Markdown dimColor text={`[${markdownText(fit(name, columns))}](${fileUrl(image.source)})`} />
                </Box>
              </Box>
            )
          })}
          {list.length > cells.length && <Text dimColor>+{list.length - cells.length}</Text>}
        </Box>
      </Box>
    )
  })
}
