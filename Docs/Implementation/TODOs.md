* [x] Replace all icons with font awesome 4 icons. Take v4 because that is currently the version used by ExFace.
* [x] wherever icons are needed, make sure font awesome and SVG icons are supported:
    * [x] font awesome: `fa fa-xxxx`
    * [x] SVG: `<svg></svg>`. We will be using [Pictogrammers MDI icons](https://pictogrammers.com/library/mdi/)
* [x] Use filetype icons for the files in the explorer panel. Add a config to map file extensions to icons.
* [ ] add a busy indicator to the sidebar while waiting for a request to the server. E.g. when a commit or push is on the way, there is no feedback, that the operation is still not finished.
* [x] add buttons to the explorer panel
    * [x] Global toolbar at the top
        * [x] Create file
        * [x] Create folder
    * [x] Item-level buttons
        * [x] three-dot menu button to show a menu of file actions
            * [x] Rename file
            * [x] Delete file
            * [x] Download the file as-is
        * [x] three-dot menu button to show a menu of folder actions
            * [x] Rename folder
            * [x] Delete folder with all contents
            * [x] Upload one or more files or a zip with files and folders
            * [x] Download as a zip
* [ ] add a right-click menu to files and folders in the explorer for the following operations:
    * [ ] create file
    * [ ] duplicate file
    * [ ] rename file
    * [ ] delete file
    * [ ] download (a single file or a folder as zip)
    * [ ] upload. Make sure multiple files and entire folders can be uploaded. Allow selecting files/folders via button and dragging them on to a drop area
* [ ] add Drag&Drop to move files between folders in the explorer panel
* [ ] make the git panel look more like visual studio code
    * [x] use a single row of buttons with icons next to the commit message window (use svg icons from pictogrammers)
    * [x] for every file show a revert changes button in addition to the existing add button.
* [ ] print all git commands and their output in the console automatically
* [x] show toast messages, when got commands complete successfully
* [x] add Monaco editor
    * [x] register it as the default editor. I think, we do not need a simplified text editor. We can always use Monaco and add extra editors just for specific mime types.
* [x] add tui editor
    * [x] register it for `*.md` files
* [x] when a file is clicked in the git panel, a diff-tab should open. Use the Monaco diff for all file.
* [ ] add a help icon at the top right button bar. It should open a cheat sheet with all keyboard shortcuts