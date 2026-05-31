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

### Toolbars

A toolbar inside the side panel has a number of buttons and a three-dot "more" button on the right, that opens a menu with buttons, that did not fit in the toolbar itself. 

Each button has an icon and no text (to save space). There is a tooltip, that explains the button functionality. 

### Inline buttons

Each list item inside a sidebar has its own small toolbar, displayed on the right next to the list item title. This "inline" toolbar shows buttons, applicable for this particular item.  Buttons look and work the same, as in the global toolbar at the top: only icon + tooltip. 

The Inline toolbar can show up to 2 most important buttons and the three-dot menu. The menu will hold all buttons, that did not fit. 

## Editor tabs

The main editor area has tabs for opened files. 

Tab headers show:

- filename with extension
- absolute filepath in a tooltip
- indicator showing, if the file has unsaved changes

The tab of the currently visible file must be clearly highlighted by using a distinct background color. 

If there is not enough space for all tabs, the right-most tabs "overflow" into a menu, accessible via three-dot button on the right end of the tab bar. 

When the screen width changes, the tab bar recalculate overflowing items. 

The active tab is never placed in the overflow menu!

