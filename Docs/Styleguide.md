## General

### Themes

The IDE supports switchable CSS themes. Themes mainly affect colors. Each theme must have a dark and a light mode.

Themes are set in the config. The user can switch between light and dark modes using a toggle button in the UI.

### Icons

Buttons and other UI elements, that use icons, support font awesome icons via `fa fa-xxxx` and SVG icons via `<svg></svg>`.

The same icon is to be used for the same functionality in all places in the app.

### Colors

Colors of UI elements should be used to highlight these: e.g. promoted button, active menu items, etc. All these colors must be part of the theme!

Highlight colors must have a high contrast to regular colors to help people with limited color vision. Indicators (like the unsaved changes indicator on the editor tab) must not be based on a color only - instead, use an icon or a symbol (letter), that appears or changes an may be colored additionally.

Colors inside of editors do not necessarily need to change with the theme. If the editor library natively supports themes itself, we can link our themes to library themes in its configuration. If the editor does not have its own themes, we do not have to restyle it.

## Layout

The layout is similar to Visual Studio Code:

* header - thin bar with global buttons, editor name and name of the opened folder/repo
* left sidebar with tabs for multiple panels: explorer, git, search
* right sidebar - optional, only for additional features in the future
* main content with tabbed editora
* bottom panel with tabs for tools like console, previews and future integrations
* footer with global state information like username

## Panels

All sidebar and bottom panels should look and feel similar. 

Tabs across all panels (sidebar tabs, bottom panel tabs and editor tabs) give hover feedback by changing their background, so it is always clear that a tab can be pressed. Use the `--ide-tab-hover` token for inactive tabs; the token is defined per theme and must stay clearly distinct from `--ide-tabbar-bg` so the effect is visible in both light and dark themes. The currently active tab keeps its distinct background but still brightens slightly on hover so even single-tab panels (like the Monaco outline) react to the pointer.

Bottom panel behavior:

* supports multiple tabs, similar to the left sidebar
* can be collapsed to a narrow stripe that still shows tab names
* clicking a tab in collapsed mode expands the panel and opens that tab

Sidebar behavior:

* left and right sidebars can be collapsed to a narrow stripe that still shows panel tab icons
* each sidebar has a collapse/expand toggle button with the same visual language as the bottom panel toggle
* clicking a sidebar tab in collapsed mode expands the sidebar and opens that tab
* in expanded mode, only the active sidebar tab shows icon + title in the header row; inactive tabs show only their icons
* in collapsed mode, the active tab is marked with the same accent line pattern on the relevant outer edge of the sidebar so left and right sidebars feel like mirrored variants of the same component

Editor-local side panels (for example the Monaco outline on the right side inside one editor tab) should follow the same interaction language as the global sidebars whenever possible:

* they can be collapsed into a narrow visible strip instead of disappearing entirely
* they use the same angle-icon metaphor for collapse/expand
* on narrow smartphone screens they should default to collapsed if they would otherwise noticeably reduce editing space
* if they expose tabs, they should follow the same active-tab rule as the global sidebars: active tab shows icon + title while expanded, inactive tabs show icon only
* if an editor-local panel currently has only one tab, it should still use the same tab/header visual language so additional tabs can be added later without redesign

### Lists and hierarchies 

Sidebar panels contain hierarchical lists. On top of each list there is a toolbar with global buttons, applicable without selecting a list item.

Each list item has

* icon
* name
* tooltip

List item names and tooltips are only tranlatable if the item represents a function. Names and tooltips of files are not translatable.

### Toolbars

A toolbar inside the side panel has a number of buttons and a three-dot "more" button on the right, that opens a menu with buttons, that did not fit in the toolbar itself.

Each button has

* icon
* name (not show in a toolbar to save space, but shown if the button is moved to the overflow menu)
* tooltip, that explains the button functionality.

All names and tooltips are translatable.

### Inline buttons

Each list item inside a sidebar has its own small toolbar, displayed on the right next to the list item title. This "inline" toolbar shows buttons, applicable for this particular item. Buttons look and work the same, as in the global toolbar at the top: only icon + tooltip.

The Inline toolbar can show up to 2 most important buttons and the three-dot menu. The menu will hold all buttons, that did not fit.

List items in sidebar trees also support a right-click context menu. This context menu must expose the same item-level actions as the inline toolbar/menu for that item.

### Console output blocks

Console commands and their output must be visually separated into distinct blocks, so multiple runs stay readable in one long terminal scrollback.

Each block should:

* begin with a visible separator line
* show the executed command directly below that separator
* contain the command output unchanged
* end with a visible closing separator or spacing before the next prompt

Separators may use terminal box-drawing characters or similar text-based markers because the console itself is terminal-rendered. The separation must not rely on color only.

## Editor tabs

The main editor area has tabs for opened files.

Tab headers show:

* filename with extension
* absolute filepath in a tooltip
* small floppy icon, that shows up, if the file has unsaved changes. Pressing this icon will save the file

The tab of the currently visible file must be clearly highlighted by using a distinct background color.

Tabs can be reordered via drag and drop. During dragging, text selection inside the tab header should not be triggered. The drop target must be shown with a clear visual insertion marker that does not rely on color only.

Right-clicking a tab header opens a context menu with bulk close actions for all tabs, tabs to the left, tabs to the right, and all other tabs. Disabled actions should stay visible when they are not applicable so the menu remains predictable.

If there is not enough space for all tabs, the right-most tabs "overflow" into a menu, accessible via three-dot button on the right end of the tab bar.

When the screen width changes, the tab bar recalculate overflowing items.

The active tab is never placed in the overflow menu!
