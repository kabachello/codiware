# Git panel

The git panel shows the current state of the repo. It is only visible if the repo folder is actually a git repo. The main objective of the git panel is to help less experienced users to understand git workflows and to simplify interaction with git.

## Current status

The panel always show the current git status:

- Current branch
- Modified, untracked, deleted and staged files

There are also buttons for most common commands. The most probable next command button is highlighted. 

## UI states in different situations

### Unpublished Git branches

The `Push` button behaves slightly differently depending on whether the user is on a published or unpublished branch.

- On unpublished branches the button generally highlighted and runs `git push -u <remote> <branch>` instead of plain `git push` when pressed
- On published branches, it is only highlighted if we are some commits behind and shows the number of commits behind automatically.
