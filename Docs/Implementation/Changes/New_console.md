# Implementation Plan: New Console (xterm.js + Symfony Process)

## Overview

### Problem

The current Codiware console is a minimal request/response shell:

- The front-end ([public/js/console/ConsolePanel.js](../../../public/js/console/ConsolePanel.js)) renders plain `<div>` lines into a scroll container. It has no ANSI color support, no real terminal semantics, and prints `[exit N]` after every command.
- The back-end ([Service/ConsoleService.php](../../../Service/ConsoleService.php)) runs each command **synchronously** with `Process::fromShellCommandline()` and returns the *entire* `stdout`/`stderr`/`exit_code` as one JSON payload via `POST /console/run`. Output only appears after the command has fully finished, so there is no line-by-line feedback and no indication that a command is still running.
- The Git panel ([public/js/git/GitPanel.js](../../../public/js/git/GitPanel.js)) calls dedicated `/git/*` REST endpoints directly. Those commands and their output **never appear in the console**, so users cannot see what Git actually did or why it failed.

### Goals

1. Rebuild the console panel on top of **xterm.js** (front-end) and **Symfony Process** (back-end) so output streams **line-by-line** and renders like a real OS terminal, including **ANSI colors**.
2. Work identically on **Windows and Linux**.
3. Automatically add `--color` to Git commands so output is colored even when Git would otherwise disable color for non-TTY pipes.
4. Keep the **deny-by-default allow-regex array** and **command presets** in config, but **inject** them into the console from the outside rather than hard-coding them.
5. **Do not** print the exit code as terminal text. Indicate *running* vs *finished* (and failed) through dedicated UI state.
6. Make the console the **central hub for all CLI command output** — output of anything typed by the user *or* triggered by the UI (Git panel today; Composer, npm, etc. later) becomes visible there. There are two ingestion paths:
   - **Streamed**: interactive/typed commands stream live via `POST /console/run` (Symfony Process + generator).
   - **Injected**: UI-triggered actions that need *structured* results keep their own JSON endpoint (e.g. `/git/*`) and embed the captured CLI output in the response; the calling panel **injects** that output block into the console for display.
   The console module must be **self-contained**: the Git panel depends on the console, but the console must not depend on the Git panel.

### Success criteria

- [ ] Running `git status` typed into the console streams output incrementally into the xterm terminal with correct colors.
- [ ] A long-running command shows a clear "running" indicator and can be stopped.
- [ ] No `[exit N]` line is printed; instead the prompt/status reflects success or failure.
- [ ] Works on both Windows (`cmd`/PowerShell host) and Linux (`/bin/sh`).
- [ ] Allowed-command regexes and presets continue to come from `CONSOLE.*` config and are passed into the console service/panel as constructor arguments — no console code references Git-specific config keys.
- [ ] Git-panel buttons keep calling the structured `/git/*` JSON endpoints; the CLI output embedded in those responses is **injected** into the console, and the panel auto-opens the console when a command fails.
- [ ] Git/CLI failures still log PHP exceptions server-side (unchanged) while the captured CLI output is surfaced to the user via the console.
- [ ] All existing command logs remain visible for the lifetime of the open editor session.
- [ ] Terminal output can be selected with the pointer and copied with Ctrl/Cmd+C or the shared right-click menu; the menu also offers Select all.
- [ ] Installs and runs after `composer install` with **no `npm install` / build step** (xterm is loaded from `vendor/npm-asset/xterm--xterm`).

### Who uses it

App designers and developers working inside the Codiware IDE (standalone and embedded in ExFace via `axenox/ide`). They run Git, Composer, npm, and other whitelisted CLI commands and need real-time, readable output.

---

## Technical Approach

### Architecture summary

```text
                 Front-end (SPA, vanilla JS)
 +-----------------------------------------------------------+
 |  ConsolePanel (xterm.js view + input + status)            |
 |    - owns xterm Terminal, FitAddon                        |
 |    - renders streamed chunks verbatim (ANSI preserved)    |
 |    - shows running/finished/failed state                  |
 |    - run(cmd, opts)   -> stream via /console/run          |
 |    - inject(block)    -> echo pre-run CLI output (git)    |
 |    - subscribes to bus 'console:run' / 'console:inject'   |
 +----------------------------+------------------------------+
                              | ConsoleClient (transport)
                              v
                 GET  /console/presets
                 POST /console/run     -> streams output (chunked body)
                 (stop = client aborts the /console/run request)
 +-----------------------------------------------------------+
 |  ConsoleController (HTTP)                                  |
 +----------------------------+------------------------------+
                              v
 |  ConsoleService                                           |
 |    - deny-by-default allow-pattern / preset policy        |
 |    - launches Symfony Process (incremental output)        |
 |    - normalizes commands (auto color for git)             |
 |    - cross-platform shell selection                       |
 |    - yields buffers via generator -> IteratorStream       |
 +-----------------------------------------------------------+
```

Key principle: **the console is a generic command-output hub.** It supports two ingestion paths:

- **Streamed** — typed/interactive commands run through the console's own `POST /console/run` (Symfony Process + generator), streaming live.
- **Injected** — other features (the Git panel today) keep their structured JSON endpoints and embed a `console` block describing the CLI they executed; the calling panel hands that block to the console via a public `inject()` method.

Either way, no `git`-specific knowledge lives in the console module. The Git panel depends on the console; the console never imports from `git/`.

#### Choosing `run` vs `inject`

Each consumer (the Git panel today; Composer, npm, etc. later) picks one of the two paths. The trade-off:

| Want | Use | How it behaves |
|---|---|---|
| Live line-by-line output, long-running or interactive feel, stoppable | **Streamed** `run` (`POST /console/run`) | Request stays open; output streams as the process produces it; "running" indicator; abort to stop. No structured result. |
| Structured/parsed JSON result + server-side PHP exception handling, output is secondary | **Injected** `inject` (own JSON endpoint + `console` block) | The endpoint runs the command to completion, returns parsed fields *and* the captured CLI output; the console echoes it once, after the AJAX call resolves. No live streaming. |

Notes:

- The two are **not mutually exclusive**: an extension may call a structured endpoint for the result *and* separately stream a related command, if useful.
- A streamed endpoint **cannot also** return a clean JSON envelope on the same request \u2014 streaming chunks and a single JSON body are incompatible. This is exactly why Git stays **injected**: it needs parsed status fields and PHP exception logging more than live output.
- Git buttons therefore wait for the whole command before showing output; typed/native console commands stream incrementally. This difference is expected and acceptable.

```text
 Git panel button ──► GET/POST /git/<op>  (GitController + GitService)
                         │  runs git via Symfony Process,
                         │  parses porcelain → structured fields,
                         │  logs PHP exceptions on failure,
                         │  captures raw CLI output
                         ▼
        JSON: { ...structured..., console: { command, output, exit_code, ok } }
                         │
  GitPanel ──────────────┘ reads structured fields for its UI
     │
     └─► console.inject(resp.console)   // echo the CLI block, auto-open on failure
```

### Streaming transport: reuse ExFace's proven model

The current `POST /console/run` returns one JSON blob. Line-by-line output requires incremental transport. **ExFace already solves this** in [WebConsoleFacade](../../../../../exface/core/Facades/WebConsoleFacade.php) and proves it works well end-to-end through the ExFace HTTP stack. We adopt the same mechanism rather than inventing SSE/polling:

- A PSR-7 response whose body is a **streaming `StreamInterface` backed by a PHP generator** — see ExFace's [IteratorStream](../../../../../exface/core/Facades/AbstractHttpFacade/IteratorStream.php). The generator `yield`s output buffers as they arrive; the PSR-7 stack reads the stream incrementally and flushes each chunk to the client.
- The generator drives a Symfony Process started with `Process::fromShellCommandline($cmd, $cwd, $envVars, null, $timeout)->start()` and iterates `foreach ($process as $type => $buffer)` to obtain incremental `Process::OUT` / `Process::ERR` chunks — exactly the pattern in ExFace's [CliCommandRunner::runCliCommand()](../../../../../exface/core/Facades/ConsoleFacade/CliCommandRunner.php). This already preserves ordering and handles the cross-platform shell.
- Content type `text/plain-stream` (as ExFace uses) plus the streaming setup ExFace applies (`set_time_limit(0)`, implicit flush, disabling `zlib.output_compression`, ending output buffering) so chunks are not buffered.

What we change vs. ExFace: replace the **jQuery.Terminal** front-end with **xterm.js**, and forward **raw ANSI bytes** instead of plain text (ExFace's runner emits plain text + a synthetic failure line). The back-end streaming contract stays conceptually identical to the one already validated in production.

Codiware-side implementation: Codiware ships its own small `StreamInterface`/generator (it must stay framework-neutral and not depend on `exface/core`), modeled on `IteratorStream` + `CliCommandRunner`, created via the PSR-17 factories already injected into the middleware. The front-end reads the streamed body with `fetch()` + a `ReadableStream` reader (or `XMLHttpRequest` progress), writing each chunk straight into xterm. An `AbortController` cancels the request (and, server-side, ends the generator → terminates the process).

> Process lifetime: the process is tied to the single open streaming request — simplest and self-cleaning, matching ExFace. No cross-request job store, temp files, or PID tracking are required. `/console/stop` is implemented by aborting the streaming request on the client; the server-side generator detects the closed connection and stops the process. (A job/polling fallback is only needed if a future host fully buffers responses — explicitly out of scope here since ExFace, the primary target, streams correctly.)

### Cross-platform execution

- Keep `Process::fromShellCommandline()` so users can use pipes/redirection within the allow-list (the regex allow-list remains the security boundary). Symfony Process already selects `cmd /V:ON /E:ON /D /C` on Windows and `/bin/sh -c` on Unix.
- Set a sane environment for color: pass `FORCE_COLOR=1` and (Unix) `TERM=xterm-256color` to the process env so tools that honor these emit ANSI codes.
- For Git specifically, **inject `-c color.ui=always`** (more reliable than `--color`, which not all subcommands accept) when the resolved command's first token is `git` and the user has not already forced a color flag. This is done in a small, replaceable command-normalizer hook so it stays generic (future Composer/npm normalizers can be added the same way).

### ANSI color and terminal rendering

- xterm.js renders raw bytes including ANSI escape sequences, so the back-end must **stop stripping output** and forward bytes verbatim.
- Front-end: load `xterm.js` + `xterm.css` from `vendor/npm-asset/xterm--xterm` (`lib/xterm.js`, `css/xterm.css`) using the existing `window.CODIWARE_BOOT.url_to_npm` base, mirroring how Monaco/Toast UI are loaded. Add the `FitAddon` if bundled; otherwise implement a minimal resize-to-fit.
  - The path in [Docs/Implementation/TODOs.md](../TODOs.md) (`npm-asssets/xterm--xterm`) is a typo; the real location is `vendor/npm-asset/xterm--xterm`.
- Do **not** print `[exit N]`. Instead:
  - While running: show a spinner/"running" badge in the panel header and a non-interactive prompt line.
  - On finish: write a trailing newline and restore the prompt; reflect non-zero exit via a subtle status (e.g. red prompt marker / header badge), not a printed exit-code line.

### Centralization & injection contract

Front-end:

- New `public/js/console/ConsoleClient.js` — transport only: `fetch()` streaming read of `/console/run`, `AbortController` for stop, `/console/presets`.
- Rework `public/js/console/ConsolePanel.js` — owns xterm + status; **no Git imports**. It exposes two public entry points:
  - `run(command, opts)` — submit to `/console/run` and stream live (for typed commands and future streaming consumers).
  - `inject(consoleBlock, opts)` — echo an already-executed CLI block (`{ command, output, exit_code, ok }`) returned by another endpoint, without running anything. Used by the Git panel.
- Both entry points are also reachable via the `bus`: `console:run` `{ command, label?, cwd?, autoOpen? }` and `console:inject` `{ command, output, exit_code, ok, label?, autoOpen? }`. On failure (or `autoOpen`), the panel auto-expands the bottom panel.
- Allowed patterns/presets are **not** read by the panel; the panel just submits commands and the back-end enforces policy. Presets are fetched generically via `/console/presets`.

Back-end:

- `ConsoleService` keeps receiving `allowPatterns`/`presets`/`timeout` from `CONSOLE.*` config (already does). No Git keys referenced.
- Add an injectable `CommandNormalizer` list (default includes a `GitColorNormalizer`) so command-family tweaks (git color, future composer/npm flags) are pluggable and the console core stays generic. Normalizers apply to streamed commands; `GitService` can reuse `GitColorNormalizer` so injected output is colored too.

The `console` block embedded by structured endpoints:

```json
{
  "console": {
    "command": "git -c color.ui=always push origin main",
    "output": "<raw stdout+stderr with ANSI codes>",
    "exit_code": 0,
    "ok": true
  }
}
```

Git panel integration:

- `GitPanel` keeps calling the structured `/git/*` JSON endpoints. For operations whose CLI output is worth showing (push, pull, fetch, clean, commit, checkout…), `GitController`/`GitService` capture the raw CLI output and add the `console` block to the existing JSON response.
- The panel renders its UI from the structured fields and calls `console.inject(resp.console)` (or emits `console:inject`) to surface the CLI output. On `ok === false`, the console auto-opens.
- **Server-side error handling is unchanged**: `GitService` still throws/logs PHP exceptions on hard failures (e.g. via the injected `LoggerInterface`); the `console` block additionally carries the human-readable CLI output so the user sees *why* it failed without parsing the terminal.
- The console module stays free of Git specifics; it only knows how to echo a generic `console` block.

---

## Implementation Plan

### Phase 1: Foundation — streaming back-end + xterm shell

**1.1 Codiware streaming primitives (Small).**
Port ExFace's proven streaming pieces into framework-neutral Codiware classes: an iterator-backed `StreamInterface` (mirroring [IteratorStream](../../../../../exface/core/Facades/AbstractHttpFacade/IteratorStream.php)) and the streaming HTTP setup (implicit flush, `set_time_limit(0)`, disable `zlib.output_compression`, end output buffering). Verify a trivial generator endpoint flushes incrementally in the standalone dev server and embedded in ExFace. *Dependency: none.*

**1.2 `ConsoleService` incremental execution (Medium).**
- Replace blocking `run()` with a generator that does `Process::fromShellCommandline($cmd, $cwd, $envVars, null, $timeout)->start()` and `foreach ($process as $type => $buffer) { yield $buffer; }`, modeled on [CliCommandRunner::runCliCommand()](../../../../../exface/core/Facades/ConsoleFacade/CliCommandRunner.php).
- Stop returning stripped, fully-buffered stdout/stderr; forward raw bytes (ANSI preserved), interleaving `Process::OUT`/`Process::ERR` in arrival order.
- Add process env: `FORCE_COLOR=1`, `TERM=xterm-256color`.
- Preserve the deny-by-default policy (`isAllowed`, presets trusted, regex allow-list) exactly as today.
- *Dependency: 1.1.*

**1.3 `CommandNormalizer` hook + `GitColorNormalizer` (Small).**
- Introduce a normalizer interface applied to the resolved command before execution.
- `GitColorNormalizer`: if first token is `git` and no explicit color flag present, inject `-c color.ui=always`.
- Wire normalizers into `ConsoleService` (config/DI), defaulting to `[GitColorNormalizer]`. *Dependency: 1.2.*

**1.4 HTTP endpoints (Small).**
- `POST /console/run`: validate/normalize, then return a streaming PSR-7 response (`text/plain-stream`) whose body is the `ConsoleService` generator stream.
- `POST /console/stop`: not a separate endpoint — stopping is the client aborting the streaming request; the server generator detects the closed connection and terminates the process.
- Keep `GET /console/presets`.
- Register routes in [Middleware/CodiwareMiddleware.php](../../../Middleware/CodiwareMiddleware.php) `registerRoutes()`. Update [Controller/ConsoleController.php](../../../Controller/ConsoleController.php). *Dependency: 1.2.*

**1.5 xterm front-end shell (Medium).**
- `ConsoleClient.js` transport: `POST /console/run` read via `fetch()` + `ReadableStream` reader, pushing chunks to a callback; `AbortController` to cancel (= stop). Plus `GET /console/presets`.
- Rebuild `ConsolePanel.js`: instantiate xterm `Terminal`, load `xterm.css`, fit-to-container, write streamed chunks verbatim (ANSI preserved), input line with history (Up/Down), running/finished/failed status in the header, **no exit-code line**. Implement both `run()` (stream) and `inject()` (echo a pre-executed `console` block). Terminal text selection uses xterm's logical selection; Ctrl/Cmd+C and a shared `PopupMenu` context menu copy it, with a hidden-textarea fallback for restricted iframe clipboard access. *Dependency: 1.4.*

### Phase 2: Core functionality — central hub + Git integration

**2.1 Console as bus-driven hub (Small).**
- `ConsolePanel` subscribes to `bus` `console:run` and `console:inject`; exposes public `run()` and `inject()`. Auto-expand bottom panel when `autoOpen` or on failure. *Dependency: 1.5.*

**2.2 Generic presets UX (Small).**
- Render presets from `/console/presets` into the input (insert, do not auto-run), per the Architecture spec. Keep preset source in `CONSOLE.PRESETS`. *Dependency: 1.5.*

**2.3 Git endpoints embed CLI output; panel injects it (Medium).**
- Back-end: in [Service/GitService.php](../../../Service/GitService.php), capture raw CLI output (and exit code) for user-visible operations (push, pull, fetch, clean, commit, checkout). Add a `console` block to the structured JSON returned by the relevant [Controller/GitController.php](../../../Controller/GitController.php) endpoints. Keep throwing/logging PHP exceptions on hard failures (unchanged).
  - Reuse `GitColorNormalizer` so the captured output is colored.
- Front-end: in [public/js/git/GitPanel.js](../../../public/js/git/GitPanel.js), keep reading structured fields for the UI; after each operation call `console.inject(resp.console)` (or emit `console:inject`). Open the console on `ok === false`.
- Keep structured `/git/status` and `/git/diff` purely structured (no console block needed unless useful).
- Ensure the console module has **zero** imports from `git/`. *Dependency: 2.1.*

**2.4 Command history & persistence (Small).**
- Keep the full command/output log for the lifetime of the open editor session (in-memory xterm buffer). Persist input history per workspace in `localStorage` (optional). *Dependency: 1.5.*

**2.5 Architecture validation for future extensions (Small).**
- Confirm a hypothetical Composer/npm consumer can either stream via `console:run` or embed a `console` block + `console:inject`, and add a `CommandNormalizer`, without touching console internals. Document the extension contract. *Dependency: 2.1, 1.3.*

### Phase 3: Polish, cross-platform, docs

**3.1 Cross-platform verification (Medium).**
- Manually verify streaming, colors, stop, and Git color injection on Windows and Linux. Confirm `Process::fromShellCommandline` shell selection and env vars behave on both. *Dependency: Phase 2.*

**3.2 Error handling & edge cases (Medium).**
- Denied commands (regex miss): clear terminal message, no process started.
- Timeout (`CONSOLE.TIMEOUT_SECONDS`): mark finished/failed, stop streaming.
- Stop mid-run (client abort): the streaming generator must detect the closed connection and terminate the process/children cleanly (no orphans).
- Output backpressure / very chatty commands: throttle writes to xterm.
- Disabled console (`CONSOLE.ENABLED=false`): hide/disable panel and reject API. *Dependency: 3.1.*

**3.3 Styling & theming (Small).**
- xterm theme bound to light/dark skin variables; scrollbar styling; header running/finished/failed badges; consistent with [Docs/Styleguide.md](../../Styleguide.md). *Dependency: 1.5.*

**3.4 Translations (Small).**
- Add/adjust `console.*` keys (run, stop, running, finished, failed, denied, placeholder) in `translations/`. *Dependency: 1.5.*

**3.5 Docs (Small).**
- Update [Docs/Architecture.md](../../Architecture.md) Console section (generator/`IteratorStream` streaming model, abort-to-stop, normalizers, the two ingestion paths `run`/`inject`, and the `console` block embedded by structured endpoints). Note the deviation from the existing `/console/stop` / `/console/output` endpoints listed there.
- Tick the relevant items in [Docs/Implementation/TODOs.md](../TODOs.md). *Dependency: all.*

---

## Considerations

### Assumptions

- `vendor/npm-asset/xterm--xterm` ships browser-ready `lib/xterm.js` + `css/xterm.css` and is served under `url_to_npm` (confirmed present; FitAddon availability to be verified, with a minimal fallback if absent).
- The deny-by-default allow-regex model is the security boundary and stays in `CONSOLE.ALLOW_PATTERNS`; presets in `CONSOLE.PRESETS`.
- Commands run with the host process's privileges/user; no new auth is introduced (consistent with package boundaries).

### Constraints

- **No build step** — xterm loaded as shipped vendor assets; vanilla JS modules only.
- Must run on **PHP 8.2+, Windows and Linux**.
- Must remain **framework-neutral**; ExFace specifics stay in `axenox/ide`. The console must not depend on the Git panel.
- PSR-7/PSR-15 middleware; streaming depends on the host not fully buffering the response body.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A future host fully buffers the PSR-7 body, breaking streaming | Low | ExFace (primary target) already streams via `IteratorStream`; if another host buffers, add a job+polling fallback behind the same `ConsoleClient` contract |
| Orphan process if the client aborts but the server keeps running | Medium | Generator detects the closed connection (write failure) and terminates the Symfony Process, matching ExFace's request-bound lifetime |
| Interleaving stdout/stderr loses ordering | Low/Medium | Use Symfony's combined process iterator (as `CliCommandRunner` does); accept best-effort ordering, document it |
| `--color`/`color.ui=always` breaks a Git subcommand that rejects the flag | Low | Inject via `-c color.ui=always` (global config form) rather than per-command `--color`; skip if user supplied a color flag |
| Browser module cache mixes old/new console submodules during deploy | Low | Follow existing bootstrap compatibility-guard pattern; cache-bust assets |
| Very chatty output floods xterm and stalls the UI | Medium | Throttle/batch writes; cap retained scrollback |
