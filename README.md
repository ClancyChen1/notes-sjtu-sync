# notes-sjtu-sync

[中文说明](README_CN.md)

`notes-sjtu-sync` synchronizes one local Markdown file with one note on [SJTU Notes](https://notes.sjtu.edu.cn). Use `upload` to create a new Remote Note from local Markdown and its directly referenced images, or use `download` to save an existing Remote Note and its native images locally. The first transfer establishes tracking by default; `link` can pair two copies that already exist.

Once tracked, `status` identifies local, remote, or two-sided changes, while `diff` shows how each side differs from their last common baseline. `push` sends local changes to SJTU Notes, and `pull` brings remote changes into the local file. If both sides changed, the tool does not guess at a merge or silently overwrite either copy; it creates conflict reference files for manual resolution.

The workflow resembles Git because it has local and remote copies, status, diffs, push, and pull. Its structure is deliberately simpler: every command handles one Markdown file, with no repository initialization, staging area, commits, branches, history, or automatic merge. It stores only the last common baseline and image mappings needed for safe synchronization. Local Markdown keeps offline-friendly local image paths, while the Remote Note uses CodiMD image URLs.

> **Windows is not currently supported.** Version 0.1 is tested and supported only on Linux and macOS.

The CLI targets CodiMD 2.4.1 on `notes.sjtu.edu.cn`. It is not a general CodiMD client or a version-control system.

## Requirements and installation

- Node.js 22 or newer
- Linux or macOS
- A system Chrome/Chromium for browser login, or a `connect.sid` value for hidden import

### Install from GitHub Releases (recommended)

This project has not yet been published to the npm registry. Install the npm package directly from GitHub Releases without cloning the source repository:

```sh
npm install -g https://github.com/ClancyChen1/notes-sjtu-sync/releases/download/v0.1.0/notes-sjtu-sync-0.1.0.tgz
```

Alternatively, download `notes-sjtu-sync-0.1.0.tgz` from [GitHub Releases](https://github.com/ClancyChen1/notes-sjtu-sync/releases), then install the local file:

```sh
npm install -g ./notes-sjtu-sync-0.1.0.tgz
```

Choose the `notes-sjtu-sync-0.1.0.tgz` release asset. GitHub's automatically generated `Source code` archives are not npm installation packages.

### Install from a checkout

```sh
npm install
npm run check
npm install -g .
```

### Install the agent skill

The bundled agent skill is installed separately:

```sh
npx skills add ClancyChen1/notes-sjtu-sync --skill notes-sjtu-sync
```

Installing the CLI never writes to an agent's skill directories.

## Authentication

Open an isolated, visible system browser and complete SJTU OAuth normally:

```sh
notes-sjtu-sync auth login
notes-sjtu-sync auth status
```

If the machine running the CLI has no Chrome/Chromium or desktop session, `auth login` cannot open a browser. In that case, follow the steps below to obtain the `connect.sid` session Cookie from a browser already signed in to SJTU Notes, then run:

```sh
notes-sjtu-sync auth import
```

The command prompts you to paste `connect.sid`. To keep the session credential out of the screen and terminal history, the prompt echoes no characters: the terminal remains visually blank after pasting, and you simply press Enter. The next section explains how to obtain the required `connect.sid`.

### Get `connect.sid`

1. Open `https://notes.sjtu.edu.cn` in your own Chrome/Chromium browser and sign in.
2. Keep the page open and press `F12` or `Ctrl+Shift+I` (`Command+Option+I` on macOS) to open DevTools.
3. Open **Application → Storage → Cookies** and select `https://notes.sjtu.edu.cn`. See the [official Chrome cookie guide](https://developer.chrome.com/docs/devtools/application/cookies) for the current interface.
4. Find the row named `connect.sid` and copy its **Value**. Copy the raw value; do not URL-decode it or alter characters such as `%` and `.`.
5. Run `notes-sjtu-sync auth import`, paste the value, and press Enter. The prompt deliberately shows no characters while pasting.

Treat `connect.sid` as a temporary login credential. Never send it to another person, paste it into chat, commit it to Git, or expose it in a screenshot. `auth logout` deletes only the CLI's saved copy; sign out from SJTU Notes in the browser if you also need to invalidate the browser session.

For non-interactive use where a local script or secret manager already provides the Cookie, pass it through standard input rather than an argument:

```sh
printf '%s' "$SJTU_NOTES_SESSION" | notes-sjtu-sync auth import --stdin
```

This reads the value of the `SJTU_NOTES_SESSION` environment variable and pipes it to `auth import --stdin`. Normal interactive use does not require this variable; use the hidden prompt above instead.

The CLI never asks for or stores an SJTU password or MFA code. It stores only `connect.sid`, preferring macOS Keychain or Linux Secret Service. If neither is available, it warns and uses a user-only `0600` configuration file. `auth logout` deletes the local session.

For security, production requests are refused when `NODE_TLS_REJECT_UNAUTHORIZED=0`; unset that variable instead of bypassing certificate verification.

## Commands

```text
notes-sjtu-sync upload <file.md> [--no-track] [--dry-run]
notes-sjtu-sync download <url> [file.md] [--no-track] [--dry-run]
notes-sjtu-sync link <file.md> <url> [--pull|--push] [--dry-run]
notes-sjtu-sync unlink <file.md>
notes-sjtu-sync pull <file.md> [--force] [--dry-run]
notes-sjtu-sync push <file.md> [--force] [--dry-run]
notes-sjtu-sync status <file.md>
notes-sjtu-sync diff <file.md>
```

`upload` and `download` establish tracking by default. `--no-track` performs a one-off transfer. `link` establishes tracking for two existing copies: equal content needs no direction, while different content requires an explicit `--pull` or `--push`.

Every command accepts `--json`. Human output is English; JSON uses a stable envelope:

```json
{
  "ok": true,
  "command": "status",
  "result": {
    "status": "local_modified"
  }
}
```

Exit codes are `0` for success, `2` for usage/validation errors, `3` for authentication, `4` for missing/untracked content, `5` for conflicts/refused overwrites, `6` for network/server failures, and `7` for local state or I/O errors.

## Synchronization behavior

Tracking state lives next to the Markdown file in `.notes-sjtu-sync/`. On first tracking, the CLI idempotently adds `/.notes-sjtu-sync/` to that directory's `.gitignore`. State is per directory and per Markdown filename; move a document with `unlink <old-path>` followed by `link <new-path> <url>`.

The CLI compares local and remote logical content against the last common baseline. When both sides changed, it leaves the main file untouched and writes `base.md` and `remote.md` under `.notes-sjtu-sync/conflicts/`. Merge manually, then explicitly choose the direction. The CLI never auto-merges.

Local image paths stay local. The remote note receives CodiMD upload URLs. The CLI recognizes Markdown inline/reference images, CodiMD image-size syntax, and HTML `<img src>`. It does not interpret CSS URLs, formulas, diagrams, generic attachments, or ordinary external image links.

Only image files inside the Markdown file's directory tree may be uploaded. Absolute paths, `..` escapes, symlink escapes, extension/content mismatches, and non-image files are refused. Downloaded native images use stable content-hash names under `<document>.assets/`.

### Important: close the remote note before `push`

CodiMD 2.4.1 rejects its API update request while **any user has that note open**. Before `push` (or `link --push`), close the remote note in every browser and device, including your own, and ask collaborators to do the same. Wait a few seconds for the realtime session to clear, then retry. This is a server limitation, not a sync conflict; `--force` does not bypass it.

## Safe agent workflow

Before `upload`, `push`, `link --push`, or any `--force` operation, an agent should run `--dry-run --json`, summarize the target and image changes, and ask for explicit confirmation. A conflict must not be bypassed automatically.

## Development and validation

```sh
npm run typecheck
npm test
npm run build
npm pack
```

Automated tests use a local CodiMD-compatible HTTP service and fake remote notes. A real-site smoke test is optional because it requires an SJTU session and creates remote content: authenticate, upload a disposable Markdown file, verify `status`, edit each side in turn, exercise `push`/`pull`, then unlink it. Do not use production notes for conflict testing.

## License

[MIT](LICENSE) © 2026 ClancyChen1

## Disclaimer

This is an unofficial community project and is not affiliated with or endorsed by Shanghai Jiao Tong University, SJTU Notes, or the CodiMD project. It interacts with an external service whose APIs and availability may change without notice. Review every dry run, keep independent backups of important notes and images, and use the software at your own risk. The maintainers are not responsible for data loss, account issues, service interruption, or other damages arising from its use.
