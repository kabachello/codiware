<?php
declare(strict_types=1);

namespace Codiware\Controller;

use Codiware\Exception\CodiwareException;
use Codiware\Http\Responses;
use Codiware\Service\SearchService;
use Codiware\Workspace\PathGuard;
use Codiware\Workspace\WorkspaceResolver;
use Codiware\Workspace\WorkspaceRoot;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * REST endpoints for workspace-wide search and search-and-replace.
 */
final class SearchController
{
    public function __construct(
        private readonly Responses $responses,
        private readonly WorkspaceResolver $resolver,
        private readonly PathGuard $guard,
        private readonly SearchService $search
    ) {
    }

    public function search(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $query = (string)($q['q'] ?? '');
        $regex = $this->bool($q['regex'] ?? false);
        $cs = $this->bool($q['case'] ?? false);
        $sub = isset($q['path']) ? (string)$q['path'] : null;
        $limit = max(1, min(5000, (int)($q['limit'] ?? 1000)));
        $maxFiles = max(1, min(5000, (int)($q['max_files'] ?? 500)));
        return $this->responses->ok($this->search->search($root, $query, $regex, $cs, $sub, $limit, $maxFiles));
    }

    public function replace(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $query = (string)($body['q'] ?? '');
        $replacement = (string)($body['replacement'] ?? '');
        $regex = $this->bool($body['regex'] ?? false);
        $cs = $this->bool($body['case'] ?? false);
        $sub = isset($body['path']) ? (string)$body['path'] : null;
        $apply = $this->bool($body['apply'] ?? false);
        $maxFiles = max(1, min(5000, (int)($body['max_files'] ?? 500)));
        return $this->responses->ok($this->search->replace($root, $query, $replacement, $regex, $cs, $sub, $apply, $maxFiles));
    }

    private function bool(mixed $v): bool
    {
        if (is_bool($v)) {
            return $v;
        }
        return in_array(strtolower((string)$v), ['1', 'true', 'yes', 'on'], true);
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
