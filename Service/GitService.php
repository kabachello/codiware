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
     * @return array{branch:?string,upstream:?string,ahead:int,behind:int,clean:bool,files:array<int,array{path:string,index:string,worktree:string,staged:bool,changed:bool,untracked:bool,conflict:bool,renamed_from:?string}>}
     */
    public function status(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        // -z separator avoids quoting issues for paths with spaces/utf-8.
        $out = $this->run($root, ['status', '--porcelain=v2', '--branch', '-z']);
        return $this->parseStatusV2($out);
    }

    /**
     * @return array{old:string,new:string,old_ref:string,path:string,staged:bool}
     */
    public function diff(WorkspaceRoot $root, string $path, bool $staged = false): array
    {
        $this->requireRepo($root);
        $absPath = $root->path . DIRECTORY_SEPARATOR . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);
        $oldRef = $staged ? 'HEAD' : ':0'; // :0 = index version
        $newContent = '';
        if (!$staged && is_file($absPath)) {
            $newContent = (string)@file_get_contents($absPath);
        } elseif ($staged) {
            // For staged diffs, "new" is what's in the index.
            try {
                $newContent = $this->run($root, ['show', ':' . $path], expectExit: [0]);
            } catch (CodiwareException) {
                $newContent = '';
            }
        }
        $oldContent = '';
        try {
            $oldContent = $this->run($root, ['show', 'HEAD:' . $path], expectExit: [0]);
        } catch (CodiwareException) {
            $oldContent = '';
        }
        return [
            'path' => $path,
            'staged' => $staged,
            'old_ref' => 'HEAD',
            'old' => $oldContent,
            'new' => $newContent,
        ];
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

    public function push(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $console = $this->consoleCapture($root, ['push']);
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
     * @return array{current:?string,locals:string[],remotes:string[]}
     */
    public function branches(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $current = trim($this->run($root, ['rev-parse', '--abbrev-ref', 'HEAD']));
        $locals = array_values(array_filter(array_map('trim', explode("\n", $this->run($root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])))));
        $remotes = array_values(array_filter(array_map('trim', explode("\n", $this->run($root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])))));
        return [
            'current' => $current !== '' ? $current : null,
            'locals' => $locals,
            'remotes' => $remotes,
        ];
    }

    public function checkout(WorkspaceRoot $root, string $branch, bool $create = false): array
    {
        $this->requireRepo($root);
        $args = ['checkout'];
        if ($create) {
            $args[] = '-b';
        }
        $args[] = $branch;
        $console = $this->consoleCapture($root, $args);
        if (!$console['ok']) {
            throw $this->consoleFailure('checkout', $console);
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
     * @return array<int,array{hash:string,parents:string[],author:string,email:string,date:int,committer:string,commit_date:int,subject:string,refs:array<int,array{type:string,name:string,current:bool}>}>
     */
    public function history(WorkspaceRoot $root, int $limit, int $skip = 0): array
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
        $out = $this->run($root, $args);
        $lines = $out === '' ? [] : explode("\n", $out);
        $rows = [];
        foreach ($lines as $line) {
            if ($line === '') {
                continue;
            }
            $parts = explode($us, $line);
            if (count($parts) < 9) {
                continue;
            }
            $rows[] = [
                'hash' => $parts[0],
                'parents' => $parts[1] === '' ? [] : explode(' ', $parts[1]),
                'author' => $parts[2],
                'email' => $parts[3],
                'date' => (int)$parts[4],
                'committer' => $parts[5],
                'commit_date' => (int)$parts[6],
                'subject' => $parts[7],
                'refs' => $this->parseRefs($parts[8]),
            ];
        }
        return $rows;
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
     * List the local branches that contain the given commit, i.e. branches from
     * whose tip the commit is reachable (`git branch --contains`). Used by the
     * details pane to show where a commit currently lives.
     *
     * @return string[]
     */
    public function commitBranches(WorkspaceRoot $root, string $commit): array
    {
        $out = $this->run($root, ['branch', '--contains', $commit, '--format=%(refname:short)']);
        $branches = [];
        foreach (explode("\n", trim($out)) as $line) {
            $name = trim($line);
            if ($name !== '') {
                $branches[] = $name;
            }
        }
        return $branches;
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
     * diff editor can render additions and deletions cleanly.
     *
     * @return array{path:string,old:string,new:string}
     */
    public function commitFileDiff(WorkspaceRoot $root, string $commit, string $path, ?string $oldPath = null): array
    {
        $this->requireRepo($root);
        $parentPath = $oldPath !== null && $oldPath !== '' ? $oldPath : $path;
        $new = '';
        try {
            $new = $this->run($root, ['show', $commit . ':' . $path]);
        } catch (CodiwareException) {
            $new = '';
        }
        $old = '';
        try {
            $old = $this->run($root, ['show', $commit . '^:' . $parentPath]);
        } catch (CodiwareException) {
            $old = '';
        }
        return ['path' => $path, 'old' => $old, 'new' => $new];
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
                    if (preg_match('/\+(-?\d+)\s+-(-?\d+)/', $rec, $m) === 1) {
                        $ahead = (int)$m[1];
                        $behind = (int)$m[2];
                    }
                }
                $i++;
                continue;
            }
            $marker = $rec[0];
            if ($marker === '?') {
                // "? path"
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
