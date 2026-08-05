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
     * Each entry includes a `has_children` flag for directories so lazy trees
     * can suppress expand affordances on empty folders without loading them a
     * second time on the client. The optional `$foldersOnly` flag switches the
     * child hint to a directory-only interpretation used by folder pickers,
     * while the normal explorer keeps treating files as visible children.
     *
     * @return array<int,array{name:string,type:string,path:string,size:int,mtime:int,is_text:bool,has_children?:bool}>
     */
    public function listDirectory(WorkspaceRoot $root, string $relative, bool $foldersOnly = false): array
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
            if ($foldersOnly && !$isDir) {
                continue;
            }
            $size = $isDir ? 0 : (int)(@filesize($childAbs) ?: 0);
            $entry = [
                'name' => $name,
                'type' => $isDir ? 'dir' : 'file',
                'path' => $childRel,
                'size' => $size,
                'mtime' => (int)(@filemtime($childAbs) ?: 0),
                'is_text' => $isDir ? false : $this->isLikelyText($childAbs),
            ];
            if ($isDir) {
                $entry['has_children'] = $foldersOnly
                    ? $this->directoryHasVisibleDirectories($root, $childAbs, $childRel)
                    : $this->directoryHasVisibleEntries($root, $childAbs, $childRel);
            }
            $out[] = $entry;
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
     * Recursively search for files whose name contains the given query.
     *
     * Matching is case-insensitive and limited to the file name (not the
     * whole path). Hidden entries (e.g. ".git") and paths matching the
     * configured deny patterns are skipped. Each match carries its full
     * workspace-relative path so the client can rebuild the folder hierarchy.
     *
     * @return array{matches:array<int,array{name:string,type:string,path:string,size:int,mtime:int,is_text:bool}>,truncated:bool}
     */
    public function find(WorkspaceRoot $root, string $query, int $maxResults = 1000): array
    {
        $query = trim($query);
        if ($query === '') {
            return ['matches' => [], 'truncated' => false];
        }

        $base = $this->guard->resolveInside($root, '');
        if (!is_dir($base)) {
            return ['matches' => [], 'truncated' => false];
        }
        $needle = mb_strtolower($query);

        $directory = new \RecursiveDirectoryIterator($base, \FilesystemIterator::SKIP_DOTS);
        // Skip only the Git metadata directory: it holds thousands of internal
        // files that are never useful in a name filter and would slow the walk
        // down. Other dot-folders (e.g. ".github") stay searchable so their
        // files remain findable, matching what the file tree displays.
        $filtered = new \RecursiveCallbackFilterIterator(
            $directory,
            static fn (\SplFileInfo $info): bool => !($info->isDir() && $info->getFilename() === '.git')
        );
        $it = new \RecursiveIteratorIterator($filtered, \RecursiveIteratorIterator::LEAVES_ONLY);

        $matches = [];
        $truncated = false;
        foreach ($it as $info) {
            /** @var \SplFileInfo $info */
            if (!$info->isFile()) {
                continue;
            }
            $name = $info->getFilename();
            if (!str_contains(mb_strtolower($name), $needle)) {
                continue;
            }
            $abs = $info->getPathname();
            $rel = $this->guard->relativize($root, $abs);
            try {
                // Ensure deny patterns still apply for each candidate.
                $this->guard->resolveInside($root, $rel);
            } catch (CodiwareException) {
                continue;
            }
            if (count($matches) >= $maxResults) {
                $truncated = true;
                break;
            }
            $matches[] = [
                'name' => $name,
                'type' => 'file',
                'path' => $rel,
                'size' => (int)(@filesize($abs) ?: 0),
                'mtime' => (int)(@filemtime($abs) ?: 0),
                'is_text' => $this->isLikelyText($abs),
            ];
        }

        usort($matches, static fn (array $a, array $b): int => strcasecmp($a['path'], $b['path']));
        return ['matches' => $matches, 'truncated' => $truncated];
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
        $parent = dirname($dst);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new CodiwareException('Cannot create destination directory.', 'mkdir_failed', 500, ['to' => $to]);
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
     * Stream one file, one folder as ZIP, or multiple selected items as one ZIP.
     *
     * An empty `$relative` still targets the whole workspace root. Passing
     * multiple paths creates a temporary archive that preserves the relative
     * folder structure of every selected top-level item.
     *
     * @param list<string> $relativePaths
     * @return array{abs:string,name:string,zip:bool,size:int}
     */
    public function prepareDownload(WorkspaceRoot $root, string $relative = '', array $relativePaths = []): array
    {
        $normalizedPaths = $this->normalizeDownloadSelection($relative, $relativePaths);
        if (count($normalizedPaths) > 1) {
            return $this->prepareMultiDownload($root, $normalizedPaths);
        }

        $single = $normalizedPaths[0] ?? trim($relative, '/');
        $abs = $this->guard->resolveInside($root, $single);
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
        $localRoot = $single === '' ? basename($root->path()) : basename($abs);
        $this->addFolderToZip($zip, $abs, $localRoot);
        $zip->close();
        return [
            'abs' => $tmp,
            'name' => ($single === '' ? basename($root->path()) : basename($abs)) . '.zip',
            'zip' => true,
            'size' => (int)(@filesize($tmp) ?: 0),
        ];
    }

    /**
     * Save one uploaded file under `$targetDir` (relative to root). Returns saved path.
     *
     * When `$autoName` is true, the file name is turned into a sequential,
     * zero-padded `<stem>_NN.<ext>` (e.g. `image_01.png`, `image_02.png`) by
     * picking the lowest number not yet taken in the target directory.
     *
     * @param array{name:string,tmp_name:string,size:int,error:int} $uploaded
     */
    public function saveUpload(WorkspaceRoot $root, string $targetDir, array $uploaded, bool $extractZip = false, bool $autoName = false): array
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
        // Create the target directory up front. resolveInside(mustExist:false)
        // validates a not-yet-existing file against its parent, so uploading
        // into a still-missing subfolder (e.g. an `images/` folder) would fail
        // with "parent_not_found" unless the directory is created first.
        if ($relTarget !== '') {
            $absTargetDir = $this->guard->resolveInside($root, $relTarget, mustExist: false);
            if (!is_dir($absTargetDir) && !@mkdir($absTargetDir, 0775, true) && !is_dir($absTargetDir)) {
                throw new CodiwareException('Cannot create destination directory.', 'mkdir_failed', 500, ['path' => $relTarget]);
            }
        }
        // Assign a sequential name (e.g. image_01.png) when requested, using the
        // lowest number still free in the target directory.
        if ($autoName) {
            $name = $this->nextNumberedName($name, function (string $candidate) use ($root, $relTarget): bool {
                $candidateRel = ($relTarget === '' ? '' : $relTarget . '/') . $candidate;
                return file_exists($this->guard->resolveInside($root, $candidateRel, mustExist: false));
            });
            $rel = ($relTarget === '' ? '' : $relTarget . '/') . $name;
        }
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

    /**
     * Return the lowest free `<stem>_NN.<ext>` name (two-digit, zero-padded,
     * starting at 01) for `$name` in a directory, using `$exists` to test each
     * candidate. Extensionless names get a plain `_NN` suffix.
     */
    private function nextNumberedName(string $name, callable $exists): string
    {
        $extension = pathinfo($name, PATHINFO_EXTENSION);
        $stem = pathinfo($name, PATHINFO_FILENAME);
        if ($stem === '') {
            $stem = 'file';
        }
        $index = 1;
        while (true) {
            $suffix = str_pad((string)$index, 2, '0', STR_PAD_LEFT);
            $candidate = $extension === ''
                ? $stem . '_' . $suffix
                : $stem . '_' . $suffix . '.' . $extension;
            if (!$exists($candidate)) {
                return $candidate;
            }
            $index++;
        }
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

    /**
     * Normalize the caller's download target into a distinct list of paths.
     *
     * The legacy single `path` parameter remains supported. When `paths[]` is
     * present it takes precedence and empty values are ignored.
     *
     * @param list<string> $relativePaths
     * @return list<string>
     */
    private function normalizeDownloadSelection(string $relative, array $relativePaths): array
    {
        $paths = [];
        foreach ($relativePaths as $path) {
            $clean = trim((string)$path, '/');
            if ($clean === '') {
                continue;
            }
            $paths[] = $clean;
        }
        if ($paths !== []) {
            return array_values(array_unique($paths));
        }
        return [trim($relative, '/')];
    }

    /**
     * Build one temporary ZIP containing every selected top-level item once.
     *
     * Files are added at their relative path, and directories keep their full
     * subtree under that same relative root so mixed selections round-trip.
     *
     * @param list<string> $relativePaths
     * @return array{abs:string,name:string,zip:bool,size:int}
     */
    private function prepareMultiDownload(WorkspaceRoot $root, array $relativePaths): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'codiware_zip_');
        if ($tmp === false) {
            throw new CodiwareException('Cannot create temp file.', 'temp_failed', 500);
        }
        $zip = new \ZipArchive();
        if ($zip->open($tmp, \ZipArchive::OVERWRITE) !== true) {
            throw new CodiwareException('Cannot open zip for writing.', 'zip_failed', 500);
        }

        foreach ($relativePaths as $relativePath) {
            $abs = $this->guard->resolveInside($root, $relativePath);
            $local = str_replace('\\', '/', trim($relativePath, '/'));
            if (is_dir($abs)) {
                $this->addFolderToZip($zip, $abs, $local);
                continue;
            }
            if (!is_file($abs)) {
                $zip->close();
                throw new CodiwareException('Path is not a file or directory.', 'bad_path', 400, ['path' => $relativePath]);
            }
            $zip->addFile($abs, $local);
        }

        $zip->close();
        return [
            'abs' => $tmp,
            'name' => $this->selectionArchiveName($root),
            'zip' => true,
            'size' => (int)(@filesize($tmp) ?: 0),
        ];
    }

    /**
     * Determine whether a directory contains at least one visible entry.
     *
     * The main explorer uses this broader variant so folders stay expandable
     * whenever opening them would reveal either subfolders or files.
     */
    private function directoryHasVisibleEntries(WorkspaceRoot $root, string $absDir, string $relativeDir): bool
    {
        $items = @scandir($absDir);
        if ($items === false) {
            return false;
        }
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $childRel = ($relativeDir === '' ? '' : $relativeDir . '/') . $name;
            try {
                $this->guard->resolveInside($root, $childRel);
                return true;
            } catch (CodiwareException) {
                continue;
            }
        }
        return false;
    }

    /**
     * Determine whether a directory contains at least one visible subdirectory.
     *
     * The folder-only move picker uses this to suppress expand affordances on
     * directories that would reveal no children because they contain only files
     * or only entries rejected by `PathGuard`.
     */
    private function directoryHasVisibleDirectories(WorkspaceRoot $root, string $absDir, string $relativeDir): bool
    {
        $items = @scandir($absDir);
        if ($items === false) {
            return false;
        }
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $childAbs = $absDir . DIRECTORY_SEPARATOR . $name;
            if (!is_dir($childAbs)) {
                continue;
            }
            $childRel = ($relativeDir === '' ? '' : $relativeDir . '/') . $name;
            try {
                $this->guard->resolveInside($root, $childRel);
                return true;
            } catch (CodiwareException) {
                continue;
            }
        }
        return false;
    }

    /**
     * Build the default archive name for multi-download ZIP files from the workspace alias.
     *
     * The name ends with a timestamp so repeated downloads of the same
     * repository are easier to distinguish in the browser download list.
     */
    private function selectionArchiveName(WorkspaceRoot $root): string
    {
        $alias = trim($root->alias);
        if ($alias === '') {
            $alias = 'selection';
        }
        return $alias . '_selection_' . date('YmdHis') . '.zip';
    }
}
