## General

### Themes

The IDE supports switchable CSS themes. Themes mainly affect colors. Each theme must have a dark and a light mode. 

Themes are set in the config. The user can switch between light and dark modes using a toggle button in the UI. 
### Icons

Buttons and other UI elements, that use icons, support font awesome icons via `fa fa-xxxx` and SVG icons via `<svg></svg>`. We are using SVG icons from pictogrammers. 

The same icon is to be used for the same functionality in all places in the app. 

### Colors

Colors of UI elements should be used to highlight these: e.g. promoted button, active menu items, etc. All these colors must be part of the theme! 

Highlight colors must have a high contrast to regular colors to help people with limited color vision. Indicators (like the unsaved changes indicator on the editor tab) must not be based on a color only - instead, use an icon or a symbol (letter), that appears or changes an may be colored additionally. 

Colors inside of editors do not necessarily need to change with the theme. If the editor library natively supports themes itself, we can link our themes to library themes in its configuration. If the editor does not have its own themes, we do not have to restyle it. 

## Layout

The layout is similar to Visual Studio Code:

- header - thin bar with global buttons, editor name and name of the opened folder/repo
- left sidebar with tabs for multiple panels: explorer, git, search
- right sidebar - optional, only for additional features in the future
- main content with tabbed editora
- footer with global state information like username

## Panels

Sidebar panels contain hierarchical lists. On top of each list there is a toolbar with global buttons, applicable without selecting a list item. 

Each list item has
- icon
- name
- tooltip

List item names and tooltips are only tranlatable if the item represents a function. Names and tooltips of files are not translatable. 

### Toolbars

A toolbar inside the side panel has a number of buttons and a three-dot "more" button on the right, that opens a menu with buttons, that did not fit in the toolbar itself. 

Each button has 

- icon
- name (not show in a toolbar to save space, but shown if the button is moved to the overflow menu)
- tooltip, that explains the button functionality. 

All names and tooltips are translatable. 
### Inline buttons

Each list item inside a sidebar has its own small toolbar, displayed on the right next to the list item title. This "inline" toolbar shows buttons, applicable for this particular item.  Buttons look and work the same, as in the global toolbar at the top: only icon + tooltip. 

The Inline toolbar can show up to 2 most important buttons and the three-dot menu. The menu will hold all buttons, that did not fit. 

## Editor tabs

The main editor area has tabs for opened files. 

Tab headers show:

- filename with extension
- absolute filepath in a tooltip
- small floppy icon, that shows up, if the file has unsaved changes. Pressing this icon will save the file

The tab of the currently visible file must be clearly highlighted by using a distinct background color. 

If there is not enough space for all tabs, the right-most tabs "overflow" into a menu, accessible via three-dot button on the right end of the tab bar. 

When the screen width changes, the tab bar recalculate overflowing items. 

The active tab is never placed in the overflow menu!

