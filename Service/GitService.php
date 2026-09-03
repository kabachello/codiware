<?php
declare(strict_types=1);

namespace kabachello\Codiware\Service;

use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Workspace\WorkspaceRoot;
use Psr\Log\LoggerInterface;
use Symfony\Component\Process\Process;

/**
 * Thin wrapper around the local `git` CLI.
 *
 * Commands are executed via symfony/process with argument arrays (no shell
 * interpolation). Output is parsed into typed arrays for the API.
 */
final class GitService
{
    private string $binary;

    private CommandNormalizerInterface $colorNormalizer;

    public function __construct(
        private readonly CodiwareConfig $config,
        private readonly LoggerInterface $logger,
        ?CommandNormalizerInterface $colorNormalizer = null
    ) {
        $this->binary = (string)($config->get('GIT.BINARY', 'git') ?? 'git');
        // Shared with the console so output captured for injection is colored the
        // same way as commands typed into the console.
        $this->colorNormalizer = $colorNormalizer ?? new GitColorNormalizer();
    }

    public function isRepository(WorkspaceRoot $root): bool
    {
        return is_dir($root->path . DIRECTORY_SEPARATOR . '.git')
            || is_file($root->path . DIRECTORY_SEPARATOR . '.git');
    }

    private function requireRepo(WorkspaceRoot $root): void
    {
        if (!$this->isRepository($root)) {
            throw new CodiwareException(
                'Workspace is not a git repository.',
                'not_a_git_repo',
                400,
                ['root' => $root->alias]
            );
        }
    }

    /**
     * Read the current repository status as file-level entries for the Git panel.
     *
     * Untracked directories are expanded with `--untracked-files=all` so the UI
     * receives concrete file paths instead of one synthetic `folder/` row. This
     * keeps diff, stage and delete actions identical for new files no matter
     * whether their parent folder was already tracked by Git.
     *
     * The returned publication state marks local branches without an upstream as
     * `unpublished`. The front-end uses this to promote the push button as
     * "Push branch", while `push()` uses the same state to run `git push -u`.
     *
     * @return array<string,mixed>
     */
    public function status(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        // -z separator avoids quoting issues for paths with spaces/utf-8.
        $out = $this->run($root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
        return $this->enrichPublicationState($root, $this->parseStatusV2($out));
    }

    /**
     * Resolve the branch that should be active when the IDE opens a workspace.
     *
     * The caller passes the optional `branch` URL parameter. When it is empty,
     * the repository stays on its current branch and the current status is
     * returned unchanged. When it names another branch, git checks out that
     * branch before the updated status is returned. This keeps deep links like
     * `...?branch=1.x-dev` declarative for callers while avoiding a second round
     * trip from the SPA during bootstrap.
     *
     * Remote refs are handled in the same user-friendly way as the interactive
     * branch chooser: selecting `origin/1.x-dev` creates or resets the matching
     * local branch (`1.x-dev`) to track that remote instead of checking out the
     * remote ref directly. This avoids detached HEAD states while still letting
     * callers use the remote name they see in the dropdown.
     *
     * @return array{status:array<string,mixed>,switched:bool,target_branch:?string,console:?array{command:string,output:string,exit_code:int,ok:bool}}
     */
    public function ensureBranch(WorkspaceRoot $root, ?string $requestedBranch): array
    {
        $status = $this->status($root);
        $branch = trim((string)($requestedBranch ?? ''));
        if ($branch === '') {
            return [
                'status' => $status,
                'switched' => false,
                'target_branch' => $status['branch'],
                'console' => null,
            ];
        }

        $checkoutPlan = $this->resolveCheckoutTarget($root, $branch);
        if (($status['branch'] ?? null) === $checkoutPlan['local']) {
            return [
                'status' => $status,
                'switched' => false,
                'target_branch' => $checkoutPlan['local'],
                'console' => null,
            ];
        }

        $checkout = $this->checkout($root, $branch, false);
        return [
            'status' => $this->status($root),
            'switched' => true,
            'target_branch' => $checkoutPlan['local'],
            'console' => $checkout['console'] ?? null,
        ];
    }

    /**
     * Build the two sides of a Git diff for the working tree or the index.
     *
     * Text files keep the legacy `old`/`new` string fields used by the Monaco
     * diff editor. Raster images return `type: image` plus data-URL based
     * `old_image`/`new_image` fields so JSON encoding never sees raw binary
     * bytes. Missing sides are marked with `exists: false` for added/deleted
     * files and are rendered as empty panes by the image diff editor.
     *
     * @return array<string,mixed>
     */
    public function diff(WorkspaceRoot $root, string $path, bool $staged = false): array
    {
        $this->requireRepo($root);
        $absPath = $root->path . DIRECTORY_SEPARATOR . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);

        $newContent = '';
        $newExists = false;
        if (!$staged && is_file($absPath)) {
            $fileContent = @file_get_contents($absPath);
            if ($fileContent !== false) {
                $newContent = $fileContent;
                $newExists = true;
            }
        } elseif ($staged) {
            try {
                $newContent = $this->run($root, ['show', ':' . $path], expectExit: [0]);
                $newExists = true;
            } catch (CodiwareException) {
                $newContent = '';
                $newExists = false;
            }
        }

        $oldContent = '';
        $oldExists = false;
        try {
            $oldContent = $this->run($root, ['show', 'HEAD:' . $path], expectExit: [0]);
            $oldExists = true;
        } catch (CodiwareException) {
            $oldContent = '';
            $oldExists = false;
        }

        if ($this->isRasterImagePath($path)) {
            return [
                'type' => 'image',
                'path' => $path,
                'staged' => $staged,
                'old_ref' => 'HEAD',
                'old_image' => $this->imageSide($path, $oldContent, $oldExists),
                'new_image' => $this->imageSide($path, $newContent, $newExists),
            ];
        }

        return [
            'type' => 'text',
            'path' => $path,
            'staged' => $staged,
            'old_ref' => 'HEAD',
            'old' => $oldContent,
            'new' => $newContent,
        ];
    }

    /**
     * Return the last committed author and author time for every line of a text
     * file. `--line-porcelain` repeats metadata for each result line, which
     * keeps parsing deterministic across Git versions and operating systems.
     * Lines Git attributes to the working tree are marked as uncommitted.
     *
     * @return array<int,array{line:int,commit:string,author:string,email:string,time:int,summary:string,uncommitted:bool}>
     */
    public function blame(WorkspaceRoot $root, string $path): array
    {
        $this->requireRepo($root);
        $normalizedPath = trim(str_replace('\\', '/', $path), '/');
        if ($normalizedPath === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }

        $out = $this->run($root, ['blame', '--line-porcelain', '--', $normalizedPath]);
        $result = [];
        $current = null;
        foreach (explode("\n", $out) as $line) {
            // Boundary commits may be prefixed with `^`. If that header is
            // skipped, its following metadata/tab line is accidentally applied
            // to the previous record and every visible annotation is displaced.
            // Accept CRLF output as well so parsing is identical on Windows.
            if (preg_match('/^\^?([0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?\r?$/i', $line, $match) === 1) {
                $current = [
                    'line' => (int)$match[2],
                    'commit' => $match[1],
                    'author' => '',
                    'email' => '',
                    'time' => 0,
                    'summary' => '',
                    'uncommitted' => preg_match('/^0+$/', $match[1]) === 1,
                ];
                continue;
            }
            if ($current === null) {
                continue;
            }
            if (str_starts_with($line, 'author ')) {
                $current['author'] = substr($line, 7);
            } elseif (str_starts_with($line, 'author-mail ')) {
                $current['email'] = trim(substr($line, 12), '<>');
            } elseif (str_starts_with($line, 'author-time ')) {
                $current['time'] = (int)substr($line, 12);
            } elseif (str_starts_with($line, 'summary ')) {
                $current['summary'] = substr($line, 8);
            } elseif (str_starts_with($line, "\t")) {
                $result[] = $current;
                $current = null;
            }
        }

        return $result;
    }

    /**
     * @param string[] $paths
     */
    public function stage(WorkspaceRoot $root, array $paths): void
    {
        $this->requireRepo($root);
        if ($paths === []) {
            return;
        }
        $this->run($root, array_merge(['add', '--'], $paths));
    }

    /**
     * @param string[] $paths
     */
    public function unstage(WorkspaceRoot $root, array $paths): void
    {
        $this->requireRepo($root);
        if ($paths === []) {
            return;
        }
        $this->run($root, array_merge(['reset', 'HEAD', '--'], $paths), expectExit: [0, 1]);
    }

    /**
     * @param string[] $paths
     */
    public function discard(WorkspaceRoot $root, array $paths): void
    {
        $this->requireRepo($root);
        if ($paths === []) {
            return;
        }
        $this->run($root, array_merge(['checkout', '--'], $paths));
    }

    public function commit(WorkspaceRoot $root, string $message, ?string $authorName, ?string $authorEmail, bool $amend = false): array
    {
        $this->requireRepo($root);
        if (trim($message) === '' && !$amend) {
            throw new CodiwareException('Commit message is required.', 'bad_request', 400);
        }
        $args = ['commit'];
        if ($amend) {
            $args[] = '--amend';
            if ($message === '') {
                $args[] = '--no-edit';
            } else {
                $args[] = '-m';
                $args[] = $message;
            }
        } else {
            $args[] = '-m';
            $args[] = $message;
        }
        $authorName = $authorName ?? '';
        $authorEmail = $authorEmail ?? '';
        // Always pass identity via env so git never falls back to local/global config.
        $env = [
            'GIT_AUTHOR_NAME' => $authorName,
            'GIT_AUTHOR_EMAIL' => $authorEmail,
            'GIT_COMMITTER_NAME' => $authorName,
            'GIT_COMMITTER_EMAIL' => $authorEmail,
        ];
        $console = $this->consoleCapture($root, $args, $env);
        if (!$console['ok']) {
            throw $this->consoleFailure('commit', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Push the active branch, publishing it with an upstream when needed.
     *
     * Branches created inside the IDE start as local-only branches. For those
     * branches `git status --branch` reports no upstream, so a plain `git push`
     * would fail. In that state the service pushes with `-u <remote> <branch>`
     * (preferring `origin`) so the local branch is published and future pushes
     * can use the regular upstream-aware command again.
     */
    public function push(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $status = $this->status($root);
        $branch = trim((string)($status['branch'] ?? ''));
        $remote = trim((string)($status['publish_remote'] ?? ''));
        $args = ['push'];
        if (($status['unpublished'] ?? false) === true && $branch !== '' && $remote !== '') {
            $args = ['push', '-u', $remote, $branch];
        }
        $console = $this->consoleCapture($root, $args);
        if (!$console['ok']) {
            throw $this->consoleFailure('push', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    public function pull(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $console = $this->consoleCapture($root, ['pull']);
        if (!$console['ok']) {
            throw $this->consoleFailure('pull', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Refresh all remote-tracking branches and tags without changing the
     * checked-out branch. Pruning removes stale remote branch refs so history
     * and commit containment information reflect the current remote state.
     */
    public function fetch(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $console = $this->consoleCapture($root, ['fetch', '--all', '--tags', '--prune']);
        if (!$console['ok']) {
            throw $this->consoleFailure('fetch', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * @return array{current:?string,locals:string[],remotes:string[]}
     */
    public function branches(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $current = trim($this->run($root, ['rev-parse', '--abbrev-ref', 'HEAD']));
        $locals = array_values(array_filter(array_map('trim', explode("\n", $this->run($root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])))));
        $remotes = array_values(array_filter(
            array_map(
                static fn (string $name): string => trim($name),
                array_filter(
                    explode("\n", $this->run($root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])),
                    static fn (string $name): bool => trim($name) !== '' && trim($name) !== 'origin/HEAD'
                )
            )
        ));
        return [
            'current' => $current !== '' ? $current : null,
            'locals' => $locals,
            'remotes' => $remotes,
        ];
    }

    public function checkout(WorkspaceRoot $root, string $branch, bool $create = false, ?string $startPoint = null): array
    {
        $this->requireRepo($root);
        $target = trim($branch);
        if ($target === '') {
            throw new CodiwareException('branch is required.', 'bad_request', 400);
        }

        if ($create) {
            $args = ['checkout', '-b', $target];
            $start = trim((string)($startPoint ?? ''));
            if ($start !== '') {
                $args[] = $start;
            }
            $console = $this->consoleCapture($root, $args);
            if (!$console['ok']) {
                throw $this->consoleFailure('checkout', $console);
            }
            return ['message' => trim($console['output']), 'console' => $console];
        }

        $plan = $this->resolveCheckoutTarget($root, $target);
        if ($plan['remote'] !== null) {
            $console = $this->consoleCapture(
                $root,
                ['checkout', '--track', '-B', $plan['local'], $plan['remote']]
            );
        } else {
            $console = $this->consoleCapture($root, ['checkout', $plan['local']]);
        }
        if (!$console['ok']) {
            throw $this->consoleFailure('checkout', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Cherry-pick one commit into the currently checked out branch and return
     * the captured CLI block for console injection.
     */
    public function cherryPick(WorkspaceRoot $root, string $commit): array
    {
        $this->requireRepo($root);
        $target = $this->requireCommit($commit);
        $console = $this->consoleCapture($root, ['cherry-pick', $target]);
        if (!$console['ok']) {
            throw $this->consoleFailure('cherry-pick', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Revert one commit on the current branch and return the captured CLI block
     * so the caller can inject the exact git output into the console.
     */
    public function revert(WorkspaceRoot $root, string $commit): array
    {
        $this->requireRepo($root);
        $target = $this->requireCommit($commit);
        $console = $this->consoleCapture($root, ['revert', '--no-edit', $target]);
        if (!$console['ok']) {
            throw $this->consoleFailure('revert', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Merge one commit or branch tip into the current branch. The history panel
     * passes a commit hash here so users can merge the branch state represented
     * by that row without leaving the history workflow.
     */
    public function merge(WorkspaceRoot $root, string $ref): array
    {
        $this->requireRepo($root);
        $target = trim($ref);
        if ($target === '') {
            throw new CodiwareException('ref is required.', 'bad_request', 400);
        }
        $console = $this->consoleCapture($root, ['merge', $target]);
        if (!$console['ok']) {
            throw $this->consoleFailure('merge', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Reset the current branch pointer to one commit using the selected mode.
     * Only the three well-known reset modes are accepted so the API stays
     * explicit and easy to surface in the UI.
     */
    public function reset(WorkspaceRoot $root, string $commit, string $mode): array
    {
        $this->requireRepo($root);
        $target = $this->requireCommit($commit);
        $normalizedMode = strtolower(trim($mode));
        $allowed = ['soft', 'mixed', 'hard'];
        if (!in_array($normalizedMode, $allowed, true)) {
            throw new CodiwareException('reset mode must be one of soft, mixed or hard.', 'bad_request', 400);
        }
        $console = $this->consoleCapture($root, ['reset', '--' . $normalizedMode, $target]);
        if (!$console['ok']) {
            throw $this->consoleFailure('reset', $console);
        }
        return ['message' => trim($console['output']), 'console' => $console];
    }

    /**
     * Read the commit graph for the history panel.
     *
     * Fields are separated by the real ASCII unit-separator byte (0x1F), which
     * git emits via its `%x1f` format escape, so subjects and author names can
     * safely contain any printable character. The `refs` field is parsed from
     * `%D` into typed branch/tag/remote entries so the client can label
     * branches with text instead of relying on color alone.
     *
     * When `$search` is given, the commit list is filtered to rows that match
     * the term (case-insensitive) in any displayed column — subject, author,
     * committer, hash, refs or the formatted dates. The filtering is done in
     * PHP rather than by shelling out to the system `grep`, which is not part
     * of a default Windows installation, so the behaviour is identical on
     * Windows and Linux. Because a filtered list no longer represents a
     * contiguous commit graph, the client hides the branch lanes in this mode.
     *
     * @return array<int,array{hash:string,parents:string[],author:string,email:string,date:int,committer:string,commit_date:int,subject:string,refs:array<int,array{type:string,name:string,current:bool}>}>
     */
    public function history(WorkspaceRoot $root, int $limit, int $skip = 0, string $search = '', string $path = ''): array
    {
        $this->requireRepo($root);
        $us = "\x1f"; // field separator (git %x1f)
        $format = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1f%D';
        // `--all` walks every branch/tag (not just HEAD) so each branch tip is
        // present and carries its `%D` decoration — without it only the current
        // branch is decorated and other lanes get no name. `--date-order` keeps
        // the listing chronological while still never showing a parent before
        // its child, matching the date column in the panel.
        $args = ['log', '--all', '--date-order', '--max-count=' . $limit, '--skip=' . $skip, '--pretty=format:' . $format];
        $path = trim(str_replace('\\', '/', $path), '/');
        if ($path !== '') {
            // The explicit `--` keeps a path beginning with a dash out of Git's
            // option parser. Keep `--all` so file history follows the same
            // repository-wide scope as the regular history panel.
            $args[] = '--';
            $args[] = $path;
        }
        $out = $this->run($root, $args);
        $lines = $out === '' ? [] : explode("\n", $out);
        $rows = [];
        $needle = trim($search);
        $needle = $needle === '' ? '' : mb_strtolower($needle);
        foreach ($lines as $line) {
            if ($line === '') {
                continue;
            }
            $parts = explode($us, $line);
            if (count($parts) < 9) {
                continue;
            }
            $refs = $this->parseRefs($parts[8]);
            $row = [
                'hash' => $parts[0],
                'parents' => $parts[1] === '' ? [] : explode(' ', $parts[1]),
                'author' => $parts[2],
                'email' => $parts[3],
                'date' => (int)$parts[4],
                'committer' => $parts[5],
                'commit_date' => (int)$parts[6],
                'subject' => $parts[7],
                'refs' => $refs,
            ];
            if ($needle !== '' && !$this->historyRowMatches($row, $needle)) {
                continue;
            }
            $rows[] = $row;
        }
        return $rows;
    }

    /**
     * Test whether a history row matches a (already lower-cased) search term in
     * any of its displayed columns: subject, author, committer, hash, ref names
     * and the formatted author/commit dates. Acts as a cross-platform,
     * all-column substitute for piping the log through `grep`.
     */
    private function historyRowMatches(array $row, string $needle): bool
    {
        $haystack = [
            (string)$row['hash'],
            (string)$row['author'],
            (string)$row['email'],
            (string)$row['committer'],
            (string)$row['subject'],
            date('Y-m-d H:i', (int)$row['date']),
            date('Y-m-d H:i', (int)$row['commit_date']),
        ];
        foreach ($row['refs'] as $ref) {
            $haystack[] = (string)($ref['name'] ?? '');
        }
        return mb_strpos(mb_strtolower(implode("\n", $haystack)), $needle) !== false;
    }

    /**
     * Full metadata and changed-file list for a single commit, used by the
     * details pane of the history panel.
     *
     * @return array{hash:string,parents:string[],author:string,email:string,date:int,committer:string,committer_email:string,commit_date:int,subject:string,body:string,refs:array<int,array{type:string,name:string,current:bool}>,branches:string[],files:array<int,array{status:string,path:string,old_path?:string}>}
     */
    public function commitDetails(WorkspaceRoot $root, string $commit): array
    {
        $this->requireRepo($root);
        $us = "\x1f";
        // Body (%b) is placed last because it may span multiple lines.
        $format = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s%x1f%b';
        $metaOut = $this->run($root, ['show', '-s', '--pretty=format:' . $format, $commit]);
        $parts = explode($us, $metaOut);
        if (count($parts) < 11) {
            throw new CodiwareException('Commit not found: ' . $commit, 'not_found', 404);
        }
        return [
            'hash' => $parts[0],
            'parents' => $parts[1] === '' ? [] : explode(' ', $parts[1]),
            'author' => $parts[2],
            'email' => $parts[3],
            'date' => (int)$parts[4],
            'committer' => $parts[5],
            'committer_email' => $parts[6],
            'commit_date' => (int)$parts[7],
            'refs' => $this->parseRefs($parts[8]),
            'subject' => $parts[9],
            'body' => rtrim($parts[10] ?? '', "\n"),
            'branches' => $this->commitBranches($root, $commit),
            'files' => $this->commitFiles($root, $commit),
        ];
    }

    /**
     * List local and remote-tracking branches that contain the given commit.
     * Symbolic remote HEAD aliases are omitted because they duplicate a real
     * remote branch and do not represent an independently useful branch.
     *
     * @return string[]
     */
    public function commitBranches(WorkspaceRoot $root, string $commit): array
    {
        $out = $this->run($root, ['branch', '--all', '--contains', $commit, '--format=%(refname:short)']);
        $branches = [];
        foreach (explode("\n", trim($out)) as $line) {
            $name = trim($line);
            if ($name !== '' && !str_ends_with($name, '/HEAD')) {
                $branches[] = $name;
            }
        }
        return array_values(array_unique($branches));
    }

    /**
     * List files changed by a commit relative to its first parent. The root
     * commit is handled via `--root` so its initial files are reported too.
     *
     * @return array<int,array{status:string,path:string,old_path?:string}>
     */
    public function commitFiles(WorkspaceRoot $root, string $commit): array
    {
        $out = $this->run($root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '--root', $commit]);
        $files = [];
        foreach (explode("\n", trim($out)) as $line) {
            if ($line === '') {
                continue;
            }
            $cols = preg_split('/\t/', $line) ?: [];
            $status = $cols[0] ?? '';
            $code = $status === '' ? '' : $status[0];
            if (($code === 'R' || $code === 'C') && isset($cols[2])) {
                $files[] = ['status' => $code, 'old_path' => $cols[1], 'path' => $cols[2]];
            } elseif (isset($cols[1])) {
                $files[] = ['status' => $code, 'path' => $cols[1]];
            }
        }
        return $files;
    }

    /**
     * Build the two sides of a diff for a single file introduced by a commit:
     * the parent version (`old`) and the committed version (`new`). Missing
     * sides (added/deleted files, root commit) resolve to empty strings so the
     * diff editor can render additions and deletions cleanly. Raster images are
     * returned as base64 data URLs instead of raw binary strings.
     *
     * @return array<string,mixed>
     */
    public function commitFileDiff(WorkspaceRoot $root, string $commit, string $path, ?string $oldPath = null): array
    {
        $this->requireRepo($root);
        $parentPath = $oldPath !== null && $oldPath !== '' ? $oldPath : $path;
        $new = '';
        $newExists = false;
        try {
            $new = $this->run($root, ['show', $commit . ':' . $path]);
            $newExists = true;
        } catch (CodiwareException) {
            $new = '';
            $newExists = false;
        }
        $old = '';
        $oldExists = false;
        try {
            $old = $this->run($root, ['show', $commit . '^:' . $parentPath]);
            $oldExists = true;
        } catch (CodiwareException) {
            $old = '';
            $oldExists = false;
        }

        if ($this->isRasterImagePath($path) || $this->isRasterImagePath($parentPath)) {
            return [
                'type' => 'image',
                'path' => $path,
                'old_image' => $this->imageSide($parentPath, $old, $oldExists),
                'new_image' => $this->imageSide($path, $new, $newExists),
            ];
        }

        return ['type' => 'text', 'path' => $path, 'old' => $old, 'new' => $new];
    }

    public function show(WorkspaceRoot $root, string $commit, string $path): string
    {
        $this->requireRepo($root);
        return $this->run($root, ['show', $commit . ':' . $path]);
    }

    /**
     * Parse the `%D` ref decoration string (e.g. `HEAD -> main, origin/main,
     * tag: v1.0`) into typed entries. Keeping the typing on the server lets the
     * client render branch and tag labels without re-parsing git output.
     *
     * @return array<int,array{type:string,name:string,current:bool}>
     */
    private function parseRefs(string $decoration): array
    {
        $decoration = trim($decoration);
        if ($decoration === '') {
            return [];
        }
        $refs = [];
        foreach (explode(',', $decoration) as $token) {
            $token = trim($token);
            if ($token === '') {
                continue;
            }
            if (str_starts_with($token, 'HEAD -> ')) {
                $refs[] = ['type' => 'branch', 'name' => trim(substr($token, 8)), 'current' => true];
            } elseif ($token === 'HEAD') {
                $refs[] = ['type' => 'head', 'name' => 'HEAD', 'current' => true];
            } elseif (str_starts_with($token, 'tag: ')) {
                $refs[] = ['type' => 'tag', 'name' => trim(substr($token, 5)), 'current' => false];
            } elseif (str_contains($token, '/')) {
                $refs[] = ['type' => 'remote', 'name' => $token, 'current' => false];
            } else {
                $refs[] = ['type' => 'branch', 'name' => $token, 'current' => false];
            }
        }
        return $refs;
    }

    /**
     * Add branch publication metadata to the parsed porcelain status.
     *
     * Git reports ahead/behind counters only when the current branch has an
     * upstream. A newly created local branch has no upstream yet, so the UI
     * would otherwise see `ahead: 0` and keep the push button passive even after
     * commits exist. This derived state lets the UI and push command treat that
     * case as publishable work.
     *
     * @param array<string,mixed> $status
     * @return array<string,mixed>
     */
    private function enrichPublicationState(WorkspaceRoot $root, array $status): array
    {
        $branch = trim((string)($status['branch'] ?? ''));
        $upstream = trim((string)($status['upstream'] ?? ''));
        $unpublished = $branch !== '' && $upstream === '';
        $status['unpublished'] = $unpublished;
        $status['publish_remote'] = $unpublished ? $this->defaultRemote($root) : null;
        return $status;
    }

    /**
     * Return the remote used when publishing a branch, preferring `origin`.
     */
    private function defaultRemote(WorkspaceRoot $root): ?string
    {
        $remotes = array_values(array_filter(array_map('trim', explode("\n", $this->run($root, ['remote'])))));
        if ($remotes === []) {
            return null;
        }
        return in_array('origin', $remotes, true) ? 'origin' : $remotes[0];
    }

    /**
     * Decide whether a checkout target is a local branch or a remote-tracking
     * ref and map remote refs like `origin/1.x-dev` to their local tracking
     * branch name (`1.x-dev`).
     *
     * @return array{requested:string,local:string,remote:?string}
     */
    private function resolveCheckoutTarget(WorkspaceRoot $root, string $branch): array
    {
        $requested = trim($branch);
        $locals = $this->branchNames($root, 'refs/heads');
        if (in_array($requested, $locals, true)) {
            return ['requested' => $requested, 'local' => $requested, 'remote' => null];
        }

        $remotes = $this->branchNames($root, 'refs/remotes');
        if (in_array($requested, $remotes, true)) {
            return [
                'requested' => $requested,
                'local' => $this->localNameFromRemote($requested),
                'remote' => $requested,
            ];
        }

        return ['requested' => $requested, 'local' => $requested, 'remote' => null];
    }

    /**
     * Read branch names from one git ref namespace and strip empty rows plus
     * symbolic remote HEAD aliases such as `origin/HEAD`.
     *
     * @return string[]
     */
    private function branchNames(WorkspaceRoot $root, string $refPrefix): array
    {
        return array_values(array_filter(
            array_map('trim', explode("\n", $this->run($root, ['for-each-ref', '--format=%(refname:short)', $refPrefix]))),
            static fn (string $name): bool => $name !== '' && !str_ends_with($name, '/HEAD')
        ));
    }

    /**
     * Convert a remote-tracking ref like `origin/feature/x` to the matching
     * local branch name `feature/x`.
     */
    private function localNameFromRemote(string $remoteRef): string
    {
        $parts = explode('/', $remoteRef, 2);
        return $parts[1] ?? $remoteRef;
    }

    /**
     * Validate and normalize one commit-ish identifier used by destructive
     * history actions. Keeping this separate makes controller error messages
     * consistent and prevents empty strings from reaching the git process.
     */
    private function requireCommit(string $commit): string
    {
        $target = trim($commit);
        if ($target === '') {
            throw new CodiwareException('commit is required.', 'bad_request', 400);
        }
        return $target;
    }

    /**
     * Determine whether a path should be rendered by the image diff editor.
     */
    private function isRasterImagePath(string $path): bool
    {
        return preg_match('/\.(png|jpe?g|gif|webp|bmp)$/i', $path) === 1;
    }

    /**
     * Resolve the browser MIME type used in image diff data URLs.
     */
    private function imageMime(string $path): string
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        return match ($ext) {
            'jpg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'bmp' => 'image/bmp',
            default => 'image/png',
        };
    }

    /**
     * Convert one optional image blob to the JSON-safe shape used by the client.
     *
     * @return array{exists:bool,mime:string,src:?string,size:int}
     */
    private function imageSide(string $path, string $content, bool $exists): array
    {
        $mime = $this->imageMime($path);
        if (!$exists) {
            return ['exists' => false, 'mime' => $mime, 'src' => null, 'size' => 0];
        }
        return [
            'exists' => true,
            'mime' => $mime,
            'src' => 'data:' . $mime . ';base64,' . base64_encode($content),
            'size' => strlen($content),
        ];
    }

    /**
     * Run a git command capturing its combined, colored output for display in
     * the console. Unlike {@see run()} this never throws on a non-zero exit so
     * callers can decide how to surface failures while still echoing the CLI
     * output to the user.
     *
     * @param string[] $args
     * @param array<string,string> $env
     * @return array{command:string,output:string,exit_code:int,ok:bool}
     */
    private function consoleCapture(WorkspaceRoot $root, array $args, array $env = []): array
    {
        // Force color the same way the console does for typed git commands.
        $colored = array_merge(['-c', 'color.ui=always'], $args);
        $process = new Process(array_merge([$this->binary], $colored), $root->path, $env === [] ? null : $env);
        $process->setTimeout(60);
        $process->run();
        $exit = (int)($process->getExitCode() ?? -1);
        return [
            'command' => $this->colorNormalizer->normalize(implode(' ', array_merge([$this->binary], $args))),
            'output' => $process->getOutput() . $process->getErrorOutput(),
            'exit_code' => $exit,
            'ok' => $exit === 0,
        ];
    }

    /**
     * Build the exception for a failed console-captured git command. The raw CLI
     * output is attached as a `console` detail so the front-end can inject it
     * into the console and auto-open it, while server-side logging is preserved.
     *
     * @param array{command:string,output:string,exit_code:int,ok:bool} $console
     */
    private function consoleFailure(string $operation, array $console): CodiwareException
    {
        $this->logger->warning('git command failed', [
            'cmd' => $console['command'],
            'exit' => $console['exit_code'],
            'output' => $console['output'],
        ]);
        $detail = trim($console['output']);
        return new CodiwareException(
            'git ' . $operation . ' failed: ' . ($detail !== '' ? $detail : 'exit ' . $console['exit_code']),
            'git_failed',
            500,
            ['exit' => $console['exit_code'], 'console' => $console]
        );
    }

    /**
     * @param string[] $args
     * @param array<string,string> $env
     * @param int[] $expectExit
     */
    private function run(WorkspaceRoot $root, array $args, array $env = [], array $expectExit = [0]): string
    {
        $cmd = array_merge([$this->binary], $args);
        $process = new Process($cmd, $root->path, $env === [] ? null : $env);
        $process->setTimeout(60);
        $process->run();
        if (!in_array($process->getExitCode(), $expectExit, true)) {
            $stderr = trim($process->getErrorOutput());
            $this->logger->warning('git command failed', [
                'cmd' => implode(' ', $cmd),
                'cwd' => $root->path,
                'exit' => $process->getExitCode(),
                'stderr' => $stderr,
            ]);
            throw new CodiwareException(
                'git ' . ($args[0] ?? '') . ' failed: ' . ($stderr !== '' ? $stderr : 'exit ' . $process->getExitCode()),
                'git_failed',
                500,
                ['stderr' => $stderr, 'exit' => $process->getExitCode()]
            );
        }
        return $process->getOutput();
    }

    /**
     * Parse `git status --porcelain=v2 --branch -z` output.
     */
    private function parseStatusV2(string $out): array
    {
        $branch = null;
        $upstream = null;
        $ahead = 0;
        $behind = 0;
        $files = [];

        // -z uses NUL separators. Renamed entries (2) have an extra NUL for the source path.
        $records = explode("\x00", $out);
        $i = 0;
        $count = count($records);
        while ($i < $count) {
            $rec = $records[$i];
            if ($rec === '') {
                $i++;
                continue;
            }
            if (str_starts_with($rec, '# ')) {
                if (str_starts_with($rec, '# branch.head ')) {
                    $branch = trim(substr($rec, 14));
                    if ($branch === '(detached)') {
                        $branch = null;
                    }
                } elseif (str_starts_with($rec, '# branch.upstream ')) {
                    $upstream = trim(substr($rec, 18));
                } elseif (str_starts_with($rec, '# branch.ab ')) {
                    if (preg_match('/\+(-?\d+)\s+-(\d+)/', $rec, $m) === 1) {
                        $ahead = (int)$m[1];
                        $behind = (int)$m[2];
                    }
                }
                $i++;
                continue;
            }
            $marker = $rec[0];
            if ($marker === '?') {
                // "? path". Status is called with --untracked-files=all, so
                // paths here are concrete files, not synthetic untracked folders.
                $path = substr($rec, 2);
                $files[] = $this->file($path, '?', '?', staged: false, changed: false, untracked: true, conflict: false);
                $i++;
                continue;
            }
            if ($marker === '1') {
                // "1 XY sub mh mi mw hH hI path"
                $parts = explode(' ', $rec, 9);
                $xy = $parts[1] ?? '..';
                $path = $parts[8] ?? '';
                $X = $xy[0] ?? '.';
                $Y = $xy[1] ?? '.';
                $files[] = $this->file($path, $X, $Y, staged: $X !== '.', changed: $Y !== '.', untracked: false, conflict: false);
                $i++;
                continue;
            }
            if ($marker === '2') {
                // "2 XY sub mh mi mw hH hI rcX path\0origPath"
                $parts = explode(' ', $rec, 10);
                $xy = $parts[1] ?? '..';
                $path = $parts[9] ?? '';
                $X = $xy[0] ?? '.';
                $Y = $xy[1] ?? '.';
                $orig = $records[$i + 1] ?? null;
                $i += 2;
                $files[] = $this->file($path, $X, $Y, staged: $X !== '.', changed: $Y !== '.', untracked: false, conflict: false, renamedFrom: $orig);
                continue;
            }
            if ($marker === 'u') {
                // unmerged
                $parts = explode(' ', $rec, 11);
                $path = $parts[10] ?? '';
                $files[] = $this->file($path, 'U', 'U', staged: false, changed: true, untracked: false, conflict: true);
                $i++;
                continue;
            }
            $i++;
        }

        $clean = $files === [];
        return [
            'branch' => $branch,
            'upstream' => $upstream,
            'ahead' => $ahead,
            'behind' => $behind,
            'clean' => $clean,
            'files' => $files,
        ];
    }

    private function file(string $path, string $X, string $Y, bool $staged, bool $changed, bool $untracked, bool $conflict, ?string $renamedFrom = null): array
    {
        return [
            'path' => $path,
            'index' => $X,
            'worktree' => $Y,
            'staged' => $staged,
            'changed' => $changed,
            'untracked' => $untracked,
            'conflict' => $conflict,
            'renamed_from' => $renamedFrom,
        ];
    }
}
