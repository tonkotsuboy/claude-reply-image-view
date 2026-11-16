import { expect, test } from 'claude-code/testing'

import { absoluteImagePaths, candidates, imageRefs, isVideo, toolImages } from './paths'

test('picks the images a showing tool shows, and nothing from other tools', () => {
  // SendUserFile: the resolved attachment paths once it ran, the input's paths before; media only.
  expect(
    toolImages('SendUserFile', { files: ['a.png', 'notes.md'] }, { attachments: [{ path: '/w/a.png' }, { path: '/w/notes.md' }] }),
  ).toEqual({ refs: ['/w/a.png'], pngs: [] })
  expect(toolImages('SendUserFile', { files: ['shots/a.png', 'b.mov'] }, undefined)).toEqual({
    refs: ['shots/a.png', 'b.mov'],
    pngs: [],
  })
  // SendUserMessage reads like a reply.
  expect(toolImages('SendUserMessage', { message: 'Saved `out.png` and /tmp/b.jpg.' }, undefined)).toEqual({
    refs: ['out.png', '/tmp/b.jpg'],
    pngs: [],
  })
  // A screenshot tool: the file it saved, and a PNG it returned inline (a JPEG one is skipped).
  expect(
    toolImages(
      'mcp__chrome-devtools__take_screenshot',
      { filePath: '/tmp/shot.png' },
      [
        { type: 'text', text: 'Saved screenshot to /tmp/shot.png.' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
      ],
    ),
  ).toEqual({ refs: ['/tmp/shot.png'], pngs: ['iVBORw0KGgo='] })
  expect(toolImages('mcp__playwright__browser_take_screenshot', {}, { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] })).toEqual({
    refs: [],
    pngs: ['AAAA'],
  })
  // Bash and Read touch images too, but don't show them to the user.
  expect(toolImages('Bash', { command: 'ls /tmp/a.png' }, { stdout: '/tmp/a.png' })).toEqual({ refs: [], pngs: [] })
  expect(toolImages('Read', { file_path: '/tmp/a.png' }, undefined)).toEqual({ refs: [], pngs: [] })
})

test('finds absolute, ~, relative, bare and quoted references; skips URLs and other files', () => {
  const text = [
    '画像は `/Users/me/Desktop/心/20.png` です。',
    '比較: ~/shots/after.webp と /tmp/x.JPG.',
    'URL https://example.com/a.png と /src/app.ts は対象外',
    '保存先は reports/out.png、名前だけなら screenshot-1.png、日本語に挟まれた画像は20.pngです',
    '`心/21.png` と `my shot.png` と ./rel/b.gif',
    '録画: /tmp/demo.mp4',
  ].join('\n')
  expect(imageRefs(text, 20)).toEqual([
    '/Users/me/Desktop/心/20.png',
    '~/shots/after.webp',
    '/tmp/x.JPG',
    'reports/out.png',
    'screenshot-1.png',
    '20.png',
    '心/21.png',
    'my shot.png',
    './rel/b.gif',
    '/tmp/demo.mp4',
  ])
  expect(isVideo('/tmp/demo.MOV')).toBe(true)
  expect(isVideo('/tmp/demo.png')).toBe(false)
})

test('pulls absolute image paths out of tool traffic', () => {
  const input = JSON.stringify({ tool: 'Write', file_path: '/w/reports/out.png', content: 'x' })
  expect(absoluteImagePaths(`${input}\n/a/b.png\nhttps://x.com/c.png`)).toEqual(['/w/reports/out.png', '/a/b.png'])
  const spaced = JSON.stringify({ tool: 'Bash', command: `ls "/s/日本語 フォルダ/small 20.png" '/s/my demo.mp4'` })
  expect(absoluteImagePaths(spaced)).toEqual(['/s/日本語 フォルダ/small 20.png', '/s/my demo.mp4'])
})

test('resolves a reference: absolute, ~, latest seen path with that tail, then cwd', () => {
  const seen = ['/old/reports/out.png', '/x/other.png', '/new/reports/out.png']
  expect(candidates('/a.png', { seen })).toEqual(['/a.png'])
  expect(candidates('~/a.png', { home: '/h', seen })).toEqual(['/h/a.png'])
  expect(candidates('reports/out.png', { cwd: '/c', seen })).toEqual([
    '/new/reports/out.png',
    '/old/reports/out.png',
    '/c/reports/out.png',
  ])
  expect(candidates('./out.png', { cwd: '/c', seen })).toEqual([
    '/new/reports/out.png',
    '/old/reports/out.png',
    '/c/out.png',
  ])
  expect(candidates('ther.png', { seen })).toEqual([])
})
