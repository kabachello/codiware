<?php
declare(strict_types=1);

namespace kabachello\Codiware\Controller;

use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Http\Responses;
use kabachello\Codiware\Service\ConsoleService;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceResolver;
use kabachello\Codiware\Workspace\WorkspaceRoot;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * REST endpoints for the in-IDE console.
 */
final class ConsoleController
{
    public function __construct(
        private readonly Responses $responses,
        private readonly WorkspaceResolver $resolver,
        private readonly PathGuard $guard,
        private readonly ConsoleService $console
    ) {
    }

    public function presets(ServerRequestInterface $request): ResponseInterface
    {
        return $this->responses->ok(['presets' => $this->console->presets()]);
    }

    public function run(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $command = (string)($body['command'] ?? '');
        $preset = isset($body['preset']) ? (string)$body['preset'] : null;
        return $this->responses->ok($this->console->run($root, $command, $preset));
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
