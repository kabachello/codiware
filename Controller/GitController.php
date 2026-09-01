<?php
declare(strict_types=1);

namespace kabachello\Codiware\Controller;

use kabachello\Codiware\Middleware\UserContext;
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Http\Responses;
use kabachello\Codiware\Service\GitService;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceResolver;
use kabachello\Codiware\Workspace\WorkspaceRoot;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Symfony\Component\Process\Process;

/**
 * REST endpoints wrapping `GitService`.
 *
 * Author/committer identity for commits is always taken from the
 * host-provided `UserContext`.
 */
final class GitController
{
    public function __construct(
        private readonly Responses $responses,
        private readonly WorkspaceResolver $resolver,
        private readonly PathGuard $guard,
        private readonly GitService $git,
        private readonly UserContext $user
    ) {
    }

    public function status(ServerRequestInterface $request): ResponseInterface
    {
        return $this->responses->ok($this->git->status($this->root($request)));
    }

    public function diff(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $path = (string)($q['path'] ?? '');
        $staged = isset($q['staged']) && in_array($q['staged'], ['1', 'true', 'yes'], true);
        if ($path === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->diff($root, $path, $staged));
    }

    public function stage(ServerRequestInterface $request): ResponseInterface
    {
        [$root, $paths] = $this->rootAndPaths($request);
        $this->git->stage($root, $paths);
        return $this->responses->ok(['staged' => $paths]);
    }

    public function unstage(ServerRequestInterface $request): ResponseInterface
    {
        [$root, $paths] = $this->rootAndPaths($request);
        $this->git->unstage($root, $paths);
        return $this->responses->ok(['unstaged' => $paths]);
    }

    public function discard(ServerRequestInterface $request): ResponseInterface
    {
        [$root, $paths] = $this->rootAndPaths($request);
        $this->git->discard($root, $paths);
        return $this->responses->ok(['discarded' => $paths]);
    }

    public function commit(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $message = (string)($body['message'] ?? '');
        return $this->responses->ok($this->git->commit($root, $message, $this->user->name, $this->user->email));
    }

    public function amend(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $message = (string)($body['message'] ?? '');
        return $this->responses->ok($this->git->commit($root, $message, $this->user->name, $this->user->email, amend: true));
    }

    public function push(ServerRequestInterface $request): ResponseInterface
    {
        return $this->responses->ok($this->git->push($this->root($request)));
    }

    public function pull(ServerRequestInterface $request): ResponseInterface
    {
        return $this->responses->ok($this->git->pull($this->root($request)));
    }

    public function fetch(ServerRequestInterface $request): ResponseInterface
    {
        return $this->responses->ok($this->git->fetch($this->root($request)));
    }

    public function branches(ServerRequestInterface $request): ResponseInterface
    {
        return $this->responses->ok($this->git->branches($this->root($request)));
    }

    public function checkout(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $branch = (string)($body['branch'] ?? '');
        $create = (bool)($body['create'] ?? false);
        $startPoint = isset($body['start_point']) ? (string)$body['start_point'] : null;
        if ($branch === '') {
            throw new CodiwareException('branch is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->checkout($root, $branch, $create, $startPoint));
    }

    /**
     * Delete one branch selected from the branch chooser and return a console block.
     *
     * Local branches use `git branch -d`. Remote rows are sent as their visible
     * tracking ref (for example `origin/feature/demo`) and are translated to
     * `git push origin --delete feature/demo` without invoking a shell.
     */
    public function deleteBranch(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $branch = trim((string)($body['branch'] ?? ''));
        $remote = (bool)($body['remote'] ?? false);
        if ($branch === '') {
            throw new CodiwareException('branch is required.', 'bad_request', 400);
        }

        if ($remote) {
            [$remoteName, $remoteBranch] = $this->splitRemoteBranch($branch);
            $args = ['push', $remoteName, '--delete', $remoteBranch];
        } else {
            $args = ['branch', '-d', $branch];
        }

        $console = $this->captureGitConsole($root, $args);
        if (!$console['ok']) {
            throw new CodiwareException(
                'git delete branch failed: ' . (trim($console['output']) !== '' ? trim($console['output']) : 'exit ' . $console['exit_code']),
                'git_failed',
                500,
                ['exit' => $console['exit_code'], 'console' => $console]
            );
        }

        return $this->responses->ok([
            'branch' => $branch,
            'remote' => $remote,
            'message' => trim($console['output']),
            'console' => $console,
        ]);
    }

    public function cherryPick(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $commit = (string)($body['commit'] ?? '');
        if ($commit === '') {
            throw new CodiwareException('commit is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->cherryPick($root, $commit));
    }

    public function revert(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $commit = (string)($body['commit'] ?? '');
        if ($commit === '') {
            throw new CodiwareException('commit is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->revert($root, $commit));
    }

    public function merge(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $ref = (string)($body['ref'] ?? $body['commit'] ?? '');
        if ($ref === '') {
            throw new CodiwareException('ref is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->merge($root, $ref));
    }

    public function reset(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $commit = (string)($body['commit'] ?? '');
        $mode = (string)($body['mode'] ?? '');
        if ($commit === '' || $mode === '') {
            throw new CodiwareException('commit and mode are required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->reset($root, $commit, $mode));
    }

    public function history(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $limit = max(1, min(500, (int)($q['limit'] ?? 100)));
        $skip = max(0, (int)($q['skip'] ?? 0));
        $search = trim((string)($q['search'] ?? ''));
        $path = trim((string)($q['path'] ?? ''));
        if ($path !== '') {
            // File-history paths use the same workspace isolation and deny rules
            // as file APIs. The file may currently be deleted, therefore only
            // its existing parent is required here.
            $path = $this->guard->relativize($root, $this->guard->resolveInside($root, $path, false));
        }
        return $this->responses->ok([
            'commits' => $this->git->history($root, $limit, $skip, $search, $path),
            'path' => $path !== '' ? $path : null,
        ]);
    }

    public function show(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $commit = (string)($q['commit'] ?? '');
        $path = (string)($q['path'] ?? '');
        if ($commit === '' || $path === '') {
            throw new CodiwareException('commit and path are required.', 'bad_request', 400);
        }
        return $this->responses->ok([
            'commit' => $commit,
            'path' => $path,
            'content' => $this->git->show($root, $commit, $path),
        ]);
    }

    /** Full metadata and changed-file list for a single commit. */
    public function commitDetails(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $commit = (string)($request->getQueryParams()['commit'] ?? '');
        if ($commit === '') {
            throw new CodiwareException('commit is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->commitDetails($root, $commit));
    }

    /** Diff of a single file introduced by a commit (commit vs its parent). */
    public function commitDiff(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $commit = (string)($q['commit'] ?? '');
        $path = (string)($q['path'] ?? '');
        $oldPath = isset($q['old_path']) ? (string)$q['old_path'] : null;
        if ($commit === '' || $path === '') {
            throw new CodiwareException('commit and path are required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->commitFileDiff($root, $commit, $path, $oldPath));
    }

    /**
     * Split a visible remote-tracking branch name into remote name and branch name.
     *
     * @return array{0:string,1:string}
     */
    private function splitRemoteBranch(string $branch): array
    {
        $parts = explode('/', $branch, 2);
        if (count($parts) !== 2 || trim($parts[0]) === '' || trim($parts[1]) === '') {
            throw new CodiwareException('remote branch must have the form remote/name.', 'bad_request', 400);
        }
        return [$parts[0], $parts[1]];
    }

    /**
     * Run a git command via argument arrays and return the console-injection block.
     *
     * @param string[] $args
     * @return array{command:string,output:string,exit_code:int,ok:bool}
     */
    private function captureGitConsole(WorkspaceRoot $root, array $args): array
    {
        $process = new Process(array_merge(['git', '-c', 'color.ui=always'], $args), $root->path, [
            'FORCE_COLOR' => '1',
            'TERM' => 'xterm-256color',
        ]);
        $process->setTimeout(60);
        $process->run();
        $exit = (int)($process->getExitCode() ?? -1);
        return [
            'command' => 'git ' . implode(' ', $args),
            'output' => $process->getOutput() . $process->getErrorOutput(),
            'exit_code' => $exit,
            'ok' => $exit === 0,
        ];
    }

    /**
     * @return array{0:WorkspaceRoot,1:string[]}
     */
    private function rootAndPaths(ServerRequestInterface $request): array
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $paths = $body['paths'] ?? [];
        if (!is_array($paths)) {
            throw new CodiwareException('paths must be an array.', 'bad_request', 400);
        }
        $paths = array_values(array_filter(array_map('strval', $paths), fn($p) => $p !== ''));
        if ($paths === []) {
            throw new CodiwareException('At least one path is required.', 'bad_request', 400);
        }
        return [$root, $paths];
    }

    private function root(ServerRequestInterface $request): WorkspaceRoot
    {
        $alias = (string)($request->getQueryParams()['root'] ?? '');
        if ($alias === '') {
            throw new CodiwareException('?root= parameter is required.', 'bad_request', 400);
        }
        return $this->resolver->rootByAlias($alias);
    }

    private function decodeJson(ServerRequestInterface $request): array
    {
        $body = (string)$request->getBody();
        if ($body === '') {
            return [];
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            throw new CodiwareException('Request body must be JSON object.', 'bad_request', 400);
        }
        return $decoded;
    }
}
