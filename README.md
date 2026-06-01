# Codiware

A self-contained, embeddable web IDE delivered as a single PSR-15 middleware
plus a dependency-free SPA. Codiware is designed to be mounted under an
arbitrary base path inside any PHP host application (e.g. the ExFace
workbench) and operate on a configurable set of workspace folders.

## Features

- File tree, multi-tab editor, save / rename / delete / upload / download
- Pluggable editor registry (textarea fallback included; Monaco, CodeMirror,
  Toast UI, etc. can be plugged in via npm-asset packages or custom JS)
- Git source-control panel (status, stage / unstage / discard, commit, amend,
  push, branches, history) over the local `git` CLI
- Workspace-wide search and search-and-replace with regex / case options
- In-IDE console with a deny-by-default allowlist + operator-curated presets
- Light/dark themes via CSS custom properties; per-locale translations
- All paths protected by a single `PathGuard` that rejects traversal, symlink
  escape, and matches configurable deny patterns (`.env`, `*.key`, …)

## Requirements

- PHP **8.2+**
- Composer
- Optional: a local `git` binary for the source-control panel

## Install

```bash
composer require axenox/codiware
```

The package depends on `npm-asset/*` packages for optional front-end editors.
The `composer.json` already enables [Asset Packagist](https://asset-packagist.org)
so `npm-asset/monaco-editor` and friends can be installed alongside PHP
packages.

## Mount in a host

```php
use Codiware\CodiwareMiddleware;
use Codiware\Config\CodiwareConfig;
use Codiware\Config\UserContext;

$middleware = new CodiwareMiddleware(
    config: CodiwareConfig::fromFile(__DIR__ . '/codiware.json'),
    responseFactory: $psr17,
    streamFactory: $psr17,
    logger: $psrLogger,
    userContext: new UserContext($user->getName(), $user->getEmail(), $user->getId())
);
```

`CodiwareMiddleware` implements `Psr\Http\Server\MiddlewareInterface`. Any
request whose URI path is **not** under the configured base path is delegated
unchanged to the next handler.

### Workspace URL

`GET {basePath}/repo/{workspacePath...}` returns the SPA shell with a boot
payload describing the requested workspace, user, theme, locale, and enabled
extensions. All subsequent API calls go to other `{basePath}/...` routes.

## Configuration

Defaults are shipped in `config/defaults.config.json`.

At runtime, `CodiwareConfig` behaves like ExFace config maps:

- keys are normalized to uppercase
- nested objects are flattened to dot keys (`CONSOLE.ENABLED`)
- arrays and arrays of objects stay as values (`CONSOLE.PRESETS`)

See `dev-server.config.json.example` for a documented sample.

Typical host override patterns:

```php
$config = CodiwareConfig::fromFile(__DIR__ . '/codiware.json')
  ->set('BASE_PATH', '/api/ide/codiware')
  ->merge([
    'THEME.DEFAULT' => 'dark',
    'CONSOLE.TIMEOUT_SECONDS' => 120,
  ]);
```

Key options:

| Key | Purpose |
| --- | --- |
| `BASE_PATH` | URL prefix the middleware listens on (default `/codiware`). |
| `BASE_FOLDER` | Folder whose direct children are valid workspace aliases. |
| `ALLOWED_ROOTS` | Explicit `[{alias, path, label}]` list overriding `BASE_FOLDER`. |
| `DENY_PATTERNS` | `fnmatch` patterns rejected by `PathGuard`. |
| `MAX_UPLOAD_BYTES` | Per-file upload limit. |
| `GIT.BINARY` | Path to the `git` executable. |
| `CONSOLE.ALLOW_PATTERNS` | Regex allowlist for raw console commands. |
| `CONSOLE.PRESETS` | `[{label, command}]` shortcuts always allowed. |
| `THEME.DEFAULT` | `light` or `dark`. |
| `TRANSLATIONS.DEFAULT_LOCALE` | Initial UI locale. |
| `EXTENSIONS.ENABLED` | Identifiers of front-end extensions to load. |

## Development server

```bash
composer install
cp dev-server.config.json.example dev-server.config.json
php -S localhost:8080 -t public public/dev-server.php
```

Open <http://localhost:8080/codiware/repo/{workspace-alias}>.

## Extending the editor

The SPA exposes a small global API on `window.Codiware`:

```js
window.Codiware.registerEditor({
    id: 'my.editor',
    label: 'My editor',
    priority: 50,
    accepts: (entry) => /\.json$/i.test(entry.path),
    create: (host, ctx) => new MyEditor(host, ctx),
});
```

Each editor implements `load(content, meta)`, `getContent()`, `isDirty()`,
`markClean()`, `destroy()`, and an optional `on('change'|'save-request', fn)`.

Adding a richer editor library (Monaco, CodeMirror 6, Toast UI):

1. `composer require npm-asset/monaco-editor` (or similar)
2. Drop a small JS module under `public/js/extensions/` that imports the
   library from `/{basePath}/assets/monaco-editor/...` and calls
   `window.Codiware.registerEditor(...)`.
3. Add the extension id to `EXTENSIONS.ENABLED` in the config — the SPA boot
   payload exposes the list so your extension knows it is enabled.

## Security model

- All filesystem paths flow through `Codiware\Workspace\PathGuard`, which
  resolves them via `realpath`, rejects `..` traversal and any path that ends
  up outside the workspace root, and matches the configured deny patterns
  against both the relative path and the basename.
- Uploaded ZIP archives are fully validated entry-by-entry (rejects absolute
  paths, `../`, and runs every resolved destination through `PathGuard`) to
  prevent zip-slip.
- Console commands are deny-by-default. A command runs only if it matches a
  preset label or a configured regex in `CONSOLE.ALLOW_PATTERNS`.
- The middleware never trusts the host with raw paths: workspace selection
  always goes through `WorkspaceResolver` which validates against
  `ALLOWED_ROOTS` / `BASE_FOLDER` first.

## License

MIT. See [LICENSE](LICENSE).
