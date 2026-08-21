---
name: notes-sjtu-sync
description: Safely inspect, upload, download, link, pull, push, diff, or unlink one Markdown file with https://notes.sjtu.edu.cn through the notes-sjtu-sync CLI. Use when the user asks to synchronize a Markdown document with SJTU Notes, check whether either copy changed, resolve a synchronization conflict, or authenticate the CLI.
---

# SJTU Notes Sync

Use `notes-sjtu-sync` for exactly one Markdown file per invocation.

## Workflow

1. Check installation with `notes-sjtu-sync --version`. If missing, tell the user to install the npm package; do not install it implicitly.
2. Check authentication with `notes-sjtu-sync auth status --json`. For login, ask the user to complete `auth login` locally or use the hidden `auth import` prompt. Never request, read, paste, log, or echo a password, MFA code, or session cookie.
3. Before `upload`, `push`, `link --push`, or any `--force` operation, run the same command with `--dry-run --json` when supported. Summarize the target note, text change, images, and overwrite risk.
4. Ask for explicit confirmation after showing the preflight. A prior general request to inspect or synchronize is not confirmation to overwrite.
5. Run the real command only after confirmation. Prefer `--json` and use the structured status and error code instead of parsing prose.
6. On a Conflict, do not add `--force` automatically. Report the Conflict Bundle paths and let the user merge the primary Markdown manually or explicitly choose `pull --force` or `push --force`.
7. Before `push` or `link --push`, ensure the remote note is closed in every browser and device, including the user's and collaborators'. CodiMD 2.4.1 refuses API updates while any user has the note open; wait a few seconds after closing it, then retry. `--force` cannot bypass this server limitation.

## Guardrails

- Treat `.notes-sjtu-sync/` as private local state. Do not edit its manifest or baseline manually.
- Do not edit Markdown merely to make synchronization succeed. The CLI owns image-path translation.
- Do not use directory loops, glob expansion, or batch execution; ask the user to identify one document.
- Use `unlink` only to remove tracking. It never deletes the Local Markdown, Assets, or Remote Note.
- Keep ordinary external image URLs, CSS URLs, formulas, diagrams, and raw text unchanged.
- If the CLI reports an unsupported server or authentication outage, stop and report it; do not bypass TLS or scrape credentials from browser storage.
