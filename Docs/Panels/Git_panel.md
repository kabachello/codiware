# Git panel

The git panel shows the current state of the repo. It is only visible if the repo folder is actually a git repo. The main objective of the git panel is to help less experienced users to understand git workflows and to simplify interaction with git.

## Current status

The panel always show the current git status:

- Current branch
- Modified, untracked, deleted and staged files

Each changed-file menu offers a download action for the current working-tree version, allowing users to make a local backup before staging or discarding it. The action is disabled for deleted files because they no longer have a downloadable working-tree version.

There are also buttons for most common commands. The most probable next command button is highlighted.

Whenever the Git panel is opened, Codiware first fetches the remote refs and then refreshes the status. This ensures that commits newly available on the server are reflected in the `Behind` counter without requiring users to run Fetch manually. If the remote is temporarily unavailable, the fetch error is shown while the panel still displays the locally available status.

## Managing branches

The branch name in the Git panel and status bar opens the same dropdown-style
chooser using the shared popup controller. Branch-management actions belong in
this chooser rather than in separate dialogs.

The menu is ordered as follows, with separators between sections and empty
branch groups omitted:

1. **Create branch**
2. **Local branches**, with a submenu for each branch
3. **Remote branches**, with a submenu for each branch
4. **Worktrees**, containing **Create worktree** followed by the **Worktrees** submenu

The chooser loads `/git/branches`. Each branch submenu offers **Checkout**,
**Merge into current branch**, and **Delete branch**, rather than checking out
the branch immediately. Current local branches keep checkout and delete visible
but disabled. Deleting a branch requires explicit confirmation.

Selecting a remote branch attaches the user to a local tracking branch instead
of leaving the checkout in detached HEAD. For example, `origin/feature/demo`
maps to the local branch `feature/demo`, while the menu retains the remote name.

**Create branch** asks for a name and calls `/git/checkout` with `create: true`.
An optional `start_point` supports creating branches from a commit selected in
history as well as from the current `HEAD`. New branches start without an
upstream and are marked `unpublished`; the promoted **Push branch** action first
publishes them with `git push -u`, after which the normal **Push** behavior applies.

## Managing worktrees

Worktrees provide separate working directories for the same repository. The
worktree menu lists the main repository and linked worktrees, with switch/delete
submenus and a create action. Main, current, locked, and missing entries keep
deletion visible but disabled. Deletion requires confirmation and only removes
inactive, clean, unlocked worktrees; it does not delete their branches.
Switching confirms unsaved editor changes and keeps tab restoration separate for
each worktree.

The branch chooser exposes worktree management and creation even before the first
linked worktree exists. Its **Worktrees** entry opens a nested submenu beside the
parent entry without closing the branch menu, whether opened from the Git panel
or status bar. It loads worktree entries alongside branches and reuses
`WorktreeSelector.menuItems()` as the submenu children, including each worktree's
switch/delete submenu. All levels remain in the same shared popup tree.

New worktrees live at `{main-repo-path}.worktrees/{title}`. Git reuses a branch
with that title or creates it from the current `HEAD`. Titles must be single path
segments containing letters, digits, dots, underscores, or hyphens, beginning with
a letter or digit and not ending with a dot. Create/delete operations capture
console output using the same success/error conventions as other Git actions.

Worktree selectors, non-current list entries, and the branch chooser's
worktree-management entry use the shared `Icon.worktree` file-tree SVG. Current
worktree entries use the same `fa fa-bullseye` indicator as the current branch,
including the main repository when selected. **Switch to worktree** uses the
`Icon.switchWorktree` folder-with-down-arrow SVG, while branch **Checkout** uses
the `Icon.checkoutBranch` down-arrow-to-bar SVG. The SVGs inherit the current
text color in both themes and have no separate title tooltip.

Hide worktree controls, worktree header titles, and Git/worktree error-panel
activation in non-Git workspaces or when Git is disabled. A worktree URL parameter
must not add Git UI to a plain folder.

### IDE URLs

Linked worktrees open at
`{basePath}/repo/{workspacePath...}/worktrees/{title}/`: the repository is selected
first, then one of its worktrees.

Switching worktrees and **Open main checkout** preserve the repository path
as encoded in the current URL. Do not rebuild it from the boot workspace path:
the host may normalize an ExFace app alias such as `axenox.Markian` into a
namespace such as `axenox\Markian`, which is not the public entry URL.

Optional `?branch=...` and `?worktree=...` deep links are disabled by default.
Enable `GIT.ALLOW_BRANCH_URL_PARAMETER` and `GIT.ALLOW_WORKTREE_URL_PARAMETER`
independently to accept them; the ExFace integration enables both. Worktrees are
matched by directory title among the repository's registered linked worktrees.
If the requested worktree is missing or ambiguous, the regular repository opens
unchanged with an error in the active Git panel.

### Merging a worktree

Inside a linked worktree, **Merge worktree** stays alongside Push and Pull. It
uses the existing toolbar-button and promoted-label classes, shows the number of
commits not present in the main checkout, and becomes primary instead of Push
when that count is positive.

The tooltip explains that committed changes merge into the branch currently
checked out in the main repository folder. Uncommitted changes are excluded;
nothing is pushed and the worktree is kept. When disabled, the tooltip also
explains the blocking reason.

Linked-worktree status includes `worktree_merge` with `commits`, `source_head`,
`target_head`, `target_branch`, and `blocked_reason`; main-checkout status returns
`null`. The count is `git rev-list --count {main-HEAD}..{source-HEAD}`, independent
of upstream publication.

Merging is disabled when there is nothing to merge or the main checkout is
unavailable, detached, dirty (including untracked files), or has an unfinished
merge, rebase, cherry-pick, revert, or bisect operation. An unfinished operation in
the source also blocks it; ordinary uncommitted source edits are not included.
Ignored untracked paths are compared against source/destination differences,
including file/directory collisions, and block the merge if they could be
overwritten. Unrelated ignored files do not block it. This preflight is required
in addition to Git's `--no-overwrite-ignore` flag because not all merge paths
honor that flag consistently.

The client reloads status before confirmation, names both branches and the
commit count, and explicitly says nothing will be pushed. It sends the reviewed
`source_head`, `target_head`, and `target_branch` to `/git/merge-worktree`. The
server recomputes safety state and rejects a changed snapshot rather than
merging unreviewed commits or into a different branch.

The operation runs `git merge --no-edit --no-autostash --no-overwrite-ignore
{source-head}` in the registered main directory, using the host user identity
when available. It supports fast-forward and real merge commits without
rewriting source history. Nothing is pushed, discarded, force-merged, or deleted.

Success and failure notices include **Open main checkout**. Conflicts return a
failed response with captured console output and `open_main: true`, leaving the
merge in the main checkout for explicit resolution or abort. Persistent guidance
must clearly locate the unfinished merge there, not in the worktree. Opening
the main checkout retains the usual unsaved-editor confirmation.

## Status bar

Git also affects the global footer. Its order is:

1. Folder icon and repository name
2. Separator
3. Worktree selector
4. Separator
5. Git branch controls

The current branch name opens the same chooser as the Git panel. The separate
worktree selector appears only when linked worktrees exist and uses the same
footer button classes (`.ide-status-git-branch` and
`.ide-status-git-branch-name`) and shared popup controller. Hide it together with
its leading separator when no linked worktrees exist. Do not repeat the
repository name inside the Git branch controls.

Branch and worktree selector buttons use 2px horizontal padding and a 4px flex
gap. Their labels must not add the generic icon-adjacent margin on top of that
gap.

In the top header, append the active worktree title next to the repository name
only inside a linked worktree, not for the main repository.

## UI states in different situations

### Unpublished Git branches

The `Push` button behaves slightly differently depending on whether the user is on a published or unpublished branch.

- On unpublished branches the button generally highlighted and runs `git push -u <remote> <branch>` instead of plain `git push` when pressed
- On published branches, it is only highlighted if there are local commits to push and shows the number of commits automatically.

### Commits available on the remote

After the panel fetches the latest remote refs, the `Pull` button is highlighted whenever the current branch is behind its upstream branch. Its label includes the number of commits to pull.
