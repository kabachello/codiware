# Codiware Editor Architecture

## Overview

Codiware Editor is a browser-based PHP/JS IDE delivered as a Composer package and exposed through one configurable middleware mounted below a single URL prefix, `codiware/` by default. It is designed to replace the current Atheos-based ExFace IDE integration while remaining usable in any PSR-7/PSR-15 PHP application.

The package itself owns only IDE concerns: static assets, file operations, Git operations, search, configurable command execution, translations, and client state bootstrapping. Authentication, user sessions, ExFace app selection, and host application routing remain outside this package.

**Success criteria**

- Installable with Composer and immediately usable without `npm install`, bundling, compilation, or a custom server.
- Mounted in any host application as one middleware that handles only the configured `codiware/*` URL prefix and passes all other requests onward.
- Initial IDE entry always uses a `repo/{path}` URL, where the path resolves to an allowed workspace root.
- Works on PHP 8.2+ on Windows and Linux.
- Provides a modern IDE layout with type-specific editors, tab restoration, file tree, Git side panel, bottom search and console panels, toast notifications, skins, translations, and dark mode.
- Keeps ExFace integration in the separate `axenox/ide` package; this package remains framework-neutral.

## System Context

```text
Browser iframe or standalone tab
        |
        | HTTPS
        v
Host PHP application
        |
        | PSR-15 pipeline using PSR-7 messages
        v
CodiwareMiddleware
  handles configured base path only, for example:
  - /codiware/* in standalone hosts
  - /api/ide/codiware/* in ExFace
        |
        +-- Static asset server
        +-- JSON API controllers
        +-- Workspace resolver and path guard
        |
        +-- Local filesystem under whitelisted roots
        +-- Git CLI through symfony/process
        +-- Optional host logger implementing Psr\Log\LoggerInterface
```

The middleware returns IDE responses for matching paths and delegates all non-matching paths to the next handler. This keeps Codiware compatible with applications that already have their own controllers, middleware, sessions, and security model.

## Package Boundaries

### Codiware Package

The Codiware Composer package provides:

- PSR middleware entry point and internal routing.
- Static HTML, CSS, JavaScript, skins, icons, and vendor browser assets.
- File tree, file read/write, upload, download, move, copy, delete, and zip extraction APIs.
- Git status, diff, staging, commit, amend, branch, push, discard, and history APIs.
- Global search and replace APIs.
- Configured command console APIs.
- JSON translations.
- Standalone development entry point for local testing.

The package does not provide:

- Authentication, authorization, or user management.
- Persistent server-side sessions.
- ExFace-specific page registration, iframe embedding, app lookup, or user profile lookup.
- A Node-based front-end build pipeline.

### ExFace Integration Package

The separate `axenox/ide` package integrates Codiware into ExFace by:

- Registering the middleware below `/api/ide/codiware/`.
- Resolving ExFace app package directories under `vendor/` and passing them as allowed workspace roots.
- Passing the ExFace logger, active user display name, and active user email into the middleware.
- Embedding the IDE in an iframe inside the ExFace UI.
- Selecting an ExFace skin file such as a jEasyUI-compatible skin.

## Technical Approach

### Middleware and Routing

The main entry point is `CodiwareMiddleware`. It implements `Psr\Http\Server\MiddlewareInterface` and operates on PSR-7 request/response objects. Constructor arguments provide host-controlled integration points:

```php
new CodiwareMiddleware(
    config: CodiwareConfig::fromFile($configPath),
    responseFactory: $psr17Factory,
    streamFactory: $psr17Factory,
    logger: $logger,
    userContext: new UserContext($committerName, $committerEmail),
    basePath: '/api/ide/codiware'
);
```

Internal routing is intentionally small and local to the mounted base path. `symfony/routing` can be used, but a compact route table is also acceptable because all routes are JSON or static-asset endpoints.

The middleware normalizes the mount path before matching. A deployment mounted at `/api/ide/codiware/` exposes the same logical routes as standalone `/codiware/`; API responses include resolved base URLs so the front-end never hard-codes the host path.

### Workspace Resolution

The required entry URL is:

```text
GET {basePath}/repo/{workspacePath...}
```

`workspacePath` is interpreted by `WorkspaceResolver`:

- In the default integrated setup, it is a path relative to the configured base folder, usually `vendor/`.
- In standalone mode, it must match one of the configured whitelisted paths or aliases.
- It may contain nested vendor package paths, for example `repo/exface/core` or `repo/axenox/my-app`.
- It resolves to exactly one initial workspace root.

The resolved workspace id becomes the namespace for local browser state: opened tabs, panel sizes, tree expansion, added secondary roots, editor preferences, and selected theme.

Future multi-root support uses the same resolver. The initial `repo/{workspacePath}` remains the primary workspace; optional secondary roots can be added from the allowed root menu and persisted per primary workspace.

### Back-end Services

```text
src/
  CodiwareMiddleware.php
  Config/
    CodiwareConfig.php
    ConfigLoader.php
    UserContext.php
  Http/
    Router.php
    JsonResponder.php
    ErrorResponder.php
    StaticAssetResponder.php
  Controller/
    ShellController.php
    AssetController.php
    FileController.php
    GitController.php
    SearchController.php
    ConsoleController.php
    ConfigController.php
  Workspace/
    WorkspaceResolver.php
    WorkspaceState.php
    PathGuard.php
  Service/
    FileService.php
    UploadService.php
    DownloadService.php
    GitService.php
    SearchService.php
    ConsoleService.php
    TranslationService.php
public/
  index.html
  js/
  css/
  skins/
translations/
  en.json
tests/
```

`PathGuard` is the single authority for filesystem safety. All file paths, Git paths, search paths, uploads, downloads, and console working directories pass through it before touching the filesystem.

### Dependencies

#### PHP

| Package | Version | Purpose |
|---|---:|---|
| `psr/http-message` | ^1.1 \| ^2.0 | PSR-7 messages |
| `psr/http-server-middleware` | ^1.0 | Middleware interface |
| `psr/http-server-handler` | ^1.0 | Next handler interface |
| `psr/http-factory` | ^1.0 | Response and stream creation |
| `psr/log` | ^1.1 \| ^2.0 \| ^3.0 | Logger compatibility, including Monolog v1 hosts |
| `symfony/process` | ^6.4 | Cross-platform Git and configured command execution |
| `symfony/finder` | ^6.4 | Recursive file listing and search traversal |
| `symfony/mime` | ^6.4 | MIME detection for downloads and uploads |
| `symfony/translation` | ^6.4 | JSON translation loading |
| `symfony/routing` | ^6.4 | Optional internal route matching |

Git operations should use `symfony/process` directly with argument arrays. This keeps command construction explicit, avoids shell interpolation, and supports both Windows and Linux. Small parser classes should convert porcelain output, branch output, and log output into typed arrays for the API.

#### Front-end

All browser dependencies must be available through Composer, either shipped in this package or installed through Asset Packagist. Runtime CDN loading is avoided.

| Component | License | Purpose |
|---|---|---|
| Monaco Editor | MIT | Code editor, diff editor, search/replace, line numbers, go to line, wrapping, JSON/JS/HTML/CSS/SQL support, extensible PHP tokenization/autocomplete |
| Toast UI Editor | MIT | Markdown WYSIWYG and split preview, toolbar, GitHub-flavored markdown tables |
| Mermaid | MIT | Markdown diagram rendering |
| jsTree | MIT | Lazy file tree, context menu, drag move/copy, persisted open branches |
| Gitgraph.js or lightweight custom canvas renderer | MIT | Git history graph |
| Font Awesome 4 | MIT/OFL | Default icon set compatible with ExFace |
| MDI SVG icons | Apache 2.0 | Supplemental file, Git, and panel icons |

Monaco is loaded through its AMD loader directly from served vendor assets. The asset controller must support Monaco worker URLs and cache headers so the editor works without a build step.

## Web API

All routes are relative to the configured base path, shown here as `/codiware`.

### Shell and Assets

| Method | Path | Description |
|---|---|---|
| `GET` | `/repo/{workspacePath...}` | Required IDE entry point. Resolves workspace, serves SPA shell, injects boot config. |
| `GET` | `/assets/{assetPath...}` | Serves Codiware static files and approved vendor browser assets. |

### Configuration and Translations

| Method | Path | Description |
|---|---|---|
| `GET` | `/config` | Returns effective configuration, current user context, base URL, workspace metadata, skin options, command presets, and feature flags. |
| `GET` | `/translations/{locale}` | Returns JSON translation object. |

### Files

| Method | Path | Description |
|---|---|---|
| `GET` | `/files/tree?root=&path=` | Lists directory entries with type, size, modified time, opened marker, and Git decoration when available. |
| `GET` | `/files/read?root=&path=` | Reads text file content with detected encoding and MIME. |
| `PUT` | `/files/write` | Writes text content and returns updated metadata. |
| `POST` | `/files/create` | Creates file or directory. |
| `POST` | `/files/move` | Moves or renames file/directory. |
| `POST` | `/files/copy` | Copies file/directory, used by ctrl-drag in the tree. |
| `DELETE` | `/files/delete?root=&path=` | Deletes file or directory. |
| `GET` | `/files/download?root=&path=` | Downloads a file or streams a folder as zip. |
| `POST` | `/files/upload?root=&path=` | Uploads one or more files. Zip uploads can be extracted with subfolders. |

### Git

Git endpoints are enabled only when the selected root is inside a Git repository. The Git panel is permanently visible for Git roots and hidden or disabled for non-Git roots.

| Method | Path | Description |
|---|---|---|
| `GET` | `/git/status?root=` | Changed, staged, untracked, conflicted files; branch; ahead/behind counters. |
| `GET` | `/git/diff?root=&path=&staged=` | Returns old/new content and diff metadata for Monaco diff editor. |
| `POST` | `/git/discard` | Discards one or more files. Later supports optional hunk-level discard. |
| `POST` | `/git/stage` | Stages one or more files. |
| `POST` | `/git/unstage` | Unstages one or more files. |
| `POST` | `/git/commit` | Commits staged changes with message and configured author name/email. |
| `POST` | `/git/amend` | Amends the last commit. |
| `POST` | `/git/push` | Pushes the current branch. |
| `GET` | `/git/branches?root=` | Lists local/remote branches and current branch. |
| `POST` | `/git/checkout` | Checks out an existing branch or creates a new branch. |
| `GET` | `/git/history?root=&limit=&after=` | Returns commit list with files changed and graph metadata. |
| `GET` | `/git/show?root=&commit=&path=` | Returns a file at a commit for history diffs. |

For future multi-root workspaces, the Git panel should show one repository selector per Git-enabled root. The primary workspace root is selected by default; roots outside Git repositories are omitted from the selector.

### Search

| Method | Path | Description |
|---|---|---|
| `GET` | `/search?root=&path=&pattern=&q=&regex=&caseSensitive=` | Searches all allowed files under a root/path. Returns grouped findings with line and preview context. |
| `POST` | `/search/replace/preview` | Calculates replacements without writing files. |
| `POST` | `/search/replace` | Applies replacements to all or selected findings. |

The search panel stays open while files are opened from results. Opening a result focuses the main editor at the matching line.

### Console

| Method | Path | Description |
|---|---|---|
| `GET` | `/console/presets` | Returns configured command presets. |
| `POST` | `/console/run` | Runs an allowed command in an allowed root/path and streams or polls output. |
| `POST` | `/console/stop` | Stops a running command process when supported. |

Console commands are denied by default. A command is allowed only when it matches a configured allow-pattern or exactly matches a configured preset. Presets are inserted into the front-end console input but are not executed automatically, so users can edit them before submitting.

Recommended default Git presets:

- `git status --short --branch`
- `git clean -nd`
- `git clean -fd`
- `git fetch --all --prune`
- `git log --oneline --graph --decorate --max-count=30`
- `git remote -v`

## Front-end Architecture

The front-end is a plain JavaScript SPA using native modules where practical and vendor loaders only where required by a component such as Monaco. It is optimized for iframe embedding but also works as a full browser page.

The UI follows the [styleguide](Styleguide.md). 

### Folder structure

```text
public/js/
  app.js
  core/
    ApiClient.js
    EventBus.js
    I18n.js
    StateStore.js
    Toasts.js
  layout/
    LayoutManager.js
    PanelManager.js
    Splitter.js
  editors/
    EditorRegistry.js
    CodeEditor.js
    MarkdownEditor.js
    ImageEditor.js
    DiffEditor.js
  files/
    FileTree.js
    FileActions.js
    UploadDropZone.js
  git/
    GitPanel.js
    GitStatusList.js
    GitHistory.js
  search/
    SearchPanel.js
  console/
    ConsolePanel.js
```

### Layout

The first screen is the IDE itself, not a landing page.

- Center: tabbed editor area.
- Left side panel: file browser, resizable and collapsible.
- Right side panel: Git panel, resizable and collapsible. Future AI chat uses another tab in this panel.
- Bottom panel: console and search tabs, resizable and collapsible.
- Toast region: colored success, info, warning, and error messages.

Panel sizes, collapsed state, active bottom tab, and active side-panel tabs are persisted per workspace in `localStorage`.

### Editor Registry

`EditorRegistry` maps file type detection to editor implementations:

- Code editor for PHP, JavaScript, HTML, SQL, JSON, CSS, XML, YAML, and unknown text files.
- Markdown WYSIWYG editor for `.md` and `.markdown` with split preview, Mermaid rendering, GitHub tables, headings, lists, links, code blocks, and inline code toolbar buttons.
- Image preview/editor for common image formats with zoom, fit-to-screen, download, and future crop/resize extension points.

All editor tabs show unsaved state, restore from the previous browser session, and expose the absolute resolved path in a hover tooltip over the tab title. Text editors support search/replace within the file and word-wrap toggle. Code editors show line numbers and support go-to-line shortcuts.

### Extensibility Model

Codiware should be extensible at two levels: library-level plugins for existing editor components and full editor modules for new file types. Both extension types are loaded from configuration and registered during SPA bootstrap, before files are opened.

#### Extension Manifest

Every optional front-end extension is described by a small JSON manifest. The manifest can live in the Codiware package, in a Composer dependency, or in a host package such as `axenox/ide`.

```json
{
  "id": "vendor.diagram-editor",
  "label": "Diagram editor",
  "assets": {
    "js": ["assets/extensions/vendor.diagram-editor/editor.js"],
    "css": ["assets/extensions/vendor.diagram-editor/editor.css"]
  },
  "editors": [
    {
      "id": "diagram",
      "extensions": [".diagram", ".drawio"],
      "mime_types": ["application/vnd.codiware.diagram+json"],
      "factory": "CodiwareExtensions.DiagramEditor.create",
      "priority": 100
    }
  ],
  "plugins": [
    {
      "target": "markdown",
      "factory": "CodiwareExtensions.TuiChartPlugin.create",
      "options": {}
    }
  ]
}
```

The back-end exposes enabled manifests through `/config`. The asset controller serves manifest assets only from approved package asset roots, so adding an extension does not require a front-end build step or direct public access to arbitrary files.

#### Library Plugins

Built-in editors expose adapter-specific plugin hooks instead of leaking their implementation details across the app. This makes it easy to install existing plugins for libraries like Toast UI Editor while keeping the rest of Codiware independent from those libraries.

- `MarkdownEditor` accepts configured Toast UI plugins, toolbar extensions, custom renderers, syntax highlighters, and preview hooks.
- `CodeEditor` accepts Monaco language registrations, completion providers, hover providers, themes, actions, and keybindings.
- `ImageEditor` accepts toolbar actions, metadata panels, transformations, and alternate renderers.
- `GitHistory` and `DiffEditor` can accept render or action plugins later, but they should remain internal until a real extension need appears.

A plugin receives only a narrow context object:

```js
{
  api,
  i18n,
  toasts,
  workspace,
  editorConfig,
  libraryInstance
}
```

For a Toast UI plugin, the adapter translates manifest entries into the plugin format expected by Toast UI:

```js
MarkdownEditor.registerPlugin({
  id: 'vendor.tui-color-syntax',
  create(context, options) {
    return window.CodiwareExtensions.TuiColorSyntax.create(context.libraryInstance, options);
  }
});
```

This allows existing Toast UI plugins to be wrapped with a few lines of glue code while preserving Codiware's own lifecycle, translations, theme variables, and error handling.

#### Custom Editors

New file-type editors implement a common editor contract and register with `EditorRegistry`. The contract is intentionally small:

```js
{
  id,
  canOpen(file),
  create(container, context),
  load(document),
  getValue(),
  isDirty(),
  save(),
  focus(),
  dispose()
}
```

Optional capabilities are declared separately so the shell can enable matching UI without hard-coding editor types:

- `searchInFile`
- `replaceInFile`
- `wordWrap`
- `goToLine`
- `binaryRead`
- `customSavePayload`
- `diffable`
- `previewOnly`

Examples:

- A specialized diagram editor can register for `.erd`, `.diagram`, or `.drawio` files, load JSON or XML through `/files/read`, render an interactive canvas, and save the serialized model through `/files/write`.
- An image editor can register for image MIME types, load binary content through an object URL from `/files/download`, and save transformed image data through a dedicated upload/write endpoint.
- A WYSIWYG HTML editor can register for `.html` files with a higher priority than `CodeEditor`, while still offering a command to reopen the same file as plain code.

When multiple editors match a file, `EditorRegistry` picks the highest-priority editor and exposes an "Open With" menu listing all compatible editors. The selected editor can be remembered per file extension and workspace.

#### Back-end Support for Editor Extensions

Most editor extensions use existing file endpoints. Specialized editors may declare extra API requirements in their manifest, but those routes must be provided by PHP classes registered through the middleware configuration. The core router can mount extension controllers below:

```text
{basePath}/extensions/{extensionId}/{route...}
```

Extension controllers receive the same `WorkspaceResolver`, `PathGuard`, logger, and user context as built-in controllers. This keeps custom diagram/image processing inside the same security model as normal file operations.

#### Compatibility Rules

- Extensions must be optional. The IDE must still start if an extension is disabled.
- Extension load failures are reported as toast errors and logged, but they must not prevent unrelated editors from loading.
- Extension assets must be local Composer-installed assets; CDN-only plugins are not acceptable for the default package.
- Extensions should use CSS variables from the active skin and avoid hard-coded colors where possible.
- Extension APIs must be versioned by manifest schema and extension id, so future Codiware releases can reject incompatible extensions with a clear message.

### Git UI

The Git side panel shows changed files by default and includes a quick filter. A changed file opens a Monaco diff editor in the main editor area. Diff actions support file-level discard initially; the API and UI should leave room for hunk-level discard later.

The panel includes staging controls, commit/amend controls, ahead/behind counters, push, branch checkout/create, and history. The history view should show commit graph, metadata, changed files, and optional diff-to-previous behavior.

### File Tree

The file tree supports:

- Lazy loading.
- Clear indication of opened files.
- Persisted expanded/collapsed branches per workspace.
- Right-click context menu for create, rename, delete, copy, move, upload, download, and reveal actions.
- Drag-to-move and ctrl-drag-to-copy.
- Drag-and-drop upload for files and zip archives with subfolders.

### Responsiveness

Desktop and tablet layouts show side panels and bottom panels. On narrow mobile screens, the editor becomes full-screen and secondary features move into slide-over panels or bottom tabs. Mobile support is intentionally practical rather than feature-equal: editing remains usable, while complex Git/history/search workflows may require opening panels one at a time.

### Theming and Skins

Base styling uses CSS custom properties in `public/css/base.css`. Built-in files include:

- `theme-light.css`
- `theme-dark.css`
- `skins/exface-jeasyui.css`
- `skins/openui5-horizon.css`

The host can select a skin in configuration or by boot metadata. Dark mode can be automatic through `prefers-color-scheme` or explicitly selected by the user and persisted in `localStorage`.

## Configuration

Global configuration is stored in JSON. Package defaults are shipped in `config/defaults.config.json`. The middleware accepts an optional config path or prebuilt config object. Host packages may merge their own configuration before constructing the middleware.

Config keys are normalized to uppercase. Nested JSON objects are flattened to dot notation (for example, `CONSOLE.ENABLED`) while arrays and arrays of objects remain as-is.

```json
{
  "BASE_PATH": "/codiware",
  "BASE_FOLDER": "vendor",
  "ALLOWED_ROOTS": [
    {
      "alias": "exface/core",
      "path": "exface/core",
      "label": "ExFace Core"
    }
  ],
  "DENY_PATTERNS": [
    ".env",
    "*.key",
    "*.pem",
    "vendor/*/*/.git/config"
  ],
  "MAX_UPLOAD_BYTES": 52428800,
  "THEME.DEFAULT": "light",
  "THEME.ALLOW_USER_OVERRIDE": true,
  "THEME.SKIN": null,
  "GIT.ENABLED": true,
  "GIT.AUTHOR_NAME": null,
  "GIT.AUTHOR_EMAIL": null,
  "GIT.DEFAULT_HISTORY_LIMIT": 100,
  "CONSOLE.ENABLED": true,
  "CONSOLE.TIMEOUT_SECONDS": 300,
  "CONSOLE.ALLOW_PATTERNS": [
    "^git\\s+(status|log|diff|show|clean|fetch|remote|branch|checkout|merge|rebase)\\b"
  ],
  "CONSOLE.PRESETS": [
    {
      "label": "Git status",
      "command": "git status --short --branch"
    },
    {
      "label": "Dry-run clean",
      "command": "git clean -nd"
    }
  ],
  "EDITOR.TAB_SIZE": 4,
  "EDITOR.WORD_WRAP": false,
  "FILE_ICONS.DEFAULT": "fa fa-file-o",
  "FILE_ICONS.FOLDER": "fa fa-folder",
  "FILE_ICONS.FOLDER_OPEN": "fa fa-folder-open",
  "FILE_ICONS.BY_NAME": {
    "composer.json": "fa fa-cube",
    ".gitignore": "fa fa-code-fork"
  },
  "FILE_ICONS.BY_EXT": {
    "php": "fa fa-code",
    "json": "fa fa-database",
    "md": "fa fa-file-text-o",
    "png": "fa fa-file-image-o"
  },
  "EXTENSIONS.ENABLED": [
    "codiware.markdown-mermaid",
    "codiware.image-basic"
  ],
  "EXTENSIONS.MANIFESTS": [
    "extensions/*.json",
    "../axenox/ide/codiware-extensions/*.json"
  ],
  "TRANSLATIONS.DEFAULT_LOCALE": "en"
}
```

Per-user state stays in the browser because the Codiware package does not own user sessions. The storage key includes package version, base path, workspace id, and root id to avoid collisions between iframes or host installations.

## Security Architecture

Authentication and application-level authorization are delegated to the host. Codiware still enforces strict local safety boundaries.

### Path Isolation

`PathGuard` resolves every requested path to an absolute canonical path and verifies that it is below one configured allowed root. It rejects traversal, unsafe symlink escapes, blocked names, denied patterns, and operations outside the active workspace.

Zip extraction uses the same guard for every archive entry before writing to disk to prevent zip-slip attacks.

### Git Safety

Git operations are executed without shell interpolation. Commands are built as argument arrays for `symfony/process`. File paths passed to Git are first resolved relative to the active repository root and rejected if they escape the repository.

Destructive operations such as discard, clean presets, delete, overwrite upload, and replace-in-files require explicit front-end confirmation and return structured details about affected paths.

### Console Safety

The console is intentionally narrower than a terminal:

- Working directory must be an allowed root or allowed subpath.
- Submitted command text must match an allow-pattern or an exact preset.
- Presets are considered allowed but are never auto-executed by the UI.
- Environment variables are inherited from the PHP process only when configured.
- Output size and runtime are capped.
- Commands with `../` are allowed only when the full command matches a configured pattern and the final working directory/path checks pass through `PathGuard`.

### Uploads and Downloads

- Server-side MIME detection is used for content type decisions.
- Downloads use `Content-Disposition: attachment` by default.
- Upload size limits are configurable.
- Existing-file overwrite behavior is explicit.
- Binary files are not read through text endpoints.

## Error Handling and Logging

All controllers return a consistent JSON error shape for API failures:

```json
{
  "error": {
    "code": "path_denied",
    "message": "The selected path is outside the allowed workspace.",
    "details": {}
  }
}
```

The front-end displays recoverable API errors as colored toast messages. Server exceptions are passed to the configured logger as throwables in the log context under the `exception` key:

```php
$logger->error($message, ['exception' => $throwable]);
```

If an error happens before the middleware can reliably render JSON or HTML, the throwable may be rethrown to the outer middleware pipeline.

## Translations

Translation files are JSON objects in `translations/{locale}.json` and remain compatible with ExFace translation conventions.

```json
{
  "file.new": "New file",
  "git.commit": "Commit",
  "console.run": "Run"
}
```

The initial release ships English only. The architecture assumes additional locale files can be added without changing code.

## Future Extension Points

- Additional editor types can register through `EditorRegistry` without changing tab management, file tree behavior, or tab persistence.
- Existing front-end library plugins can be wrapped through adapter hooks, for example Toast UI Editor plugins for markdown, Monaco providers for code editing, and toolbar/action plugins for image editing.
- AI chat can be added as another right-panel tab and can exchange proposed text changes through a diff editor with accept/reject actions.
- Multi-root workspaces can be enabled by adding root selection APIs and extending file/search/git requests with the existing `root` parameter.
- HTML WYSIWYG, ER diagram, diagramming, and advanced image editors can be added as manifest-driven editor modules and asset dependencies.
- Hunk-level Git discard and apply can extend the existing diff endpoint with patch ranges.

## Testing Strategy

### Back-end

| Layer | Tool | Coverage |
|---|---|---|
| Unit | PHPUnit 10 or 11 | `PathGuard`, `WorkspaceResolver`, config merge, command allow-list checks, Git output parsers, JSON responders. |
| API integration | PHPUnit with PSR-7 factories | Middleware requests against temporary workspaces for file CRUD, upload/download, search, Git status/diff/stage/commit, config, translations, and errors. |
| Git fixtures | Real temporary Git repositories | Cross-platform verification for Windows and Linux command execution. |

### Front-end

| Layer | Tool | Coverage |
|---|---|---|
| Browser unit tests | Vitest or Jest with jsdom | State store, API client, editor registry, path display helpers, search result grouping. |
| End-to-end | Playwright | Open `repo/` URL, restore tabs, edit/save file, use markdown split preview, upload/download, search result navigation, stage/commit, branch/history basics, console allow/deny behavior. |

Because the shipped package has no build step, browser tests should run against the same files that Composer installs. A minimal development front controller may use PHP's built-in server for local and CI execution, but production use still depends only on host middleware registration.

## Implementation Plan

**Phase 1: Foundation**

- Build Composer package skeleton, middleware entry point, config loader, route matching, static asset serving, JSON responder, and logger integration. Complexity: Medium.
- Implement workspace resolution for `repo/{workspacePath}` and path isolation through `PathGuard`. Complexity: Large.
- Add basic shell UI with resizable layout, config bootstrap, extension manifest loading, translations, and toasts. Complexity: Medium.

**Phase 2: Core Editing**

- Implement file tree, file APIs, text read/write, tab management, tab restoration, and opened-file indicators. Complexity: Large.
- Add `EditorRegistry`, editor lifecycle contract, Monaco code editor, Markdown editor with Mermaid, and image preview. Complexity: Large.
- Add adapter hooks for front-end library plugins, starting with Toast UI Editor plugins and Monaco language/completion providers. Complexity: Medium.
- Add upload, download, zip handling, drag move/copy, and context menus. Complexity: Large.

**Phase 3: Git, Search, and Console**

- Implement Git service and panel for status, diff, stage, unstage, commit, amend, push, branches, ahead/behind, and history. Complexity: Large.
- Implement global search, replace preview, selected replace, and result navigation without closing the search panel. Complexity: Medium.
- Implement configured console presets, command allow-listing, execution, output display, and cancellation. Complexity: Medium.

**Phase 4: Integration Readiness and Hardening**

- Add skins for light, dark, jEasyUI-like, and OpenUI5 Horizon-like appearances. Complexity: Medium.
- Add ExFace integration documentation for `axenox/ide`. Complexity: Small.
- Add automated back-end and Playwright coverage for the critical workflows. Complexity: Large.
- Verify Windows and Linux behavior for filesystem paths, Git commands, zip handling, and process execution. Complexity: Medium.

## Considerations

**Assumptions**

- Host applications authenticate users and decide whether a user may open the IDE at all.
- Git is installed and available in the PHP process environment for Git features.
- Composer can install PHP and browser asset dependencies, including Asset Packagist packages where used.
- Browser `localStorage` is acceptable for per-user IDE state, including tabs and committer preferences.

**Constraints**

- No Node build step can be required for installation or runtime.
- The package must tolerate being installed next to older ExFace dependencies, including Monolog v1.
- All filesystem and process behavior must work on Windows and Linux.
- The front-end may be embedded in an iframe and must avoid assumptions about being top-level.

**Risks**

- Monaco can be awkward without bundling. Mitigation: load the official AMD distribution and explicitly test worker asset routes early.
- Git command parsing can drift across Git versions and locales. Mitigation: use porcelain formats and controlled pretty formats wherever possible.
- Console execution is powerful. Mitigation: deny by default, require allow-patterns or exact presets, cap output/runtime, and log all command executions.
- Multi-root workspaces can complicate Git UI. Mitigation: keep all APIs root-scoped from the start and default the Git panel to one selected repository.
