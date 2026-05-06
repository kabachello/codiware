
## Background

I'm the DEV lead for the exface no-code platform for business web apps (https://github.com/ExFace/core). The platform currently includes an optional IDE module, that provides integration with multiple DEV tools: e.g. the well known PHP Adminer to manage SQL databases and the Atheos IDE as universal file editor with git integration. 

I am not really happy with Atheos because it is not easy to extend and lacks some important features:

- it cannot switch main contend editors for different file types - e.g. show a wysiwyg editor for markdown or an image preview
- the git UI is not good enough for us. There is no support for staging files, no good history, too many clicks are required, etc. 

I decided to build a new IDE powered by a PHP backend with the help of AI agents. 

## Requirements

### Technology stack

The new IDE is supposed to be a separate PHP Composer package, but it's primary use-case is being integrated into the ExFace platform. 

The idea is to have a PSR-7 middleware, that is easy to hook into any PHP app and that will take care of requests to the URL `api/ide/code/*`.  The IDE will be started by calling `api/ide/code/<app/alias>`, which should open the file tree of the specified app (basically a folder in `vendor/`). So in a stand-alone version the Url would include a path from some white list. 

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
#### Front-end

- SPA in plain JS
- Components with permissive OSS licenses can be used (no GPL lock-in!)
- Compatibility with modern browsers (no legacy support)
- a little responsibility - the editor should be full-screen on mobile, but the other features can be hidden or moved downwards. 
- icons can be used from Font-awesome 4 (because that is used in ExFace) or SVG icons from https://pictogrammers.com/library/mdi/
- the front-end is going to be shown in an iframe when integrated in ExFace
- the front-end should support CSS skin files to change its color scheme. We are going to use it with the jEasyUI bases template/facade in ExFace, but it should be possible to restyle it to look more like Openui5 Horizon Theme, which is also available as Look&Feel in ExFace
- There should be a dark mode
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
	- preview for findings per file (quick open in main editor on the corresponding line should be OK)

## Configuration

The global configuration is to be stored in JSON files. The middleware should have an optional argument to load a custom config: e.g. with the desired theme. 

## Translations

The ide should be translatable. Initially only English is required, but other languages will follow. 

Translations must be stored as Json objects to be compatible with ExFace. We use the symfony translation component there. 

## Testing

Propose options for automated testing for back-end APIs and front-end