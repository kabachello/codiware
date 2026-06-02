<?php
declare(strict_types=1);

namespace kabachello\Codiware\Http;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Small, local route table. Each route binds an HTTP method and a path pattern
 * (relative to the configured base path) to a handler callable.
 *
 * Pattern syntax:
 *   - `/files/tree`              exact match
 *   - `/files/{name}`            single-segment placeholder
 *   - `/repo/{path*}`            greedy tail (matches the rest of the path, may contain `/`)
 *
 * Placeholder values are passed to the handler in the order they appear:
 *   `function(ServerRequestInterface $request, array $params): ResponseInterface`
 * where `$params` is an associative array keyed by the placeholder name.
 */
final class Router
{
    /** @var array<int,array{method:string,pattern:string,regex:string,vars:string[],handler:callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        [$regex, $vars] = $this->compile($pattern);
        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'regex' => $regex,
            'vars' => $vars,
            'handler' => $handler,
        ];
    }

    public function get(string $pattern, callable $handler): void
    {
        $this->add('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->add('POST', $pattern, $handler);
    }

    public function put(string $pattern, callable $handler): void
    {
        $this->add('PUT', $pattern, $handler);
    }

    public function delete(string $pattern, callable $handler): void
    {
        $this->add('DELETE', $pattern, $handler);
    }

    /**
     * Find a match for the given method and relative path (already stripped of base path).
     *
     * @return array{handler:callable,params:array<string,string>}|null
     */
    public function match(string $method, string $path): ?array
    {
        $method = strtoupper($method);
        $path = '/' . ltrim($path, '/');
        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) {
                continue;
            }
            if (preg_match($route['regex'], $path, $m) === 1) {
                $params = [];
                foreach ($route['vars'] as $var) {
                    $params[$var] = isset($m[$var]) ? rawurldecode((string)$m[$var]) : '';
                }
                return ['handler' => $route['handler'], 'params' => $params];
            }
        }
        return null;
    }

    public function hasPath(string $path): bool
    {
        $path = '/' . ltrim($path, '/');
        foreach ($this->routes as $route) {
            if (preg_match($route['regex'], $path) === 1) {
                return true;
            }
        }
        return false;
    }

    /**
     * @return array{0:string,1:string[]}
     */
    private function compile(string $pattern): array
    {
        $vars = [];
        $regex = preg_replace_callback(
            '/\{([a-zA-Z_][a-zA-Z0-9_]*)(\*?)\}/',
            function (array $m) use (&$vars): string {
                $name = $m[1];
                $vars[] = $name;
                if (($m[2] ?? '') === '*') {
                    return '(?P<' . $name . '>.+)';
                }
                return '(?P<' . $name . '>[^/]+)';
            },
            $pattern
        );
        return ['#^' . $regex . '$#', $vars];
    }
}
