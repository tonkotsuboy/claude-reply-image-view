# Claude Reply Image View

A Claude Code mod that shows the images and videos Claude talks about. When a reply names an image or video file, a row of thumbnails appears right under that reply, so you see the screenshot Claude just took instead of a bare path.

It is the other half of [claude-image-view](https://github.com/jarrodwatts/claude-image-view), which previews the images *you* paste.

```
● Saved the screenshot to /tmp/shots/after.png and the recording to ~/rec/demo.mp4.
  ╭──────────────────────╮ ╭──────────────────────╮
  │                      │ │                      │
  │     (screenshot)     │ │    (first frame)     │
  │                      │ │                      │
  │ after.png            │ │ ▶ demo.mp4           │
  ╰──────────────────────╯ ╰──────────────────────╯
```

## Install

At the prompt of a Claude Code session:

```
/plugin install reply-image-view --marketplace tonkotsuboy/claude-reply-image-view
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install reply-image-view --marketplace tonkotsuboy/claude-reply-image-view
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `tonkotsuboy/claude-reply-image-view`, then Add plugin.

## What it finds

Any of these in a reply, up to six per reply. Files that don't exist are skipped, so a path Claude only talks about draws nothing.

| Written as | Example | Resolved by |
|---|---|---|
| Absolute path | `/Users/me/Desktop/shot.png` | as is |
| Home path | `~/Desktop/shot.png` | `$HOME` |
| Relative path | `reports/out.png` | the latest path with that ending a tool call touched, else the working directory |
| File name alone | `out.png` | the same |
| Inside a code span | `` `my folder/shot 2.png` `` | the same; spaces and non-ASCII names work here |

Image types: PNG, JPEG, GIF, WebP, HEIC, BMP, TIFF. Videos (MP4, MOV, M4V, WebM) show their first frame with a ▶ before the name. URLs are ignored.

"A tool call touched" means the path appeared in the input or output of any tool call in the session (a `Read`, a `Write`, a `Bash` command, a screenshot tool), which is how a reply that only says `out.png` finds the right file.

## Opening a file

The name under each thumbnail is a `file://` link. Cmd+click it (Ctrl+click on Linux, depending on the terminal) and the terminal opens the file in its default app: a video in your player, an image in your viewer. This works in terminals that support OSC 8 hyperlinks, such as Ghostty, iTerm2, WezTerm and kitty. In Claude Code's fullscreen mode a plain click goes to Claude Code, so hold Ctrl or Alt.

Links point at your local disk, so they don't open files that only exist on a remote machine over SSH.

## How it works

1. A `tool.call` hook remembers the absolute image and video paths seen in tool inputs and outputs (in memory, at most 500).
2. A `ui.render` hook on each assistant reply finds image references in the text, resolves them as above, and draws them under the reply.
3. PNGs are drawn straight from the file. Other image types are converted once with macOS `sips`, and videos to their first frame with `ffmpeg`, into Claude Code's temp folder (`/tmp/claude-<uid>/reply-image-view-<hash>.png`).
4. In Ghostty and kitty the thumbnail is a real picture. Elsewhere it is drawn in colored half blocks.

Replies that Claude Code shows collapsed to a summary (text written between tool calls) get no thumbnails; press ctrl+o to see them.

## Terminal support

| Terminal | Thumbnail |
|---|---|
| Ghostty, kitty, and terminals built on them | Real picture |
| iTerm2, Terminal.app, WezTerm, VS Code, most others | Half blocks |
| Inside tmux or screen | Half blocks |

`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` makes Claude Code draw real pictures in any terminal; only set it if your terminal supports the kitty graphics protocol's Unicode placeholders. `CLAUDE_IMAGE_VIEW_RENDERER=image` or `=blocks` overrides the guess.

## Requirements

- Claude Code with mods support
- macOS for non-PNG images (`sips` ships with it)
- `ffmpeg` on your `PATH` for video thumbnails (`brew install ffmpeg`)

On Linux, PNG thumbnails work; other image types and videos without `ffmpeg` show nothing.

## Security

Local only, no network requests. It reads the image files a reply names, runs `sips` or `ffmpeg` on them to write one PNG each into Claude Code's temp folder, runs `id -u` once to find that folder, and reads a few environment variables (`HOME`, `TERM`, `TERM_PROGRAM`, `TMUX` and similar) to pick a renderer. Run `claude plugin validate` on the repo to see every event it hooks and every call it makes.

## Development

```bash
git clone https://github.com/tonkotsuboy/claude-reply-image-view
cd claude-reply-image-view
claude --plugin-dir .        # load it for one session
claude plugin validate .
claude plugin test .
```

## Credits

The PNG decoder, half-block renderer and terminal detection (`hooks/png.ts`, `hooks/layout.ts`) are adapted from [jarrodwatts/claude-image-view](https://github.com/jarrodwatts/claude-image-view) (MIT, see `LICENSE.image-view`).

## License

MIT
