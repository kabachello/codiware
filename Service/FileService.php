<?php
declare(strict_types=1);

namespace kabachello\Codiware\Service;

use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceRoot;

/**
 * Filesystem operations bound to a workspace root.
 *
 * All paths are validated through `PathGuard` before any filesystem call.
 */
final class FileService
{
    private const TEXT_PROBE_BYTES = 8192;

    public function __construct(
        private readonly PathGuard $guard,
        private readonly CodiwareConfig $config
    ) {
    }

    /**
     * List directory entries for the file tree.
     *
     * @return array<int,array{name:string,type:string,path:string,size:int,mtime:int,is_text:bool}>
     */
    public function listDirectory(WorkspaceRoot $root, string $relative): array
    {
        $abs = $this->guard->resolveInside($root, $relative);
        if (!is_dir($abs)) {
            throw new CodiwareException('Path is not a directory.', 'not_a_directory', 400, ['path' => $relative]);
        }
        $entries = @scandir($abs);
        if ($entries === false) {
            throw new CodiwareException('Cannot list directory.', 'list_failed', 500, ['path' => $relative]);
        }

        $relForward = $this->guard->relativize($root, $abs);
        $out = [];
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $childAbs = $abs . DIRECTORY_SEPARATOR . $name;
            $childRel = ($relForward === '' ? '' : $relForward . '/') . $name;
            try {
                // Run through guard so deny patterns hide entries.
                $this->guard->resolveInside($root, $childRel);
            } catch (CodiwareException) {
                continue;
            }
            $isDir = is_dir($childAbs);
            $size = $isDir ? 0 : (int)(@filesize($childAbs) ?: 0);
            $out[] = [
                'name' => $name,
                'type' => $isDir ? 'dir' : 'file',
                'path' => $childRel,
                'size' => $size,
                'mtime' => (int)(@filemtime($childAbs) ?: 0),
                'is_text' => $isDir ? false : $this->isLikelyText($childAbs),
            ];
        }
        usort($out, function (array $a, array $b): int {
            if ($a['type'] !== $b['type']) {
                return $a['type'] === 'dir' ? -1 : 1;
            }
            return strcasecmp($a['name'], $b['name']);
        });
        return $out;
    }

    /**
     * @return array{path:string,content:string,size:int,mtime:int,encoding:string}
     */
    public function readText(WorkspaceRoot $root, string $relative): array
    {
        $abs = $this->guard->resolveInside($root, $relative);
        if (!is_file($abs)) {
            throw new CodiwareException('Not a file.', 'not_a_file', 400, ['path' => $relative]);
        }
        if (!$this->isLikelyText($abs)) {
            throw new CodiwareException(
                'Refusing to read binary file as text. Use /files/download.',
                'binary_file',
                415,
                ['path' => $relative]
            );
        }
        $content = @file_get_contents($abs);
        if ($content === false) {
            throw new CodiwareException('Cannot read file.', 'read_failed', 500, ['path' => $relative]);
        }
        return [
            'path' => $this->guard->relativize($root, $abs),
            'content' => $content,
            'size' => strlen($content),
            'mtime' => (int)(@filemtime($abs) ?: 0),
            'encoding' => 'utf-8',
        ];
    }

    /**
     * @return array{path:string,size:int,mtime:int}
     */
    public function writeText(WorkspaceRoot $root, string $relative, string $content): array
    {
        $max = (int)($this->config->get('MAX_UPLOAD_BYTES', 52428800) ?? 52428800);
        if (strlen($content) > $max) {
            throw new CodiwareException(
                'File content exceeds maximum allowed size.',
                'too_large',
                413,
                ['max_bytes' => $max]
            );
        }
        $abs = $this->guard->resolveInside($root, $relative, mustExist: false);
        $dir = dirname($abs);
        if (!is_dir($dir)) {
            throw new CodiwareException('Target directory does not exist.', 'parent_not_found', 404, ['path' => $relative]);
        }
        if (@file_put_contents($abs, $content) === false) {
            throw new CodiwareException('Cannot write file.', 'write_failed', 500, ['path' => $relative]);
        }
        return [
            'path' => $this->guard->relativize($root, $abs),
            'size' => strlen($content),
            'mtime' => (int)(@filemtime($abs) ?: 0),
        ];
    }

    public function create(WorkspaceRoot $root, string $relative, string $type): array
    {
        if (!in_array($type, ['file', 'dir'], true)) {
            throw new CodiwareException('type must be "file" or "dir".', 'bad_request', 400);
        }
        $abs = $this->guard->resolveInside($root, $relative, mustExist: false);
        if (file_exists($abs)) {
            throw new CodiwareException('Target already exists.', 'exists', 409, ['path' => $relative]);
        }
        if ($type === 'dir') {
            if (!@mkdir($abs, 0775, true) && !is_dir($abs)) {
                throw new CodiwareException('Cannot create directory.', 'mkdir_failed', 500, ['path' => $relative]);
            }
        } else {
            $parent = dirname($abs);
            if (!is_dir($parent) && !@mkdir($parent, 0775, true)) {
                throw new CodiwareException('Cannot create parent directory.', 'mkdir_failed', 500, ['path' => $relative]);
            }
            if (@file_put_contents($abs, '') === false) {
                throw new CodiwareException('Cannot create file.', 'create_failed', 500, ['path' => $relative]);
            }
        }
        return [
            'path' => $this->guard->relativize($root, $abs),
            'type' => $type,
        ];
    }

    public function delete(WorkspaceRoot $root, string $relative): void
    {
        $abs = $this->guard->resolveInside($root, $relative);
        if (is_dir($abs)) {
            $this->rrmdir($abs);
        } elseif (is_file($abs)) {
            if (!@unlink($abs)) {
                throw new CodiwareException('Cannot delete file.', 'delete_failed', 500, ['path' => $relative]);
            }
        }
    }

    public function move(WorkspaceRoot $root, string $from, string $to): array
    {
        $src = $this->guard->resolveInside($root, $from);
        $dst = $this->guard->resolveInside($root, $to, mustExist: false);
        if (file_exists($dst)) {
            throw new CodiwareException('Destination already exists.', 'exists', 409, ['to' => $to]);
        }
        if (!@rename($src, $dst)) {
            throw new CodiwareException('Cannot move.', 'move_failed', 500);
        }
        return ['from' => $from, 'to' => $this->guard->relativize($root, $dst)];
    }

    public function copy(WorkspaceRoot $root, string $from, string $to): array
    {
        $src = $this->guard->resolveInside($root, $from);
        $dst = $this->guard->resolveInside($root, $to, mustExist: false);
        if (file_exists($dst)) {
            throw new CodiwareException('Destination already exists.', 'exists', 409, ['to' => $to]);
        }
        if (is_dir($src)) {
            $this->rcopy($src, $dst);
        } else {
            $parent = dirname($dst);
            if (!is_dir($parent) && !@mkdir($parent, 0775, true)) {
                throw new CodiwareException('Cannot create destination directory.', 'mkdir_failed', 500);
            }
            if (!@copy($src, $dst)) {
                throw new CodiwareException('Cannot copy file.', 'copy_failed', 500);
            }
        }
        return ['from' => $from, 'to' => $this->guard->relativize($root, $dst)];
    }

    /**
     * Create a copy of a file or folder in the same parent directory using a
     * human-friendly `(copy)` suffix. If the generated name already exists,
     * numeric suffixes are added as `(copy 2)`, `(copy 3)`, etc.
     *
     * @return array{from:string,to:string}
     */
    public function duplicate(WorkspaceRoot $root, string $path): array
    {
        $path = trim($path, '/');
        if ($path === '') {
            throw new CodiwareException('path is required.', 'bad_request', 400);
        }

        $this->guard->resolveInside($root, $path);
        $parent = str_contains($path, '/') ? dirname($path) : '';
        if ($parent === '.') {
            $parent = '';
        }
        $name = basename($path);
        $targetName = $this->nextDuplicateName($name, function (string $candidate) use ($root, $parent): bool {
            $candidateRel = $parent === '' ? $candidate : $parent . '/' . $candidate;
            $candidateAbs = $this->guard->resolveInside($root, $candidateRel, mustExist: false);
            return file_exists($candidateAbs);
        });
        $targetRel = $parent === '' ? $targetName : $parent . '/' . $targetName;

        return $this->copy($root, $path, $targetRel);
    }

    /**
     * Stream a file or zipped folder to the caller.
     *
     * @return array{abs:string,name:string,zip:bool,size:int}
     */
    public function prepareDownload(WorkspaceRoot $root, string $relative): array
    {
        $abs = $this->guard->resolveInside($root, $relative);
        if (is_file($abs)) {
            return ['abs' => $abs, 'name' => basename($abs), 'zip' => false, 'size' => (int)filesize($abs)];
        }
        if (!is_dir($abs)) {
            throw new CodiwareException('Path is not a file or directory.', 'bad_path', 400);
        }
        $tmp = tempnam(sys_get_temp_dir(), 'codiware_zip_');
        if ($tmp === false) {
            throw new CodiwareException('Cannot create temp file.', 'temp_failed', 500);
        }
        $zip = new \ZipArchive();
        if ($zip->open($tmp, \ZipArchive::OVERWRITE) !== true) {
            throw new CodiwareException('Cannot open zip for writing.', 'zip_failed', 500);
        }
        $this->addFolderToZip($zip, $abs, basename($abs));
        $zip->close();
        return [
            'abs' => $tmp,
            'name' => basename($abs) . '.zip',
            'zip' => true,
            'size' => (int)(@filesize($tmp) ?: 0),
        ];
    }

    /**
     * Save one uploaded file under `$targetDir` (relative to root). Returns saved path.
     *
     * @param array{name:string,tmp_name:string,size:int,error:int} $uploaded
     */
    public function saveUpload(WorkspaceRoot $root, string $targetDir, array $uploaded, bool $extractZip = false): array
    {
        if (($uploaded['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new CodiwareException('Upload failed.', 'upload_failed', 400, ['error' => $uploaded['error'] ?? null]);
        }
        $max = (int)($this->config->get('MAX_UPLOAD_BYTES', 52428800) ?? 52428800);
        if (($uploaded['size'] ?? 0) > $max) {
            throw new CodiwareException('Upload exceeds maximum size.', 'too_large', 413, ['max_bytes' => $max]);
        }
        $name = $this->sanitizeName((string)$uploaded['name']);
        $relTarget = trim($targetDir, '/');

        if ($extractZip && str_ends_with(strtolower($name), '.zip')) {
            $dirRel = $relTarget;
            $absDir = $this->guard->resolveInside($root, $dirRel);
            $zip = new \ZipArchive();
            if ($zip->open($uploaded['tmp_name']) !== true) {
                throw new CodiwareException('Invalid zip archive.', 'bad_zip', 400);
            }
            $extracted = [];
            try {
                for ($i = 0; $i < $zip->numFiles; $i++) {
                    $entryName = $zip->getNameIndex($i);
                    if ($entryName === false || $entryName === '') {
                        continue;
                    }
                    // Reject absolute paths and traversal in zip entries (zip-slip).
                    if (preg_match('#^[/\\]|(^|[\\/])\.\.([\\/]|$)#', $entryName) === 1) {
                        throw new CodiwareException('Zip entry rejected (traversal).', 'zip_unsafe', 400, ['entry' => $entryName]);
                    }
                    $entryRel = ($relTarget === '' ? '' : $relTarget . '/') . $entryName;
                    // resolveInside throws on traversal/denied entries.
                    $entryAbs = $this->guard->resolveInside($root, $entryRel, mustExist: false);
                    if (str_ends_with($entryName, '/')) {
                        @mkdir($entryAbs, 0775, true);
                        continue;
                    }
                    $parent = dirname($entryAbs);
                    if (!is_dir($parent) && !@mkdir($parent, 0775, true)) {
                        throw new CodiwareException('Cannot create directory for zip entry.', 'mkdir_failed', 500);
                    }
                    $stream = $zip->getStream($entryName);
                    if ($stream === false) {
                        throw new CodiwareException('Cannot read zip entry.', 'zip_failed', 500, ['entry' => $entryName]);
                    }
                    $dst = @fopen($entryAbs, 'wb');
                    if ($dst === false) {
                        fclose($stream);
                        throw new CodiwareException('Cannot write zip entry.', 'write_failed', 500, ['entry' => $entryName]);
                    }
                    stream_copy_to_stream($stream, $dst);
                    fclose($stream);
                    fclose($dst);
                    $extracted[] = $this->guard->relativize($root, $entryAbs);
                }
            } finally {
                $zip->close();
            }
            return ['path' => $this->guard->relativize($root, $absDir), 'extracted' => $extracted, 'type' => 'zip'];
        }

        $rel = ($relTarget === '' ? '' : $relTarget . '/') . $name;
        $abs = $this->guard->resolveInside($root, $rel, mustExist: false);
        if (file_exists($abs)) {
            throw new CodiwareException('File already exists at destination.', 'exists', 409, ['path' => $rel]);
        }
        $parent = dirname($abs);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true)) {
            throw new CodiwareException('Cannot create destination directory.', 'mkdir_failed', 500);
        }
        if (is_uploaded_file($uploaded['tmp_name'])) {
            if (!@move_uploaded_file($uploaded['tmp_name'], $abs)) {
                throw new CodiwareException('Cannot save upload.', 'save_failed', 500);
            }
        } else {
            // Dev/test path: tmp file was not created by PHP upload handler.
            if (!@copy($uploaded['tmp_name'], $abs)) {
                throw new CodiwareException('Cannot save upload.', 'save_failed', 500);
            }
        }
        return [
            'path' => $this->guard->relativize($root, $abs),
            'size' => (int)(@filesize($abs) ?: 0),
            'type' => 'file',
        ];
    }

    private function sanitizeName(string $name): string
    {
        $name = basename($name);
        $name = preg_replace('/[\x00-\x1F]/', '', $name) ?? '';
        return $name !== '' ? $name : 'upload';
    }

    private function nextDuplicateName(string $name, callable $exists): string
    {
        $extension = pathinfo($name, PATHINFO_EXTENSION);
        $filename = pathinfo($name, PATHINFO_FILENAME);
        $base = $extension === '' ? $name : $filename;

        $candidate = $extension === ''
            ? $base . ' (copy)'
            : $base . ' (copy).' . $extension;
        if (!$exists($candidate)) {
            return $candidate;
        }

        $index = 2;
        while (true) {
            $candidate = $extension === ''
                ? $base . ' (copy ' . $index . ')'
                : $base . ' (copy ' . $index . ').' . $extension;
            if (!$exists($candidate)) {
                return $candidate;
            }
            $index++;
        }
    }

    private function isLikelyText(string $abs): bool
    {
        $size = @filesize($abs);
        if ($size === false || $size === 0) {
            return true;
        }
        $fh = @fopen($abs, 'rb');
        if ($fh === false) {
            return false;
        }
        $bytes = (string)@fread($fh, self::TEXT_PROBE_BYTES);
        fclose($fh);
        if ($bytes === '') {
            return true;
        }
        if (strpos($bytes, "\x00") !== false) {
            return false;
        }
        $nonPrintable = preg_match_all('/[\x00-\x08\x0E-\x1F]/', $bytes);
        return $nonPrintable < (strlen($bytes) * 0.02);
    }

    private function rrmdir(string $dir): void
    {
        $items = @scandir($dir);
        if ($items === false) {
            return;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_dir($path) && !is_link($path)) {
                $this->rrmdir($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }

    private function rcopy(string $src, string $dst): void
    {
        if (!is_dir($dst) && !@mkdir($dst, 0775, true)) {
            throw new CodiwareException('Cannot create directory.', 'mkdir_failed', 500);
        }
        $items = @scandir($src);
        if ($items === false) {
            return;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $sp = $src . DIRECTORY_SEPARATOR . $item;
            $dp = $dst . DIRECTORY_SEPARATOR . $item;
            if (is_dir($sp)) {
                $this->rcopy($sp, $dp);
            } else {
                @copy($sp, $dp);
            }
        }
    }

    private function addFolderToZip(\ZipArchive $zip, string $absDir, string $localRoot): void
    {
        $items = @scandir($absDir);
        if ($items === false) {
            return;
        }
        $hasChildren = false;
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $hasChildren = true;
            $p = $absDir . DIRECTORY_SEPARATOR . $item;
            $local = $localRoot . '/' . $item;
            if (is_dir($p)) {
                $this->addFolderToZip($zip, $p, $local);
            } else {
                $zip->addFile($p, $local);
            }
        }
        if (!$hasChildren) {
            $zip->addEmptyDir($localRoot);
        }
    }
}
