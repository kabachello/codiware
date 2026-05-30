<?php
declare(strict_types=1);

/**
 * Standalone dev server entry point.
 *
 * Usage:
 *   composer install
 *   php -S localhost:8080 -t public public/dev-server.php
 *
 * Then browse:
 *   http://localhost:8080/codiware/repo/{workspace-alias}
 *
 * Workspaces are resolved relative to the `base_folder` set in
 * `dev-server.config.json` next to this file (sample below), or fall back to
 * the parent directory of the package.
 */

require dirname(__DIR__) . '/vendor/autoload.php';

use Codiware\CodiwareMiddleware;
use Codiware\Config\CodiwareConfig;
use Codiware\Config\UserContext;
use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;

// --- Config ---------------------------------------------------------------
$configFile = __DIR__ . '/../dev-server.config.json';
$config = CodiwareConfig::fromFile(is_file($configFile) ? $configFile : null);

// Quick safety net: if no allowed_roots and no base_folder, point at this repo's parent.
if ($config->baseFolder() === null && $config->get('allowed_roots', []) === []) {
    $config = CodiwareConfig::fromArray(array_merge(
        $config->all(),
        ['base_folder' => realpath(dirname(__DIR__, 2)) ?: dirname(__DIR__, 2)]
    ));
}

$psr17 = new Psr17Factory();
$creator = new ServerRequestCreator($psr17, $psr17, $psr17, $psr17);
$request = $creator->fromGlobals();

$middleware = new CodiwareMiddleware(
    config: $config,
    responseFactory: $psr17,
    streamFactory: $psr17,
    logger: null,
    userContext: new UserContext('Dev User', 'dev@localhost')
);

// Pass-through handler that returns a static 404 for paths outside our base path.
$passThrough = new class ($psr17) implements Psr\Http\Server\RequestHandlerInterface {
    public function __construct(private Psr17Factory $psr17) {}
    public function handle(Psr\Http\Message\ServerRequestInterface $request): Psr\Http\Message\ResponseInterface
    {
        return $this->psr17->createResponse(404)
            ->withHeader('Content-Type', 'text/plain; charset=utf-8')
            ->withBody($this->psr17->createStream(
                "Not handled by Codiware. Try /codiware/repo/{workspace}\n"
            ));
    }
};

$response = $middleware->process($request, $passThrough);

http_response_code($response->getStatusCode());
foreach ($response->getHeaders() as $name => $values) {
    foreach ($values as $i => $v) {
        header("$name: $v", $i === 0);
    }
}
echo $response->getBody();
