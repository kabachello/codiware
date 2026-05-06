Codiware Editor - a PHP cloud IDE integratable with a single PSR-7 middleware
## Background

I'm the DEV lead for the exface no-code platform for business web apps (https://github.com/ExFace/core). The platform currently includes an optional IDE module, that provides integration with multiple DEV tools: e.g. the well known PHP Adminer to manage SQL databases and the Atheos IDE as universal file editor with git integration. 

I am not really happy with Atheos because it is not easy to extend and lacks some important features:

- it cannot switch main contend editors for different file types - e.g. show a wysiwyg editor for markdown or an image preview
- the git UI is not good enough for us. There is no support for staging files, no good history, too many clicks are required, etc. 

I decided to build a new IDE powered by a PHP backend with the help of AI agents. 

## Requirements

### Technology stack

The new IDE is supposed to be a separate PHP Composer package, but it's primary use-case is being integrated into the ExFace platform. 

The idea is to have a PSR-7 middleware, that is easy to hook into any PHP app and that will take care of requests to the URL `codiware/*`.  The IDE will be started by calling `codiware/repo/path/in/vendor>`, which should open the file tree of the specified app (basically a folder in `vendor/`). So in a stand-alone version the Url would include a path from some white list. 

- Things like user management, sessions, etc. are to be handled externally (e.g. by other middleware). 
- The IDE should use the same base URL to serve all the HTML/JS and APIs. Dependencies in the vendor folder can be accessed directly
- It should easily co-exist with other controllers for other URLs. 
- The IDE must be immediately usable after being installed with composer - no compilation steps, no custom servers to run. This is because ExFace is a platform, where multiple apps can be installed using the integrated package manager built upon Composer and Asset-Packagist
- The integration with ExFace must be implemented in the separate axenox\ide package (basically via hooking in the middleware)
#### PHP back-end

- must run on PHP 8.2+
- may use symfony compinents v6
- should accept an external logger (probably as middleware constructor argument). We currently use Monolog v1 in ExFace
- all features must work on windows and on linux

#### Web API

- `codiware/` - base URL. The URL middleware only handles requests to this path. The path can be changed by passing an argument to the middleware. In particular, inside exface that path would be `api/ide/codiware/`. 
- `codiware/assets` - js and other static assets
- `codiware/files` - file tree and operations
- `codiware/git` - git commands
- `codiware/repo/xxx/yyy` - initial URL for opening a folder, where `xxx/yyy` is the path relative to a base folder (`vendor` by default)

Other APIs can be added by adding more paths. 

The initial call to open the IDE must be a `repo/` URL. 
#### Front-end

- SPA in plain JS
- Components with permissive OSS licenses can be used (no GPL lock-in!)
- Compatibility with modern browsers (no legacy support)
- a little responsibility - the editor should be full-screen on mobile, but the other features can be hidden or moved downwards. 
- icons can be used from Font-awesome 4 (because that is used in ExFace) or SVG icons from https://pictogrammers.com/library/mdi/
- the front-end is going to be shown in an iframe when integrated in ExFace
- the front-end should support CSS skin files to change its color scheme. We are going to use it with the jEasyUI bases template/facade in ExFace, but it should be possible to restyle it to look more like Openui5 Horizon Theme, which is also available as Look&Feel in ExFace
- There should be a dark mode

UI structure:

- tabbed editor in the middle
- side-panels - resizable and collapsible. 
	- file browser - left
	- git panel - right
	- Ai chat - right (future)
- bottom panel - resizable and collapsible
	- console
	- search
- colored toast messages for errors, success notifications, etc. 
## Features

The ide should feel like modern IDEs - e.g. VS code or PHPStorm

- tabbed main editor
	- Code editor for php, Javascript, HTML, sql and Json with
		- syntax highlighting
		- autocomplete based on the current files
	- WYSIWYG editor for markdown
		- support for rendering mermaid diagrams
		- support for github flavor - in particular, tables
	- preview or even an editor for images
	- all editors must 
		- show the absolute file path on hover over the name of the opened file
		- opened tabs should be restored after the Ide is closed and reopened
	- all text editors must
		- indicate unsaved changes
		- offer search/replace within the file
		- allow to toggle text wrapping
	- code editors must
		- show line numbers
		- offer short key to go to a line
	- WYSIWYG editors must 
		- have a split mode with a preview
		- have a toolbar with icons for
			- headings
			- numbered and unordered lists
			- tables
			- links
			- codeblocks and inline code
- git UI permanently visible in a side panel if the opened base folder is a git repo
	- see changed files by default
		- quick filter for this list
	- discard changes per file
	- open a nice diff for a changed file and discard changes directly from the diff-viewer. Maybe even discard individual changes? 
	- stage individual or multiple files
	- commit with a message (committee name and email must be stored in some user config as multiple users are going to work on the same directory)
	- amend
	- see ahead/behind counters
	- push changes
	- see/change branches
	- see history (ideally as a git graph)
		- see files changed. Maybe even open the diff to previous? 
	- merging can be done by opening conflicts in the regular editor. No explicit support required right now. 
- directory/file tree with
	- a clear indicator, of what file is opened
	- memory for last open/closed branches
	- right-click menu
	- drag-to-move and ctrl-drag to copy
	- download option for 
		- individual file or entire 
		- folders (zipped)
	- easy upload via drag and drop
		- individual files
		- zipped folders including subfolders
- global search in all files or within a specified path mattern
	- replace in all/selected files
	- preview for findings per file - quick open in main editor on the corresponding line without (!) closing the search panel
	- ideally also displayed as a side or bottom panel
	- searching for regular expressions would be nice as an option. Poor performance is OK here. 
- a web console in the bottom panel
	- allows to run custom git commands
	- allows to run other commands matching a regex pattern in the config. Even commands with `../` are allowed in the config - but ONLY those matching the configured patterns. 
	- has a menu or toolbar with command presets, defined in the config. Presets are pasted into the console, but not sent automatically - this way, the user can modify them.
		- propose a default set of presets for git: e.g. `git clean`, etc. 
		- presets are automatically concidered to be allowed commands - even if they do not match any patterns. 

### Future features

The architecture should in principle allow the following additions, that already can be anticipated:

- more different editor types, e.g.
	- Image resizer/cropper
	- WYSIWYG HTML editor
	- ER diagram editor like https://github.com/dineug/erd-editor
- an Ai chat side-panel with deep-chat (integration with ExFace already available) for collaborative editing of text/code. Diff highlighting with accept/reject options would be very helpful! 
- multiple secondary root folders should be supported by showing a menu with the white list to pick from. The IDE is always started for ONE base folder, but the the user can pick others to be included in the file tree. Similar to adding folders to workspace in VS code, the initial base folder is the workspace and more roots can be added. Added root should be remembered for every initial root (=workspace) - just like opened tabs. 
	- how will the git panel behave?

## Configuration

The global configuration is to be stored in JSON files. The middleware should have an optional argument to load a custom config: e.g. with the desired theme. 

## Translations

The ide should be translatable. Initially only English is required, but other languages will follow. 

Translations must be stored as Json objects to be compatible with ExFace. We use the symfony translation component there. 

## Error handling and logging

All PHP errors and exceptional should be displayed as tost messages if possible. They must be passed as throwables to Monolog in the data-array with key `exception` in this case.

If toast messages are not possible for specific throwables, they can be thrown to outside of the middleware. 

## Integrations 

### Git

Some information for git must be passed to the middleware from outside:

- committer name and email

This can be done via middleware constructor arguments. 

### ExFace

When integrated into exface, the IDE will be always called for a specific user and a specific app (package). 

## Testing

Propose options for automated testing for back-end APIs and front-end