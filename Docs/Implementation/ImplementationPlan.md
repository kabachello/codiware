# Codiware Editor Implementation Plan

## Overview

Codiware Editor is a Composer-installed PHP cloud IDE exposed through a single configurable PSR middleware. It must be usable immediately after Composer installation, work inside ExFace through `axenox/ide`, and also run in standalone PSR-7/PSR-15 hosts.

The implementation should prioritize a thin, secure PHP middleware core and a plain JavaScript SPA that can load editor libraries, skins, and extensions without a Node build step.

**Done means:**

- `GET {basePath}/repo/{workspacePath}` opens a working IDE for an allowed workspace root.
- File browsing, editing, saving, upload, download, search, Git workflow, and configured console commands work on Windows and Linux.
- The Git panel supports status, diff, stage, commit, amend, push, branches, ahead/behind, and history for Git roots.
- Markdown, code, and image files open in suitable editor implementations, and new editors/plugins can be added through extension manifests.
- Errors are shown as toasts where possible and logged with `['exception' => $throwable]` when a logger is provided.
- Automated tests cover core PHP services, middleware APIs, and the highest-value browser workflows.

## Technical Approach

The project should be built in vertical slices, starting with the middleware and workspace safety model, then adding the shell UI, file editing, Git, search, console, extensibility, skins, and integration readiness.

Core principles:

- Keep host concerns outside the package: authentication, user management, sessions, and ExFace page registration are external.
- Treat `PathGuard` as the mandatory gate for every filesystem, Git, search, upload, download, and console operation.
- Avoid shell interpolation. Use `symfony/process` with argument arrays for Git and configured commands.
- Serve all front-end assets through the same middleware base path.
- Use Composer-installed assets and browser-native loading. Do not require `npm install` or a build step.
- Make extension loading manifest-driven from the start, even if only built-in extensions exist initially.

## Implementation Plan

### Phase 1: Package Foundation

Goal: establish the Composer package, middleware entry point, configuration model, and local development loop.

1. **Create Composer package skeleton**  
   Complexity: Small  
   Dependencies: none  
   Tasks:
   - Add `composer.json` with PHP 8.2 requirement, PSR interfaces, Symfony components, autoloading, and dev test dependencies.
   - Define namespace and directory layout for `src/`, `public/`, `translations/`, and `tests/`.
   - Add `.gitignore` and minimal package README if not already present.

2. **Implement middleware entry point**  
   Complexity: Medium  
   Dependencies: step 1  
   Tasks:
   - Create `CodiwareMiddleware` implementing `Psr\Http\Server\MiddlewareInterface`.
   - Accept config, PSR-17 response/stream factories, optional logger, optional user context, and configurable base path.
   - Delegate non-matching paths to the next request handler.
   - Normalize base paths such as `/codiware`, `/codiware/`, and `/api/ide/codiware/`.

3. **Add internal routing and response helpers**  
   Complexity: Medium  
   Dependencies: step 2  
   Tasks:
   - Add a small internal router or `symfony/routing` integration.
   - Implement `JsonResponder`, `ErrorResponder`, and `StaticAssetResponder`.
   - Standardize JSON success and error envelopes.
   - Ensure exceptions are logged with `['exception' => $throwable]`.

4. **Implement configuration loading**  
   Complexity: Medium  
   Dependencies: step 2  
   Tasks:
   - Add immutable `CodiwareConfig`, `ConfigLoader`, and `UserContext` classes.
   - Support defaults plus optional JSON config path or host-provided config array.
   - Include base path, base folder, allowed roots, deny patterns, upload limits, Git settings, console settings, theme, translations, and extensions.
   - Validate config early and return clear startup errors.

5. **Add standalone development front controller**  
   Complexity: Small  
   Dependencies: steps 2-4  
   Tasks:
   - Add a small dev front controller for PHP's built-in server.
   - Allow opening a whitelisted local workspace through `/codiware/repo/{path}`.
   - Keep this as a development and test helper, not a production server requirement.

**Phase 1 validation:**

- PHPUnit unit tests for config loading, base path matching, and error responses.
- Manual request check that matching paths are handled and non-matching paths delegate.
- `git diff --check` and PHP syntax checks for new PHP files.

### Phase 2: Workspace and Security Core

Goal: make workspace resolution and path safety reliable before adding feature endpoints.

1. **Implement workspace resolution**  
   Complexity: Large  
   Dependencies: Phase 1  
   Tasks:
   - Add `WorkspaceResolver` for `repo/{workspacePath}` URLs.
   - Resolve paths relative to the configured base folder, usually `vendor/`.
   - Support standalone allowed aliases and absolute allowed roots from config.
   - Produce stable workspace ids for browser state keys.

2. **Implement `PathGuard`**  
   Complexity: Large  
   Dependencies: step 1  
   Tasks:
   - Canonicalize requested paths and reject traversal.
   - Resolve symlinks safely and reject escapes from allowed roots.
   - Apply deny patterns such as `.env`, `*.key`, `*.pem`, and sensitive Git config paths.
   - Provide helpers for file paths, directory paths, Git-relative paths, upload targets, download targets, and console working directories.

3. **Add boot shell route**  
   Complexity: Medium  
   Dependencies: steps 1-2  
   Tasks:
   - Implement `GET /repo/{workspacePath...}`.
   - Serve the SPA shell and inject or expose boot metadata: base URL, workspace id, root metadata, user context, theme, enabled features, translations locale, and extension manifests.

4. **Add config and translations routes**  
   Complexity: Small  
   Dependencies: steps 1-3  
   Tasks:
   - Implement `GET /config`.
   - Implement `GET /translations/{locale}` using JSON translation files.
   - Return English translations first, with structure ready for additional locales.

**Phase 2 validation:**

- Unit tests for allowed roots, denied paths, symlink escapes, traversal attempts, and workspace ids.
- Middleware integration tests for `/repo`, `/config`, and `/translations`.
- Windows and Linux path separator cases covered in tests.

### Phase 3: SPA Shell and Layout

Goal: deliver the first visible IDE frame with persistent layout and reliable API communication.

1. **Create static asset serving**  
   Complexity: Medium  
   Dependencies: Phase 2  
   Tasks:
   - Serve `public/index.html`, CSS, JS, skins, icons, and approved vendor assets under `/assets`.
   - Add cache headers for immutable vendor assets and conservative headers for app files during development.
   - Support Monaco worker asset paths.

2. **Build SPA bootstrap**  
   Complexity: Medium  
   Dependencies: step 1  
   Tasks:
   - Add `app.js`, `ApiClient`, `EventBus`, `I18n`, `StateStore`, and `Toasts`.
   - Load config, translations, and enabled extension manifests before initializing panels.
   - Route API calls relative to the base URL returned by the back-end.

3. **Implement IDE layout**  
   Complexity: Medium  
   Dependencies: step 2  
   Tasks:
   - Add center editor area, left file panel, right Git/future AI panel, bottom console/search panel, and toast region.
   - Add resizable splitters and collapsible panels.
   - Persist panel size, collapsed state, and selected panel tabs per workspace.

4. **Add theming and skins foundation**  
   Complexity: Medium  
   Dependencies: step 3  
   Tasks:
   - Define CSS custom properties in `base.css`.
   - Add light and dark themes.
   - Add initial jEasyUI-like and OpenUI5 Horizon-like skin files.
   - Persist user theme preference in browser state.

**Phase 3 validation:**

- Browser smoke test opens `/repo/{workspacePath}` and renders non-empty panels.
- Layout state survives reload.
- No broken asset requests for CSS, JS, icons, vendor files, or Monaco worker URLs.

### Phase 4: File Tree and File Operations

Goal: provide safe file browsing and filesystem operations.

1. **Implement file service APIs**  
   Complexity: Large  
   Dependencies: Phase 2  
   Tasks:
   - Implement tree listing, text read, text write, create, move, copy, delete, download, and upload endpoints.
   - Detect binary files and avoid exposing them through text read endpoints.
   - Stream folders as zip files for downloads.
   - Extract zip uploads only after validating every archive entry through `PathGuard`.

2. **Build file tree UI**  
   Complexity: Large  
   Dependencies: Phase 3 and step 1  
   Tasks:
   - Integrate jsTree or equivalent Composer-installed asset.
   - Add lazy loading, file icons, opened-file indicators, and persisted expanded branches.
   - Add context menu actions for create, rename, delete, copy, move, upload, download, and reveal.

3. **Add drag-and-drop behavior**  
   Complexity: Medium  
   Dependencies: step 2  
   Tasks:
   - Support drag-to-move and ctrl-drag-to-copy inside the tree.
   - Support drag-and-drop upload for files and zip archives.
   - Confirm destructive overwrites.

**Phase 4 validation:**

- API integration tests for every file operation, including denied paths and zip-slip attempts.
- Browser tests for opening folders, context menu operations, drag upload, and download.

### Phase 5: Editor Framework and Core Editors

Goal: implement tabbed editing, editor selection, persistence, and the first editor set.

1. **Implement tab manager and editor lifecycle**  
   Complexity: Large  
   Dependencies: Phase 3  
   Tasks:
   - Add tab open, close, dirty-state, save, focus, and restore behavior.
   - Persist open tabs, active tab, cursor positions, and selected editor per workspace.
   - Show absolute file path on tab hover.
   - Warn before closing dirty tabs.

2. **Implement `EditorRegistry`**  
   Complexity: Medium  
   Dependencies: step 1  
   Tasks:
   - Add file matching by extension, MIME type, and priority.
   - Add `Open With` when multiple editors match.
   - Support capability flags such as `searchInFile`, `replaceInFile`, `wordWrap`, `goToLine`, `binaryRead`, `customSavePayload`, `diffable`, and `previewOnly`.

3. **Add Monaco code editor**  
   Complexity: Large  
   Dependencies: steps 1-2  
   Tasks:
   - Load Monaco through its AMD loader without a build step.
   - Support PHP, JavaScript, HTML, SQL, JSON, CSS, XML, YAML, and unknown text files.
   - Add line numbers, search/replace, word wrap toggle, go-to-line shortcut, dirty tracking, and save integration.
   - Add initial autocomplete based on currently open files and workspace symbols where practical.

4. **Add Markdown editor**  
   Complexity: Large  
   Dependencies: steps 1-2  
   Tasks:
   - Integrate Toast UI Editor.
   - Enable WYSIWYG and split preview mode.
   - Add GitHub-flavored markdown tables and Mermaid diagram rendering.
   - Configure toolbar icons for headings, ordered and unordered lists, tables, links, code blocks, and inline code.

5. **Add image preview/editor**  
   Complexity: Medium  
   Dependencies: steps 1-2 and file download endpoint  
   Tasks:
   - Open common image formats through object URLs.
   - Add zoom, fit-to-screen, metadata display, and download.
   - Leave explicit extension points for crop/resize tools.

**Phase 5 validation:**

- Browser tests for opening code, markdown, and image files.
- Tests for dirty state, save, reload restore, word wrap, go-to-line, markdown preview, and Mermaid rendering.

### Phase 6: Extension System

Goal: make Codiware easy to extend with existing library plugins and new file-type editors.

1. **Implement extension manifest loading**  
   Complexity: Medium  
   Dependencies: Phase 3  
   Tasks:
   - Load enabled extension manifests from configured manifest paths.
   - Validate manifest schema, extension ids, asset lists, editor registrations, plugin registrations, and optional back-end routes.
   - Expose enabled manifests through `/config`.

2. **Serve extension assets safely**  
   Complexity: Medium  
   Dependencies: step 1  
   Tasks:
   - Allow extension JS/CSS only from approved Composer-installed roots.
   - Load extension assets before editor registration.
   - Report failed extension assets as toasts without breaking unrelated editors.

3. **Add library plugin adapters**  
   Complexity: Medium  
   Dependencies: Phase 5 and step 1  
   Tasks:
   - Add Toast UI plugin wrapper support for markdown plugins.
   - Add Monaco provider registration hooks for languages, completions, hovers, themes, actions, and keybindings.
   - Add image editor toolbar/action plugin hooks.

4. **Add custom editor registration**  
   Complexity: Medium  
   Dependencies: Phase 5 and step 1  
   Tasks:
   - Let manifests register editor factories with extensions, MIME types, priority, and capabilities.
   - Support specialized diagram editors, advanced image editors, and WYSIWYG HTML editors.
   - Add extension-specific API route mounting under `/extensions/{extensionId}/{route...}` with the same workspace and path guard services.

**Phase 6 validation:**

- Unit tests for manifest validation and extension route registration.
- Browser tests with a fixture extension that registers a fake editor and a fake Toast UI plugin.
- Failure tests for missing assets, invalid factories, incompatible manifest versions, and disabled extensions.

### Phase 7: Git Workflow

Goal: provide a daily-use Git UI that is always visible for Git roots.

1. **Implement Git service**  
   Complexity: Large  
   Dependencies: Phase 2  
   Tasks:
   - Use `symfony/process` with argument arrays.
   - Parse status porcelain, branch, ahead/behind, diff, log, file show, and changed-file output.
   - Scope all file paths to the active repository root.

2. **Implement Git APIs**  
   Complexity: Large  
   Dependencies: step 1  
   Tasks:
   - Add status, diff, stage, unstage, discard, commit, amend, push, branches, checkout, history, and show endpoints.
   - Use constructor-provided committer name/email or browser-provided per-user settings where allowed.
   - Return structured errors for conflicts, missing Git, detached HEAD, and rejected pushes.

3. **Build Git side panel**  
   Complexity: Large  
   Dependencies: Phase 3 and step 2  
   Tasks:
   - Show changed files by default with a quick filter.
   - Show staged and unstaged groups.
   - Add stage, unstage, discard, commit, amend, push, branch, and history controls.
   - Show ahead/behind counters.
   - Hide or disable panel when the selected root is not a Git repository.

4. **Add diff and history UI**  
   Complexity: Large  
   Dependencies: Phase 5 and step 2  
   Tasks:
   - Use Monaco diff editor for changed files.
   - Support file-level discard from diff view.
   - Add history list or graph with changed files and diff-to-previous behavior.
   - Leave room for hunk-level discard later.

**Phase 7 validation:**

- API tests against temporary real Git repositories.
- Browser tests for status, diff, stage, commit, amend, branch list, history, and push failure handling.
- Manual Windows and Linux checks for Git executable discovery and path quoting.

### Phase 8: Search and Replace

Goal: support global search and safe replacement workflows.

1. **Implement search service and API**  
   Complexity: Medium  
   Dependencies: Phase 2 and Phase 4  
   Tasks:
   - Search all files or a selected path/pattern.
   - Support plain text first, then optional regex and case-sensitive mode.
   - Return grouped file results with line numbers and preview context.
   - Skip denied paths and binary files.

2. **Implement replace preview and apply**  
   Complexity: Medium  
   Dependencies: step 1  
   Tasks:
   - Add dry-run replacement endpoint.
   - Apply replacements to all or selected findings.
   - Re-check files before writing to reduce stale-result mistakes.

3. **Build search panel**  
   Complexity: Medium  
   Dependencies: Phase 3 and step 1  
   Tasks:
   - Add bottom-panel search UI.
   - Keep the search panel open when opening results.
   - Focus the main editor at the selected finding line.
   - Add replace preview and selected replace UI.

**Phase 8 validation:**

- API tests for plain search, regex search, path patterns, denied files, preview replace, and selected replace.
- Browser tests for result navigation without closing the search panel.

### Phase 9: Console

Goal: provide a constrained web console for Git and configured commands.

1. **Implement console command policy**  
   Complexity: Medium  
   Dependencies: Phase 2 and config model  
   Tasks:
   - Deny commands by default.
   - Allow exact configured presets.
   - Allow commands matching configured regex patterns.
   - Permit `../` only when the complete command matches policy and final paths pass `PathGuard`.

2. **Implement console execution API**  
   Complexity: Medium  
   Dependencies: step 1  
   Tasks:
   - Add preset listing, run, and stop endpoints.
   - Execute through `symfony/process` with runtime and output limits.
   - Log command execution metadata without logging secrets.
   - Return incremental or pollable output.

3. **Build console panel UI**  
   Complexity: Medium  
   Dependencies: Phase 3 and step 2  
   Tasks:
   - Add command input, output area, stop action, and preset menu.
   - Insert presets into the input without auto-running them.
   - Add default Git presets such as status, dry-run clean, clean, fetch, log graph, and remotes.

**Phase 9 validation:**

- Unit tests for allow-pattern decisions.
- API tests for allowed, denied, preset, timeout, and stopped commands.
- Browser tests confirming presets are inserted but not auto-executed.

### Phase 10: Integration Readiness, Hardening, and Release

Goal: make the package ready for ExFace integration and early real-world use.

1. **Polish error handling and logging**  
   Complexity: Medium  
   Dependencies: all feature phases  
   Tasks:
   - Review every API for consistent JSON errors.
   - Show recoverable failures as colored toast messages.
   - Rethrow only errors that cannot be rendered safely.

2. **Finish responsive behavior**  
   Complexity: Medium  
   Dependencies: Phase 3 and feature panels  
   Tasks:
   - Make editor full-screen on mobile.
   - Move file, Git, search, and console features into drawers or stacked panels on narrow screens.
   - Test inside an iframe.

3. **Document ExFace integration contract**  
   Complexity: Small  
   Dependencies: Phase 1 and Phase 2  
   Tasks:
   - Document middleware registration for `/api/ide/codiware/`.
   - Document passing allowed app package roots, logger, user context, and skin selection from `axenox/ide`.
   - Document iframe constraints and same-origin assumptions.

4. **Complete automated test suite**  
   Complexity: Large  
   Dependencies: all feature phases  
   Tasks:
   - Add PHPUnit unit and integration coverage.
   - Add Playwright end-to-end workflows.
   - Run tests on Windows and Linux in CI where possible.

5. **Prepare release checklist**  
   Complexity: Medium  
   Dependencies: all feature phases  
   Tasks:
   - Verify Composer install from scratch.
   - Verify no Node build step is required.
   - Verify licenses for all front-end assets are permissive and documented.
   - Verify Asset Packagist dependencies or bundled assets resolve correctly.
   - Verify default config is safe.

**Phase 10 validation:**

- Fresh Composer install opens a workspace through `/codiware/repo/{path}`.
- Full PHPUnit and Playwright suites pass.
- Manual smoke test in an ExFace iframe through `axenox/ide` integration prototype.

## Dependencies and Sequencing

- Phases 1 and 2 are blocking foundations for all feature work.
- Phase 3 can start once the shell route and asset serving exist.
- Phase 4 and Phase 5 should be developed together because file operations and editor tabs depend on each other.
- Phase 6 should begin before all advanced editors are needed, so extension design does not become an afterthought.
- Phase 7 depends on file APIs and Monaco diff support but can be developed before search and console.
- Phase 8 and Phase 9 are independent after the workspace, path guard, and layout are stable.
- Phase 10 runs throughout the project, but final release checks happen after all major features are integrated.

## Testing Plan

### Back-end Tests

- Use PHPUnit for unit and integration tests.
- Use temporary directories and real temporary Git repositories for file and Git behavior.
- Cover Windows-specific path separators and drive-letter cases where possible.
- Prioritize tests for `PathGuard`, `WorkspaceResolver`, config loading, console allow-listing, Git output parsing, zip extraction, and middleware API responses.

### Front-end Tests

- Use lightweight browser unit tests for state stores, API client behavior, editor registry matching, extension manifest handling, and search result grouping.
- Use Playwright for workflow coverage because the critical behavior spans PHP APIs, browser state, and real editor components.
- Keep Playwright scenarios focused: open workspace, open/save file, restore tabs, markdown preview, image preview, search navigation, Git stage/commit, console allow/deny, and extension fixture load.

### Manual Cross-platform Checks

- Windows: path normalization, Git process calls, zip upload/download, image paths, console working directories.
- Linux: symlink escape prevention, file permissions, Git process calls, zip upload/download.
- Browser: current Chrome, Edge, Firefox; no legacy browser support required.
- Iframe: ExFace-like iframe embedding with selected skin and same-origin asset loading.

## Considerations

**Assumptions**

- The host authenticates users and decides whether they may access Codiware.
- Git is installed on systems where Git features are expected.
- Composer can install all required PHP and browser assets.
- `localStorage` is acceptable for per-user UI state and tab persistence.
- ExFace integration will be implemented in `axenox/ide`, not in the Codiware package.

**Constraints**

- No installation or runtime step may require Node, npm, Vite, Webpack, or a custom server.
- The same base path must serve shell, assets, and APIs.
- The middleware must coexist with unrelated host routes.
- The package must work with host loggers compatible with Monolog v1 through `psr/log`.
- All filesystem and process behavior must be safe on Windows and Linux.

**Risks and Mitigations**

- Monaco without bundling may be brittle. Mitigation: prove loader and worker asset paths in Phase 3 before building too much UI around it.
- Git parsing can vary by version or locale. Mitigation: use porcelain and explicit pretty formats, and test with real repos.
- Console commands can be dangerous. Mitigation: deny by default, require exact presets or allow-pattern matches, cap runtime/output, and keep confirmations for destructive commands.
- Extension APIs can sprawl. Mitigation: keep the editor contract small, manifest-driven, and versioned.
- Large file operations can affect server memory. Mitigation: stream downloads, cap uploads, skip binary text reads, and consider size limits for editor loading.

## Suggested Milestones

1. **Milestone A: Bootable package**  
   Phases 1-3 complete. A workspace opens with layout, config, translations, toasts, assets, and skins.

2. **Milestone B: Usable file editor**  
   Phases 4-5 complete. Users can browse, open, edit, save, upload, download, and restore tabs for code, markdown, and images.

3. **Milestone C: Extensible editor platform**  
   Phase 6 complete. Existing library plugins and new file-type editors can be added through manifests.

4. **Milestone D: Developer workflow IDE**  
   Phases 7-9 complete. Git, search/replace, and console workflows are usable.

5. **Milestone E: Integration-ready release**  
   Phase 10 complete. Tests, documentation, skins, cross-platform checks, and ExFace integration contract are ready.