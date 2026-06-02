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

    public function __construct(
        private readonly CodiwareConfig $config,
        private readonly LoggerInterface $logger
    ) {
        $this->binary = (string)($config->get('GIT.BINARY', 'git') ?? 'git');
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
        if ($authorName !== null && $authorName !== '' && $authorEmail !== null && $authorEmail !== '') {
            $args[] = '--author=' . $authorName . ' <' . $authorEmail . '>';
        }
        $env = [];
        if ($authorName !== null && $authorEmail !== null) {
            $env['GIT_AUTHOR_NAME'] = $authorName;
            $env['GIT_AUTHOR_EMAIL'] = $authorEmail;
            $env['GIT_COMMITTER_NAME'] = $authorName;
            $env['GIT_COMMITTER_EMAIL'] = $authorEmail;
        }
        $out = $this->run($root, $args, env: $env);
        return ['message' => trim($out)];
    }

    public function push(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $out = $this->run($root, ['push'], expectExit: [0]);
        return ['message' => trim($out)];
    }

    public function pull(WorkspaceRoot $root): array
    {
        $this->requireRepo($root);
        $out = $this->run($root, ['pull'], expectExit: [0]);
        return ['message' => trim($out)];
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
        $out = $this->run($root, $args);
        return ['message' => trim($out)];
    }

    /**
     * @return array<int,array{hash:string,parents:string[],author:string,email:string,date:int,subject:string}>
     */
    public function history(WorkspaceRoot $root, int $limit, int $skip = 0): array
    {
        $this->requireRepo($root);
        $sep = '\x1f';
        $format = '%H' . $sep . '%P' . $sep . '%an' . $sep . '%ae' . $sep . '%at' . $sep . '%s';
        $args = ['log', '--max-count=' . $limit, '--skip=' . $skip, '--pretty=format:' . $format];
        $out = $this->run($root, $args);
        $lines = $out === '' ? [] : explode("\n", $out);
        $rows = [];
        foreach ($lines as $line) {
            $parts = explode("\x1f", $line);
            if (count($parts) < 6) {
                continue;
            }
            $rows[] = [
                'hash' => $parts[0],
                'parents' => $parts[1] === '' ? [] : explode(' ', $parts[1]),
                'author' => $parts[2],
                'email' => $parts[3],
                'date' => (int)$parts[4],
                'subject' => $parts[5],
            ];
        }
        return $rows;
    }

    public function show(WorkspaceRoot $root, string $commit, string $path): string
    {
        $this->requireRepo($root);
        return $this->run($root, ['show', $commit . ':' . $path]);
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
