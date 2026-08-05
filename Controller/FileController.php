<?php
declare(strict_types=1);

namespace kabachello\Codiware\Controller;

use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Http\Responses;
use kabachello\Codiware\Service\FileService;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceResolver;
use kabachello\Codiware\Workspace\WorkspaceRoot;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * REST endpoints for file/folder operations.
 *
 * All endpoints take a `?root=` query parameter naming the workspace root
 * (typically the same as the path passed to `repo/{workspacePath}`).
 */
final class FileController
{
    public function __construct(
        private readonly Responses $responses,
        private readonly WorkspaceResolver $resolver,
        private readonly PathGuard $guard,
        private readonly FileService $files
    ) {
    }

    public function tree(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $query = $request->getQueryParams();
        $path = (string)($query['path'] ?? '');
        $foldersOnly = $this->toBool($query['foldersOnly'] ?? false);
        $entries = $this->files->listDirectory($root, $path, $foldersOnly);
        return $this->responses->ok([
            'root' => $root->toArray(),
            'path' => $path,
            'entries' => $entries,
        ]);
    }

    public function read(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $path = (string)($request->getQueryParams()['path'] ?? '');
        return $this->responses->ok($this->files->readText($root, $path));
    }

    public function find(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $q = $request->getQueryParams();
        $query = (string)($q['q'] ?? '');
        $limit = max(1, min(5000, (int)($q['limit'] ?? 1000)));
        return $this->responses->ok($this->files->find($root, $query, $limit));
    }

    public function write(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $path = (string)($body['path'] ?? '');
        $content = (string)($body['content'] ?? '');
        $encoding = (string)($body['encoding'] ?? 'utf8');
        if ($path === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->files->writeText($root, $path, $content, $encoding));
    }

    public function create(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $path = (string)($body['path'] ?? '');
        $type = (string)($body['type'] ?? 'file');
        if ($path === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->files->create($root, $path, $type));
    }

    public function delete(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $path = (string)($request->getQueryParams()['path'] ?? '');
        if ($path === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }
        $this->files->delete($root, $path);
        return $this->responses->ok(['deleted' => $path]);
    }

    public function move(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        return $this->responses->ok($this->files->move(
            $root,
            (string)($body['from'] ?? ''),
            (string)($body['to'] ?? '')
        ));
    }

    public function copy(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        return $this->responses->ok($this->files->copy(
            $root,
            (string)($body['from'] ?? ''),
            (string)($body['to'] ?? '')
        ));
    }

    public function duplicate(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $body = $this->decodeJson($request);
        $path = (string)($body['path'] ?? '');
        if ($path === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }
        return $this->responses->ok($this->files->duplicate($root, $path));
    }

    public function download(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $query = $request->getQueryParams();
        $path = (string)($query['path'] ?? '');
        $paths = $this->downloadPaths($query['paths'] ?? $query['paths[]'] ?? null);
        $info = $this->files->prepareDownload($root, $path, $paths);
        $stream = @fopen($info['abs'], 'rb');
        if ($stream === false) {
            throw new CodiwareException('Cannot open file for download.', 'read_failed', 500);
        }
        $headers = [
            'Content-Length' => (string)$info['size'],
            'Content-Disposition' => 'attachment; filename="' . addslashes($info['name']) . '"',
            'Cache-Control' => 'no-store',
        ];
        $type = $info['zip'] ? 'application/zip' : ($this->guessMime($info['name']) ?? 'application/octet-stream');
        return $this->responses->stream(200, $stream, $type, $headers);
    }

    public function upload(ServerRequestInterface $request): ResponseInterface
    {
        $root = $this->root($request);
        $params = $request->getQueryParams();
        $target = (string)($params['path'] ?? '');
        $extract = isset($params['extract']) && in_array($params['extract'], ['1', 'true', 'yes'], true);
        $autoName = isset($params['autoname']) && in_array($params['autoname'], ['1', 'true', 'yes'], true);

        $uploaded = $request->getUploadedFiles();
        if ($uploaded === []) {
            throw new CodiwareException('No files uploaded.', 'no_files', 400);
        }

        $results = [];
        foreach ($uploaded as $key => $entry) {
            // Accept either a single file or an array of files keyed by anything.
            $list = is_array($entry) ? $entry : [$entry];
            foreach ($list as $file) {
                if ($file === null) {
                    continue;
                }
                /** @var \Psr\Http\Message\UploadedFileInterface $file */
                $tmp = tempnam(sys_get_temp_dir(), 'codiware_up_');
                if ($tmp === false) {
                    throw new CodiwareException('Cannot create temp file.', 'temp_failed', 500);
                }
                $file->moveTo($tmp);
                $results[] = $this->files->saveUpload($root, $target, [
                    'name' => $file->getClientFilename() ?? 'upload',
                    'tmp_name' => $tmp,
                    'size' => (int)($file->getSize() ?? 0),
                    'error' => $file->getError(),
                ], $extract, $autoName);
                @unlink($tmp);
            }
        }
        return $this->responses->ok(['uploaded' => $results]);
    }

    private function root(ServerRequestInterface $request): WorkspaceRoot
    {
        $alias = (string)($request->getQueryParams()['root'] ?? '');
        if ($alias === '') {
            throw new CodiwareException('?root= parameter is required.', 'bad_request', 400);
        }
        return $this->resolver->rootByAlias($alias);
    }

    /**
     * @return array<string,mixed>
     */
    private function decodeJson(ServerRequestInterface $request): array
    {
        $body = (string)$request->getBody();
        if ($body === '') {
            return [];
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            throw new CodiwareException('Request body must be a JSON object.', 'bad_request', 400);
        }
        return $decoded;
    }

    /**
     * Normalize repeated `paths[]` query parameters into a clean string list.
     *
     * @param mixed $raw
     * @return list<string>
     */
    private function downloadPaths(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }
        $paths = [];
        foreach ($raw as $value) {
            if (!is_scalar($value)) {
                continue;
            }
            $clean = trim((string)$value);
            if ($clean === '') {
                continue;
            }
            $paths[] = $clean;
        }
        return $paths;
    }

    /**
     * Convert common query-string truthy values into a boolean flag.
     */
    private function toBool(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_scalar($value)) {
            return in_array(strtolower((string)$value), ['1', 'true', 'yes', 'on'], true);
        }
        return false;
    }

    private function guessMime(string $name): ?string
    {
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        return [
            'txt' => 'text/plain', 'md' => 'text/markdown', 'html' => 'text/html', 'htm' => 'text/html',
            'css' => 'text/css', 'js' => 'application/javascript', 'json' => 'application/json',
            'xml' => 'application/xml', 'svg' => 'image/svg+xml', 'png' => 'image/png',
            'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
            'webp' => 'image/webp', 'ico' => 'image/x-icon', 'pdf' => 'application/pdf',
            'zip' => 'application/zip', 'csv' => 'text/csv',
        ][$ext] ?? null;
    }
}
