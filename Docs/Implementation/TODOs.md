## Global

* [ ] add a help icon at the top right button bar. It should open a cheat sheet with all keyboard shortcuts

## Side panels

* [ ] add a right-click menu to files and folders in the explorer for all button operations
* [ ] add a busy indicator to the sidebar while waiting for a request to the server. E.g. when a commit or push is on the way, there is no feedback, that the operation is still not finished.
* [ ] make Panels collapsible

### Explorer

* [ ] add duplicate file button
* [x] add Drag&Drop to move files between folders in the explorer panel

### Git panel

* [ ] print all git commands and their output in the console automatically, so the user can see the details
* [ ] if a git command does not work, there is no feedback at all. Perhaps, printing commands to console panel will solve this anyhow. But we will need to open the console panel automatically if something goes wrong.

## Bottom panel

* [ ] Give the panel a title
* [ ] make bottom panel collapsible. Let a small strip remain visible when collapsed, so a user can expand it manually

## Footer

* [x] On the right there is already a repo name
    * [x] add ahead/behind counters
    * [x] add number of changed, deleted untracked and staged files
    * [x] open git panel on click

## Editors

### Markdown

* [ ] bug: Icons in toolbar disappear on hover
* [ ] clicking a search result will open the editor, but not navigate to the correct line. In fact, no line numbers are visible at all. Maybe the search should always open Monaco instead of the file type editor?
* [ ] make the top toolbar smaller. It is to high and its icons are much bigger than ours
* [ ] bug: in dark mode the scrollbara are white and look ugly

### Monaco editor

* [ ] bug: long lines overlap the scroll bar and are visible inside of it