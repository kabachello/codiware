<?php
declare(strict_types=1);

namespace kabachello\Codiware\Middleware;

use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Middleware\UserContext;
use kabachello\Codiware\Controller\AssetController;
use kabachello\Codiware\Controller\ConfigController;
use kabachello\Codiware\Controller\ConsoleController;
use kabachello\Codiware\Controller\FileController;
use kabachello\Codiware\Controller\GitController;
use kabachello\Codiware\Controller\SearchController;
use kabachello\Codiware\Controller\ShellController;
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Http\Responses;
use kabachello\Codiware\Http\Router;
use kabachello\Codiware\Service\ConsoleService;
use kabachello\Codiware\Service\FileService;
use kabachello\Codiware\Service\GitColorNormalizer;
use kabachello\Codiware\Service\GitService;
use kabachello\Codiware\Service\SearchService;
use kabachello\Codiware\Service\TranslationService;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceResolver;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\StreamFactoryInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * PSR-15 middleware that handles all requests under the configured base path
 * (default: `/codiware`). Any request whose URI path is not under the base path
 * is delegated to the next handler unchanged.
 *
 * Construction:
 *
 * ```php
 * $middleware = new CodiwareMiddleware(
 *     config: CodiwareConfig::fromFile($path),
 *     responseFactory: $psr17,
 *     streamFactory: $psr17,
 *     logger: $logger,
 *     userContext: new UserContext($name, $email),
 * );
 * ```
 */
final class CodiwareMiddleware implements MiddlewareInterface
{
    private CodiwareConfig $config;
    private Responses $responses;
    private LoggerInterface $logger;
    private UserContext $user;
    private Router $router;
    private WorkspaceResolver $workspaces;
    private PathGuard $pathGuard;
    private string $basePath;

    public function __construct(
        CodiwareConfig $config,
        ResponseFactoryInterface $responseFactory,
        StreamFactoryInterface $streamFactory,
        ?LoggerInterface $logger = null,
        ?UserContext $userContext = null,
        ?string $basePath = null
    ) {
        $this->config = $config;
        $this->responses = new Responses($responseFactory, $streamFactory);
        $this->logger = $logger ?? new NullLogger();
        $this->user = $userContext ?? new UserContext();
        $this->basePath = $this->normalizeBasePath($basePath ?? $config->basePath());

        $this->workspaces = new WorkspaceResolver($config);
        $this->pathGuard = new PathGuard($config);

        $this->router = new Router();
        $this->registerRoutes();
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $uriPath = $request->getUri()->getPath();
        $relative = $this->stripBasePath($uriPath);
        if ($relative === null) {
            return $handler->handle($request);
        }

        try {
            $match = $this->router->match($request->getMethod(), $relative);
            if ($match === null) {
                // Unknown path under our prefix: respond with a 404 rather than delegating,
                // so callers know the IDE handled it but the route does not exist.
                return $this->responses->notFound('No Codiware route matches ' . $relative);
            }
            return ($match['handler'])($request, $match['params']);
        } catch (CodiwareException $e) {
            $this->logger->info(
                'Codiware request rejected: ' . $e->getMessage(),
                ['exception' => $e, 'code' => $e->errorCode, 'http_status' => $e->httpStatus]
            );
            return $this->responses->error($e->httpStatus, $e->errorCode, $e->getMessage(), $e->details);
        } catch (\Throwable $e) {
            $this->logger->error(
                'Codiware request failed: ' . $e->getMessage(),
                ['exception' => $e]
            );
            return $this->responses->serverError('Internal server error.');
        }
    }

    /**
     * Strip the configured base path from `$uriPath`. Returns the relative path
     * (starting with `/`) if `$uriPath` matched, or `null` if it did not.
     */
    private function stripBasePath(string $uriPath): ?string
    {
        $uriPath = '/' . ltrim($uriPath, '/');
        if ($this->basePath === '/') {
            return $uriPath;
        }
        if ($uriPath === $this->basePath) {
            return '/';
        }
        if (str_starts_with($uriPath, $this->basePath . '/')) {
            return substr($uriPath, strlen($this->basePath)) ?: '/';
        }
        return null;
    }

    private function normalizeBasePath(string $bp): string
    {
        $bp = '/' . ltrim($bp, '/');
        $bp = rtrim($bp, '/');
        return $bp === '' ? '/' : $bp;
    }

    private function registerRoutes(): void
    {
        $translations = new TranslationService();
        $fileService = new FileService($this->pathGuard, $this->config);
        $gitColorNormalizer = new GitColorNormalizer();
        $gitService = new GitService($this->config, $this->logger, $gitColorNormalizer);
        $searchService = new SearchService($this->pathGuard);
        $consoleService = new ConsoleService($this->config, $this->logger, [$gitColorNormalizer]);

        $shell = new ShellController($this->responses, $this->config, $this->workspaces, $this->basePath, $this->user);
        $assets = new AssetController($this->responses);
        $configCtl = new ConfigController($this->responses, $this->config, $translations, $this->user, $this->basePath);
        $files = new FileController($this->responses, $this->workspaces, $this->pathGuard, $fileService);
        $git = new GitController($this->responses, $this->workspaces, $this->pathGuard, $gitService, $this->user);
        $search = new SearchController($this->responses, $this->workspaces, $this->pathGuard, $searchService);
        $console = new ConsoleController($this->responses, $this->workspaces, $this->pathGuard, $consoleService);

        // Shell + assets
        $this->router->get('/repo/{workspacePath*}', [$shell, 'open']);
        $this->router->get('/assets/{assetPath*}', [$assets, 'serve']);

        // Config + translations
        $this->router->get('/config', [$configCtl, 'getConfig']);
        $this->router->get('/translations/{locale}', [$configCtl, 'getTranslations']);

        // Files
        $this->router->get('/files/tree', [$files, 'tree']);
        $this->router->get('/files/find', [$files, 'find']);
        $this->router->get('/files/read', [$files, 'read']);
        $this->router->put('/files/write', [$files, 'write']);
        $this->router->post('/files/create', [$files, 'create']);
        $this->router->post('/files/move', [$files, 'move']);
        $this->router->post('/files/copy', [$files, 'copy']);
        $this->router->post('/files/duplicate', [$files, 'duplicate']);
        $this->router->delete('/files/delete', [$files, 'delete']);
        $this->router->get('/files/download', [$files, 'download']);
        $this->router->post('/files/upload', [$files, 'upload']);

        // Git
        $this->router->get('/git/status', [$git, 'status']);
        $this->router->get('/git/diff', [$git, 'diff']);
        $this->router->post('/git/discard', [$git, 'discard']);
        $this->router->post('/git/stage', [$git, 'stage']);
        $this->router->post('/git/unstage', [$git, 'unstage']);
        $this->router->post('/git/commit', [$git, 'commit']);
        $this->router->post('/git/amend', [$git, 'amend']);
        $this->router->post('/git/push', [$git, 'push']);
        $this->router->post('/git/pull', [$git, 'pull']);
        $this->router->get('/git/branches', [$git, 'branches']);
        $this->router->post('/git/checkout', [$git, 'checkout']);
        $this->router->get('/git/history', [$git, 'history']);
        $this->router->get('/git/show', [$git, 'show']);
        $this->router->get('/git/commit', [$git, 'commitDetails']);
        $this->router->get('/git/commit-diff', [$git, 'commitDiff']);

        // Search
        $this->router->get('/search', [$search, 'search']);
        $this->router->post('/search/replace', [$search, 'replace']);

        // Console
        $this->router->get('/console/presets', [$console, 'presets']);
        $this->router->post('/console/run', [$console, 'run']);
    }
}
