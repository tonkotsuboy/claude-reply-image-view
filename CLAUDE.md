# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A Claude Code mod (hooks module, no build step). `hooks/register.tsx` holds the hooks, `hooks/paths.ts` the pure path/tool parsing (tested in `hooks/paths.test.ts`).

## Commands

- `claude plugin validate .` — checks the manifest and module as the engine loads them. Known warnings that are fine: `Uint8Array.fromBase64` (TS2550; the runtime has it), the TS warnings in `hooks/png.ts`, and "gating hook without .catch: tool.call" (its side work is wrapped in try/catch).
- `claude plugin test .` — runs `*.test.ts` (import from `claude-code/testing`).

## Conventions

- Everything in English: code, comments, commit messages, README. Exception: Japanese test fixtures, since the parser handles Japanese prose and paths.
- `README.md` and `README.ja.md` mirror each other; change both.
- `hooks/png.ts` and `hooks/layout.ts` are adapted from jarrodwatts/claude-image-view (MIT, `LICENSE.image-view`). Keep changes there minimal and keep the credit.

## Releasing

- Commit and push straight to `main`; no PRs.
- Bump `version` in `.claude-plugin/plugin.json` for every release, or `claude plugin update` won't pick it up.
- To try a pushed release locally: `claude plugin marketplace update claude-reply-image-view`, `claude plugin update reply-image-view@claude-reply-image-view`, then `/reload-plugins`.

## Rendering gotchas (verified in a live session)

- A standalone tool call's `ToolUse` row is drawn only while it runs; its finished output goes to the `ToolResult` row, which carries no input (hence the `inputs` map filled in `tool.call`).
- Calls folded into one count line ("Called chrome-devtools 3 times") are a `ToolGroup`; no `ToolUse` rows are drawn until it is expanded.
- Button presses reach a mod only in Claude Code's fullscreen mode, so the file name is a `Link` (OSC 8, cmd+click) instead.
- `$.env.get` must be called with a literal name; the validator rejects a variable.
- `Raster` requires `key`; `Image` doesn't.
- Text between tool calls is shown as a summary (`isSummary`), so tiles only appear under full reply blocks.

## Testing in a live session

The installed plugin keeps running while you test, so load a dev copy under a different plugin name (e.g. `reply-image-view-dev` in the session's mods folder); expect doubled tiles under replies while both are loaded, and remove the copy afterwards. To see which render components fire with which props, a throwaway mod that logs via `$.fs.write` is quicker than guessing.
