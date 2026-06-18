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
        if ($branch === '') {
            throw new CodiwareException('branch is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->checkout($root, $branch, $create));
    }

    public function history(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $limit = max(1, min(500, (int)($q['limit'] ?? 100)));
        $skip = max(0, (int)($q['skip'] ?? 0));
        return $this->responses->ok([
            'commits' => $this->git->history($root, $limit, $skip),
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

    /**
     * Full metadata and changed-file list for a single commit.
     */
    public function commitDetails(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $commit = (string)($request->getQueryParams()['commit'] ?? '');
        if ($commit === '') {
            throw new CodiwareException('commit is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->git->commitDetails($root, $commit));
    }

    /**
     * Diff of a single file introduced by a commit (commit vs its parent).
     */
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
