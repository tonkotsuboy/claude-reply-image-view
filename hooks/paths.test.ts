import { expect, test } from 'claude-code/testing'

import { absoluteImagePaths, candidates, imageRefs, isVideo } from './paths'

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
