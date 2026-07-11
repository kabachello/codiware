# Git panel upgrade

## Same UX as in explorer panel 

Change the UX of the git panel to resemble the file explorer panel. 

- use the same tree. Can we use exactly the same component? 
	- only two levels here: change type and files
	- bg color highlighting on hover
	- actions for every row - however, in the git panel two action items should always be visible and not be hidden in the three-dot menu. Should there be more than 2 actions, those starting with no. 3 should appear in the dot-menu only. 
	- right-click with the row actions

## Line improvements

On each file line we have the the change type. Indicator (`M`, `D`, `?`, etc. ) and the file path. Both are important. However, they need some. Improvement

- make sure the indicator is always on the same line. 
- style the indicator differently from the file path - make it look more like an icon 
- make the file path shorter: just show the file name with extension and the direct parent folder name. Trim away higher level folder names. Show the full path in a tooltip. 

## More line actions

- Replace the restore action for untracked files with s delete action (same icon as in explorer tab)
- Add an action to open the file in a regular editor (not diiff) except for deleted lines. 
