# CloudIDE Architecture

## Overview

CloudIDE is a browser-based IDE delivered as a PSR-15 PHP middleware package. It replaces the Atheos integration in ExFace with a modern, extensible editor that supports type-specific editing (code, markdown WYSIWYG, image preview) and a proper Git workflow UI.

**Success criteria:**
- Installable with `composer require axenox/cloudide` and immediately usable — no build step, no custom server
- Works as a drop-in PSR-15 middleware in ExFace and any other PSR-7 application
- Feels like a modern IDE (VS Code / PHPStorm) in the browser
- Git panel covers the full daily workflow: diff, stage, commit, push, history, branches
- Skinnable via CSS files; ships with a light and a dark theme

---

## System Context

```
Browser ──HTTPS──► ExFace / any PSR-7 app
                        │
                   PSR-15 pipeline
                        │
                   IdeMiddleware  ◄── composer vendor/
                   (handles /api/ide/*)
                        │
              ┌─────────┴──────────┐
         PHP Services          Static assets
         (File, Git,          (JS/CSS in /public,
          Search)              served by middleware)
                        │
              ┌─────────┴──────────┐
         Local filesystem      git CLI
         (whitelisted paths)  (via symfony/process)
```

Authentication and session handling are delegated entirely to upstream middleware.

---

## Package Structure

```
cloudide/
├── composer.json
├── src/
│   ├── IdeMiddleware.php          # PSR-15 entry point
│   ├── IdeConfig.php              # Immutable value object
│   ├── Router.php                 # Maps URI patterns → controllers
│   ├── Controllers/
│   │   ├── ShellController.php    # Serves IDE HTML shell + assets
│   │   ├── FileController.php     # CRUD + upload/download
│   │   ├── GitController.php      # Git operations
│   │   ├── SearchController.php   # Global search/replace
│   │   └── ConfigController.php   # Read config + translations
│   ├── Services/
│   │   ├── FileSystemService.php  # Path safety + file ops
│   │   ├── GitService.php         # Wraps czproject/git-php
│   │   └── SearchService.php      # Recursive grep
│   └── Security/
│       └── PathGuard.php          # Whitelist + traversal protection
├── public/                        # Served verbatim by ShellController
│   ├── index.html
│   ├── js/
│   │   ├── app.js                 # Bootstrap, routing, tab manager
│   │   ├── editors/
│   │   │   ├── CodeEditor.js      # Monaco wrapper
│   │   │   ├── MarkdownEditor.js  # Toast UI wrapper
│   │   │   └── ImagePreview.js
│   │   ├── panels/
│   │   │   ├── FileTree.js        # jsTree wrapper
│   │   │   └── GitPanel.js        # Git side panel
│   │   └── api/
│   │       └── client.js          # Fetch-based API client
│   └── css/
│       ├── base.css
│       ├── theme-light.css
│       └── theme-dark.css
├── translations/
│   └── en.json
└── tests/
    ├── Unit/
    └── Integration/
```

---

## External Components

### PHP Back-end

| Component | Version | License | Purpose |
|---|---|---|---|
| `psr/http-server-middleware` | ^1.0 | MIT | PSR-15 interface (`MiddlewareInterface`) |
| `nyholm/psr7` | ^1.8 | MIT | Lightweight PSR-7 request/response factory; zero dependencies |
| `symfony/routing` | ^6.4 | MIT | Map URL patterns to controllers inside the middleware |
| `symfony/process` | ^6.4 | MIT | Spawn and communicate with `git` CLI processes safely |
| `czproject/git-php` | ^4.3 | MIT | High-level PHP wrapper around git CLI; returns structured data for status, log, branches, diff |
| `symfony/finder` | ^6.4 | MIT | Recursive directory iteration with filters, used by `SearchService` |
| `symfony/mime` | ^6.4 | MIT | Detect MIME type of uploaded files for safe content-type headers |
| `symfony/translation` | ^6.4 | MIT | Translation loading from `translations/*.json`; compatible with ExFace's existing translation setup |
| `psr/log` | ^1.0 \|\| ^2.0 | MIT | Logger interface; accepts Monolog v1 from ExFace via constructor injection |

> **Why not a full micro-framework?** Slim or Laravel/Lumen would work, but they add significant bootstrap overhead and conflicting dependency assumptions. Using individual Symfony components keeps the package lightweight and avoids version conflicts when installed alongside ExFace.

> **Why `czproject/git-php` over raw `symfony/process`?** It handles cross-platform quoting, parses structured output (status porcelain, log `--pretty=format`, branch lists), and lets `GitService` return typed PHP objects rather than parsing raw git output manually.

### JavaScript Front-end

All front-end libraries are declared as `npm-asset/` or `bower-asset/` dependencies in `composer.json` and installed by Composer via [asset-packagist.org](https://asset-packagist.org). The consuming project's `composer.json` must include the asset-packagist repository:

```json
{
    "repositories": [
        {
            "type": "composer",
            "url": "https://asset-packagist.org"
        }
    ]
}
```

This is already a standard requirement for ExFace installations. After `composer install`, packages land in `vendor/npm-asset/{name}/` and are exposed to the browser by `ShellController` under the `/api/ide/assets/vendor/` path. No CDN dependency is required at runtime; no separate `npm install` or build step is needed.

| Component | Composer package | Version | License | Purpose |
|---|---|---|---|---|
| **Monaco Editor** | `npm-asset/monaco-editor` | ^0.50 | MIT | Main code editor: syntax highlighting and autocomplete for PHP, JS, HTML, SQL, JSON. The same engine that powers VS Code. Ships as AMD modules; loaded via `loader.js` without a build step. |
| **Toast UI Editor** | `npm-asset/toast-ui__editor` | ^3.2 | MIT | WYSIWYG/split-mode markdown editor with GitHub Flavored Markdown (tables, task lists), built-in toolbar (headings, lists, links, code, tables) and a pluggable renderer. |
| **Mermaid** | `npm-asset/mermaid` | ^10 | MIT | Mermaid diagram rendering; integrated as a Toast UI Editor plugin so diagrams render live in the preview pane. |
| **jsTree** | `npm-asset/jstree` | ^3.3 | MIT | File tree component: lazy loading, drag-and-drop (move/copy), context menu, custom icons, persistent open/closed state via `localStorage`. |
| **Gitgraph.js** | `npm-asset/gitgraph__js` | ^1.4 | MIT | Visual git commit graph rendered on a `<canvas>`; used in the history view. |
| **Font Awesome 4** | `npm-asset/font-awesome` | 4.7.* | MIT (fonts) / OFL (icons) | Icon set; already included in ExFace. Used for toolbar and UI chrome icons. |
| **MDI SVG icons** | `npm-asset/mdi__svg` | — | Apache 2.0 | Supplementary SVG icons from Pictogrammers MDI library for Git-status badges and file-type icons in the tree. |

> **Why Monaco over CodeMirror 6?** The requirement is to "feel like VS Code." Monaco is the VS Code editor — it provides identical UX for multi-cursor, go-to-line, search/replace, intellisense affordances, and keyboard shortcuts that developers already know. CodeMirror 6 is lighter and more embeddable, but would require more custom work to reach the same level of polish. Monaco ships with its own AMD loader (`loader.js`) and can be used directly from `vendor/npm-asset/monaco-editor/` with no build step.

> **Why no diff2html?** Monaco includes a built-in `createDiffEditor()` that renders side-by-side or inline diffs with full syntax highlighting — already consistent with the rest of the editor. `GitController` exposes the old file content (via `git show HEAD:path`) and the new content separately; `GitPanel.js` feeds both into a Monaco diff editor instance. This avoids an extra dependency and leaves the door open for in-diff hunk discarding later.

> **Why Toast UI Editor over EasyMDE?** EasyMDE is a simple CodeMirror 5-based editor with no true WYSIWYG. Toast UI Editor provides a genuine WYSIWYG mode with a split preview, GitHub tables, and a rich plugin API that we need for the mermaid integration. Its toolbar is configurable to match the requirements exactly.

> **Why jsTree over a custom tree?** The requirement includes drag-to-move, ctrl-drag-to-copy, right-click context menu, and persistent open/closed state — all natively supported by jsTree. Building this from scratch would be significant effort for little gain.

---

## REST API

All routes are relative to the middleware mount point (default: `/api/ide`).

### Shell

| Method | Path | Description |
|---|---|---|
| `GET` | `/code/{alias}` | Serve the IDE HTML shell for the given app alias |
| `GET` | `/assets/*` | Static JS/CSS/font assets from `public/` |

### File System

| Method | Path | Description |
|---|---|---|
| `GET` | `/files?path=` | List directory contents (name, type, git-status badge) |
| `GET` | `/file?path=` | Read file content |
| `PUT` | `/file?path=` | Write file content |
| `POST` | `/file` | Create file or directory |
| `DELETE` | `/file?path=` | Delete file or directory |
| `GET` | `/download?path=` | Download file; directories streamed as `.zip` |
| `POST` | `/upload?path=` | Upload one or more files (multipart); zipped folders are extracted |

### Git

| Method | Path | Description |
|---|---|---|
| `GET` | `/git/status?root=` | Working tree status (changed, staged, untracked) |
| `GET` | `/git/diff?path=&staged=` | Returns `{ old: "...", new: "..." }` — the full content of the file at HEAD (or index when `staged=true`) and in the working tree; consumed by Monaco's diff editor |
| `POST` | `/git/stage` | Stage file(s) |
| `POST` | `/git/unstage` | Unstage file(s) |
| `POST` | `/git/discard` | Discard changes to file(s) |
| `POST` | `/git/commit` | Commit staged changes (message, author name+email) |
| `POST` | `/git/amend` | Amend the last commit |
| `POST` | `/git/push` | Push current branch |
| `GET` | `/git/log?root=&limit=&skip=` | Commit history (hash, author, date, message, files) |
| `GET` | `/git/branches?root=` | Local and remote branches + ahead/behind |
| `POST` | `/git/checkout` | Switch branch or create new branch |

### Search

| Method | Path | Description |
|---|---|---|
| `GET` | `/search?q=&path=&pattern=` | Search string in files; returns matches with line context |
| `POST` | `/search/replace` | Replace in matched files (dry-run + apply modes) |

### Config & I18n

| Method | Path | Description |
|---|---|---|
| `GET` | `/config` | Current IDE configuration as JSON |
| `GET` | `/translations/{lang}` | Translation strings for the given language |

---

## Security Architecture

Because authentication is handled upstream, the IDE's own security responsibility is **path isolation** and **input validation**.

### Path Guard

`PathGuard` is the single authority on whether a file path is accessible:

1. **Whitelist:** The middleware is initialised with one or more allowed base directories. Every request parameter containing a path is resolved to an absolute, real path and checked against this whitelist.
2. **Traversal prevention:** Symlinks are resolved (`realpath()`), then the result must start with the whitelisted base — preventing `../../etc/passwd` attacks.
3. **Blocked names:** Entries like `.env`, `*.key`, and directories outside the git repo root are rejected by configurable deny-patterns.

### Git Command Safety

Git operations are invoked via `czproject/git-php` and `symfony/process`, never via shell string interpolation. All arguments are passed as array elements to `Process`, which escapes them properly on both Windows and Linux.

### Upload Validation

- MIME type is detected server-side via `symfony/mime`; the client-supplied `Content-Type` is ignored.
- Zip extraction is guarded: all entries in the archive are checked against `PathGuard` before extraction to prevent zip-slip attacks.
- Maximum upload size is configurable.

### Output Headers

File downloads set `Content-Type` from the server-detected MIME type and `Content-Disposition: attachment` to prevent browser execution of served content.

---

## Front-end Architecture

The front-end is a **single-page application in plain ES6 JavaScript** — no framework, no compilation. It is structured as a set of modules loaded via native ES modules (`<script type="module">`).

```
app.js
 ├── TabManager          – opens/closes/restores tabs (persisted in localStorage)
 ├── EditorRegistry      – maps file extensions to editor classes
 │    ├── CodeEditor      – wraps Monaco
 │    ├── MarkdownEditor  – wraps Toast UI Editor
 │    └── ImagePreview    – <img> + zoom
 ├── FileTree            – wraps jsTree; emits "open-file" events
 ├── GitPanel            – side panel; polls /git/status; opens Monaco diff editor for file diffs, renders Gitgraph for history
 ├── SearchPanel         – global search overlay
 └── ApiClient           – centralised fetch wrapper with CSRF header and error handling
```

### Tab persistence

Open tabs (file paths + cursor positions) are serialised to `localStorage` under a key derived from the base app alias. On startup, `TabManager` restores them automatically.

### Theming

The colour scheme is defined entirely in CSS custom properties (`--ide-bg`, `--ide-fg`, `--ide-accent`, etc.). `theme-light.css` and `theme-dark.css` override these properties. An external skin file can override any subset of them. A `prefers-color-scheme` media query selects the default; a toggle in the toolbar overrides it and stores the preference in `localStorage`.

### Responsiveness

The layout uses CSS Grid with named areas: `[tree] [editor] [git-panel]`. On narrow viewports (`< 768 px`) the tree and git panel are hidden; the editor occupies the full screen. A hamburger menu gives access to the hidden panels as slide-over drawers.

---

## Configuration

Configuration is stored in `ide-config.json` (default location resolvable relative to the middleware mount). The middleware constructor accepts an optional path to override this.

```json
{
  "theme": "light",
  "allowed_paths": [],
  "max_upload_bytes": 52428800,
  "git": {
    "default_author_name": "",
    "default_author_email": ""
  },
  "editor": {
    "tab_size": 4,
    "word_wrap": false
  }
}
```

User-specific settings (author name/email, theme preference, tab states) are stored in `localStorage` in the browser, not on the server, so that multiple users on the same installation do not interfere with each other.

---

## Translations

Translation files are JSON objects at `translations/{lang}.json`:

```json
{
  "file_tree.new_file": "New file",
  "git.commit_btn": "Commit",
  "git.no_changes": "No changes"
}
```

The back-end uses `symfony/translation` with the `JsonFileLoader` to load these files and expose them via `GET /translations/{lang}`. The front-end fetches the bundle on startup and stores it in a simple `i18n.t('key')` helper. This format is compatible with ExFace's existing translation infrastructure.

---

## Testing Strategy

### Back-end

| Layer | Tool | Approach |
|---|---|---|
| Unit | **PHPUnit 10** | Test `PathGuard`, `SearchService`, response formatting logic in isolation using `vfsStream` (virtual filesystem) to avoid touching real files. |
| Integration / API | **PHPUnit + `nyholm/psr7`** | Bootstrap `IdeMiddleware` with a temp directory, send real PSR-7 requests, assert on PSR-7 responses. Covers file CRUD, search, Git API endpoints. Use a real git repo fixture in `tests/fixtures/git-repo/`. |
| Git operations | **PHPUnit** | Run against a local fixture git repository; assert on structured output from `GitService`. |

### Front-end

| Layer | Tool | Approach |
|---|---|---|
| Component tests | **Jest + jsdom** | Unit test `TabManager`, `ApiClient`, `PathGuard` (path normalisation utilities mirrored in JS). |
| End-to-end | **Playwright** | Spin up the PHP middleware via `symfony/process` in a `beforeAll` hook; drive a real browser. Cover: open app, edit file, save, open git panel, stage + commit, global search. |

> **Rationale:** PHPUnit integration tests cover the API contract reliably with no browser overhead. Playwright E2E tests are few but high-value, focusing on the user-facing workflows that span both layers.

---

## Standalone Mode (for development and testing)

The IDE can be run without any host framework using the minimal built-in entry point `public/dev-server.php`. This is the recommended way to develop and test the IDE itself.

### Setup

1. Clone or `composer install` the package into any directory.
2. Start PHP's built-in web server from the package root:

```bash
php -S localhost:8080 public/dev-server.php
```

3. Open `http://localhost:8080` in a browser.

### What `dev-server.php` does

```php
<?php
// public/dev-server.php

require_once __DIR__ . '/../vendor/autoload.php';

use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;
use CloudIde\IdeMiddleware;
use CloudIde\IdeConfig;

$factory  = new Psr17Factory();
$request  = (new ServerRequestCreator($factory, $factory, $factory, $factory))
                ->fromGlobals();

// Allow access to the package's own root directory only
$config = new IdeConfig([
    'allowed_paths' => [realpath(__DIR__ . '/../')],
]);

$middleware = new IdeMiddleware($config);

// No authentication — every request is passed straight through
$response = $middleware->process($request, new class implements \Psr\Http\Server\RequestHandlerInterface {
    public function handle(\Psr\Http\Message\ServerRequestInterface $r): \Psr\Http\Message\ResponseInterface {
        return (new \Nyholm\Psr7\Factory\Psr17Factory())->createResponse(404);
    }
});

http_response_code($response->getStatusCode());
foreach ($response->getHeaders() as $name => $values) {
    foreach ($values as $value) {
        header("$name: $value", false);
    }
}
echo $response->getBody();
```

### Behaviour in standalone mode

| Concern | Behaviour |
|---|---|
| Authentication | None — every request is accepted unconditionally |
| Authorisation | `PathGuard` limits all file and git operations to the single whitelisted path (the package root) |
| User identity for git commits | Falls back to the values in `ide-config.json` (`git.default_author_name` / `git.default_author_email`); the user is prompted to fill these in on first commit |
| Sessions / tab persistence | Handled entirely in `localStorage` — no server-side session required |
| Logging | Defaults to a `NullLogger`; pass any `Psr\Log\LoggerInterface` to the `IdeMiddleware` constructor to enable output |

This is also the setup used by the Playwright end-to-end tests (see *Testing Strategy*).

---

## ExFace Integration

The `axenox/ide` package (separate repo) integrates CloudIDE into ExFace by:

1. **Registering the middleware** in ExFace's PSR-15 pipeline for the `/api/ide/*` URL prefix.
2. **Injecting the ExFace logger** (Monolog v1) into `IdeMiddleware` via constructor.
3. **Populating `allowed_paths`** from ExFace's app registry: the list of `vendor/{vendor}/{app}` directories for installed apps.
4. **Passing the active user** (from ExFace's security context) into the middleware so the Git author name/email can be pre-filled from the user profile.
5. **Embedding the IDE** in an `<iframe>` inside the ExFace shell, passing a `?skin=jEasyUI` query parameter that causes the IDE to load `theme-jEasyUI.css` for consistent branding.
