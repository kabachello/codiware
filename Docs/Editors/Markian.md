# Markdown Editor: Markian

This guide owns Codiware's Markdown integration architecture, configuration and
presentation rules. General editor contracts remain in the
[architecture](../Architecture.md), and shared IDE UI rules remain in the
[style guide](../Styleguide.md).

## Adapter and Dependencies

The `codiware.markdown` descriptor always constructs the Markian-backed
[MarkdownEditor](../../public/js/editors/MarkdownEditor.js) for `.md` and
`.markdown` files. There is no Markdown engine selection or fallback. Markian is
an MIT-licensed direct Composer dependency (`axenox/markian`) supplying prebuilt
assets without a consumer build step.

The adapter starts in Visual mode and retains Source/Preview navigation. Supported
document features include GitHub tables, headings, lists, links, code blocks,
inline code toolbar commands and optional Mermaid diagrams.

## Assets and Configuration

`INCLUDES.MARKIAN_JS` and `INCLUDES.MARKIAN_CSS` configure prebuilt core assets,
defaulting to the direct Composer package. Optional extension assets resolve
beside the configured script unless explicitly overridden. For example:

```json
{
	"EXTENSIONS.CONFIG": {
		"codiware.markdown": {
			"INCLUDES.MARKIAN_JS": "vendor/axenox/markian/dist/markian.min.js"
		}
	}
}
```

`INCLUDES.PREVIEW_CSS` maps to Markian's `markdownCssUrls`; when empty, Markian
retains its packaged default content style. The adapter always supplies
Codiware's [shared theme](../../public/css/markian-theme.css), resolved through
the app asset base, then appends any host `INCLUDES.THEME_CSS` overrides. Host CSS
lists resolve vendor-relative paths with the installation prefix and cache
version and load through Markian's readiness lifecycle. The `axenox.IDE` host
keeps its GitHub/DocsFacade content styles.

`CSS_CLASS_FOR_PREVIEW_CONTAINER` applies to every rendered `.markian-document`,
including newly opened Preview/Help surfaces, never the editor shell. The adapter
owns the observer that applies these classes and releases it on teardown.

## Lifecycle, Saving and Navigation

The adapter retains clean-load baselines, snapshot-based save acknowledgment,
focus, resizing and teardown. TabManager owns the outer editor host and toggles
its visibility. The Markdown adapter passes a child mount to Markian, which
replaces that child with its editor root; it must not replace the outer host or
tab activation and closing will leave Markdown visible.

Image insertion calls Codiware's `/files/upload` with `autoname=1`, saving into
the neighboring `images/` directory before inserting a relative destination.
`beforeSave()` awaits Markian's pending-image gate; failed image creation cannot
become a successful save. Relative images use the guarded download endpoint
without changing stored URLs. Link suggestions, inspection and navigation remain
host callbacks.

Text diffs, including Markdown diffs, always use the Monaco diff descriptor rather
than file-type selection. Search results also force the Monaco code editor to
retain precise raw-text line/column navigation.

## Code and Mermaid Extensions

Markdown extensions use Markian's public factory and instance contracts. The
adapter enables supported optional factories through extension settings rather
than exposing engine internals or inventing a second plugin API.

Code and Mermaid factories are loaded, registered and enabled automatically,
including when host settings omit their flags. Set `MARKIAN.CODE` or
`MARKIAN.MERMAID` to `false` to disable the corresponding extension and its asset
loading. Code-block floating controls contain only expansion when available,
never prose formatting; disabling Code hides those controls entirely.

Mermaid rendering requires a host-supplied 12.2.x `INCLUDES.MERMAID_JS` asset;
`MERMAID.VERSION` defaults to `12.2.0`. The ExFace integration supplies that
renderer locally; standalone hosts must configure it. Renderer URLs respect the
installation prefix and cache version. Codiware does not bundle or download a
renderer automatically. Mermaid is MIT-licensed.

## Theme and Content Styles

The shared theme is scoped by `.codiware-markdown-editor`. It maps Markian
colors/fonts to Codiware tokens and removes editor frame borders and rounding.
Toolbar and status surfaces use `--ide-sidebar-bg` to match the explorer toolbar;
dropdowns, menus and popups use `--ide-panel-bg`. Content has 12px vertical and
20px horizontal padding, reduced to 10px/12px below 480px of editor width. Use
this shared stylesheet, not look-alike host copies.

Configure toolbar appearance through Markian's supported root variables, not
child-selector sizing overrides: 26px-wide by 20px-high controls, 14px square main
SVG icons, 8px toolbar chevrons, and a 32px toolbar with `7px 4px 4px` padding.
The extra top space accounts for the file-tree toolbar's lower starting position,
aligning controls and bottom dividers. Explicit toolbar dimensions also apply at
narrow editor widths. Dropdown rows and non-toolbar button targets retain library
defaults; general main icons are 14px. The image editor shares the
`--ide-editor-toolbar-*` and `--ide-editor-tool-*` geometry tokens.

Scope content rules to `.markian-document` or the configured content class, such
as `.markdown-body`; that class is applied to Visual, Preview and Help content,
not the editor shell. Keep toolbar and button overrides scoped under
`.codiware-markdown-editor`. Hosts can override the shared theme through the later
theme CSS list without changing stored Markdown. Codiware's theme switch is
forwarded to Markian without recreating the document or dirtying it.

Within `.codiware-markdown-editor .markian-document`, the shared theme maps GitHub
Markdown's default/muted/neutral backgrounds, default/muted/accent foregrounds,
and default/muted borders to the corresponding IDE tokens. Content inherits the
editor's color scheme. Tables, alternating rows, links and code surfaces therefore
follow Codiware's explicit light/dark toggle rather than the browser's independent
`prefers-color-scheme`. Keep this mapping in the shared adapter, not in copied
table-specific overrides; unrelated Markdown surfaces remain untouched and later
host theme overrides retain precedence.

Markian's base editor CSS owns structural paragraph spacing inside list items and
table cells, preventing paragraph wrappers from adding large gaps. Do not
duplicate these rules in the Codiware theme. Table-cell padding, item spacing and
nested-list spacing remain controlled by the content stylesheet.

### Search and Destination Popups

Search, link and image popups use the same shared theme stylesheet for native
Codiware form styling: `--ide-fs` / `--ide-font` typography, `--ide-input-bg`
fields, `--ide-border` borders, `--ide-radius` corners, and 4px/6px field padding.
Focused fields change their existing border to `--ide-accent`, matching native
search fields without an added outline or shadow.

Text buttons and file-picker buttons use `--ide-btn-bg`, `--ide-border` and
4px/10px padding; icon-only panel actions are transparent and borderless at rest
with stable 26px square targets. Both use `--ide-btn-hover` hover feedback.
Buttons and checkboxes retain a thin inset keyboard-focus outline. Checkboxes use
the accent color, and disabled buttons retain the native opacity/cursor. These
overrides are panel-scoped and do not resize toolbar or menu controls.

Destination inputs use a shared 30px height in Codiware. File-picker buttons have
0px/6px padding inside that height, keeping Image URL, Upload new image and Tooltip
(alternative text) equally sized and evenly spaced in the image dialog.

## Document Outline

`MARKIAN.SIDEBAR_VISIBLE` defaults to true and maps to Markian's `sidebarVisible`
startup option. Set it to false in the Markdown extension configuration for
collapsed startup; the user can still toggle the outline.

Keep the outline beside the document with independent scrolling, not floating
above text; its width is capped at 40% of the work area at narrow sizes. A false
startup setting collapses it without removing the toolbar toggle. Heading
navigation leaves it open; presentation changes must not dirty the document.
