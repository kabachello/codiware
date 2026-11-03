# Git panel

The git panel shows the current state of the repo. It is only visible if the repo folder is actually a git repo. The main objective of the git panel is to help less experienced users to understand git workflows and to simplify interaction with git.

## Current status

The panel always show the current git status:

- Current branch
- Modified, untracked, deleted and staged files

Each changed-file menu offers a download action for the current working-tree version, allowing users to make a local backup before staging or discarding it. The action is disabled for deleted files because they no longer have a downloadable working-tree version.

There are also buttons for most common commands. The most probable next command button is highlighted.

Whenever the Git panel is opened, Codiware first fetches the remote refs and then refreshes the status. This ensures that commits newly available on the server are reflected in the `Behind` counter without requiring users to run Fetch manually. If the remote is temporarily unavailable, the fetch error is shown while the panel still displays the locally available status.

## UI states in different situations

### Unpublished Git branches

The `Push` button behaves slightly differently depending on whether the user is on a published or unpublished branch.

- On unpublished branches the button generally highlighted and runs `git push -u <remote> <branch>` instead of plain `git push` when pressed
- On published branches, it is only highlighted if there are local commits to push and shows the number of commits automatically.

### Commits available on the remote

After the panel fetches the latest remote refs, the `Pull` button is highlighted whenever the current branch is behind its upstream branch. Its label includes the number of commits to pull.
