<?php
declare(strict_types=1);

namespace kabachello\Codiware\Controller;

use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Http\Responses;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Serves static SPA assets from `public/` and selected vendor asset folders
 * (currently `vendor/npm-asset/`).
 *
 * Path traversal is rejected: the resolved real path must remain inside one of
 * the configured roots.
 */
final class AssetController
{
    /** @var string[] */
    private array $roots;

    public function __construct(private readonly Responses $responses)
    {
        $packageRoot = dirname(__DIR__, 1);
        $candidates = [
            $packageRoot . DIRECTORY_SEPARATOR . 'public',
            // Dev mode: package is the repo root, its own vendor/npm-asset.
            $packageRoot . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'npm-asset',
            // Installed as a dependency: vendor/axenox/codiware → vendor/npm-asset.
            $packageRoot . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'npm-asset',
        ];
        $this->roots = [];
        foreach ($candidates as $c) {
            $real = realpath($c);
            if ($real !== false) {
                $this->roots[] = $real;
            }
        }
    }

    public function serve(ServerRequestInterface $request, array $params = []): ResponseInterface
    {
        $rel = (string)($params['assetPath'] ?? '');
        if ($rel === '') {
            return $this->responses->notFound('Asset not specified.');
        }
        $rel = ltrim(str_replace(['\\', "\0"], ['/', ''], $rel), '/');
        if (str_contains($rel, '..')) {
            return $this->responses->forbidden('Asset path is not allowed.');
        }
        foreach ($this->roots as $root) {
            $candidate = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
            $real = realpath($candidate);
            if ($real === false || !is_file($real)) {
                continue;
            }
            if (!str_starts_with($real, $root . DIRECTORY_SEPARATOR) && $real !== $root) {
                continue;
            }
            return $this->sendFile($real);
        }
        return $this->responses->notFound('Asset not found: ' . $rel);
    }

    private function sendFile(string $abs): ResponseInterface
    {
        $stream = @fopen($abs, 'rb');
        if ($stream === false) {
            throw new CodiwareException('Cannot open asset.', 'read_failed', 500);
        }
        $type = $this->guessMime($abs);
        $size = filesize($abs);
        $headers = [
            'Cache-Control' => 'public, max-age=3600',
            'X-Content-Type-Options' => 'nosniff',
        ];
        if ($size !== false) {
            $headers['Content-Length'] = (string)$size;
        }
        return $this->responses->stream(200, $stream, $type, $headers);
    }

    private function guessMime(string $abs): string
    {
        $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
        return [
            'html' => 'text/html; charset=utf-8',
            'htm' => 'text/html; charset=utf-8',
            'css' => 'text/css; charset=utf-8',
            'js' => 'application/javascript; charset=utf-8',
            'mjs' => 'application/javascript; charset=utf-8',
            'map' => 'application/json',
            'json' => 'application/json',
            'svg' => 'image/svg+xml',
            'png' => 'image/png',
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'ico' => 'image/x-icon',
            'woff' => 'font/woff',
            'woff2' => 'font/woff2',
            'ttf' => 'font/ttf',
            'eot' => 'application/vnd.ms-fontobject',
            'wasm' => 'application/wasm',
            'txt' => 'text/plain; charset=utf-8',
            'md' => 'text/markdown; charset=utf-8',
        ][$ext] ?? 'application/octet-stream';
    }
}