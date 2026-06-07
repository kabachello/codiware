## Global

* [ ] add a help icon at the top right button bar. It should open a cheat sheet with all keyboard shortcuts

### Explorer

* [ ] add duplicate file button
* [ ] add a "copy path" button

## Console

- Rebuild the console panel using xterm.js and symfony console in the backend. Make the console write output line-by-line - see working example in WebConsoleFacade.php.

### Git panel

- Make all cli commands performed by the user  either directly or via button in the git panel to visible in the console panel including their output. Open the panel automatically if a command from the git panel fails. 
	- Keep the log of all commands in the console panel as long as the editor UI is opened. 

## Editors

### Markdown

* [ ] bug: Icons in toolbar disappear on hover
* [ ] clicking a search result will open the editor, but not navigate to the correct line. In fact, no line numbers are visible at all. Maybe the search should always open Monaco instead of the file type editor?
* [ ] make the top toolbar smaller. It is to high and its icons are much bigger than ours
* [ ] bug: in dark mode the scrollbars are white and look ugly

### Monaco editor

* [ ] bug: long lines overlap the scroll bar and are visible inside of it