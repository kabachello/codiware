<?php
declare(strict_types=1);

namespace kabachello\Codiware\Service;

use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceRoot;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;

/**
 * Recursive workspace-wide text search and search-and-replace.
 *
 * Binary files and paths matching the configured deny patterns are skipped.
 * All paths are reported workspace-relative with forward slashes.
 */
final class SearchService
{
    private const BINARY_PROBE = 8192;
    private const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB cap per file

    public function __construct(private readonly PathGuard $guard)
    {
    }

    /**
     * @return array{query:string,regex:bool,case_sensitive:bool,total_matches:int,total_files:int,truncated:bool,results:array<int,array{path:string,matches:array<int,array{line:int,column:int,text:string,match:string}>}>}
     */
    public function search(
        WorkspaceRoot $root,
        string $query,
        bool $regex = false,
        bool $caseSensitive = false,
        ?string $subPath = null,
        int $maxResults = 1000,
        int $maxFiles = 500
    ): array {
        if ($query === '') {
            throw new CodiwareException('Search query must not be empty.', 'bad_request', 400);
        }

        $base = $this->guard->resolveInside($root, $subPath ?? '', mustExist: true);
        $pattern = $this->compilePattern($query, $regex, $caseSensitive);

        $results = [];
        $totalMatches = 0;
        $filesScanned = 0;
        $truncated = false;

        foreach ($this->walkFiles($base) as $abs) {
            if ($filesScanned >= $maxFiles) {
                $truncated = true;
                break;
            }
            $filesScanned++;
            $rel = $this->guard->relativize($root, $abs);
            try {
                // Ensure deny patterns still apply for each candidate.
                $this->guard->resolveInside($root, $rel, mustExist: true);
            } catch (CodiwareException) {
                continue;
            }

            $size = @filesize($abs);
            if ($size === false || $size > self::MAX_FILE_BYTES) {
                continue;
            }
            $handle = @fopen($abs, 'rb');
            if ($handle === false) {
                continue;
            }
            $probe = (string)fread($handle, self::BINARY_PROBE);
            if ($this->looksBinary($probe)) {
                fclose($handle);
                continue;
            }
            rewind($handle);
            $lineNo = 0;
            $matches = [];
            while (($line = fgets($handle)) !== false) {
                $lineNo++;
                $stripped = rtrim($line, "\r\n");
                if (preg_match_all($pattern, $stripped, $m, PREG_OFFSET_CAPTURE) > 0) {
                    foreach ($m[0] as $hit) {
                        $matches[] = [
                            'line' => $lineNo,
                            'column' => (int)$hit[1] + 1,
                            'text' => $stripped,
                            'match' => (string)$hit[0],
                        ];
                        $totalMatches++;
                        if ($totalMatches >= $maxResults) {
                            break 2;
                        }
                    }
                }
            }
            fclose($handle);

            if ($matches !== []) {
                $results[] = [
                    'path' => $rel,
                    'matches' => $matches,
                ];
            }
            if ($totalMatches >= $maxResults) {
                $truncated = true;
                break;
            }
        }

        return [
            'query' => $query,
            'regex' => $regex,
            'case_sensitive' => $caseSensitive,
            'total_matches' => $totalMatches,
            'total_files' => count($results),
            'truncated' => $truncated,
            'results' => $results,
        ];
    }

    /**
     * Search-and-replace. If `$apply` is false only a preview is returned.
     *
     * @return array{apply:bool,changed_files:int,total_replacements:int,results:array<int,array{path:string,replacements:int}>}
     */
    public function replace(
        WorkspaceRoot $root,
        string $query,
        string $replacement,
        bool $regex = false,
        bool $caseSensitive = false,
        ?string $subPath = null,
        bool $apply = false,
        int $maxFiles = 500
    ): array {
        if ($query === '') {
            throw new CodiwareException('Search query must not be empty.', 'bad_request', 400);
        }
        $base = $this->guard->resolveInside($root, $subPath ?? '', mustExist: true);
        $pattern = $this->compilePattern($query, $regex, $caseSensitive);

        $results = [];
        $totalReplacements = 0;
        $filesScanned = 0;

        foreach ($this->walkFiles($base) as $abs) {
            if ($filesScanned >= $maxFiles) {
                break;
            }
            $filesScanned++;
            $rel = $this->guard->relativize($root, $abs);
            try {
                $this->guard->resolveInside($root, $rel, mustExist: true);
            } catch (CodiwareException) {
                continue;
            }
            $size = @filesize($abs);
            if ($size === false || $size > self::MAX_FILE_BYTES) {
                continue;
            }
            $content = @file_get_contents($abs);
            if ($content === false) {
                continue;
            }
            if ($this->looksBinary(substr($content, 0, self::BINARY_PROBE))) {
                continue;
            }
            $count = 0;
            $updated = preg_replace($pattern, $replacement, $content, -1, $count);
            if ($updated === null || $count === 0) {
                continue;
            }
            $totalReplacements += $count;
            $results[] = ['path' => $rel, 'replacements' => $count];

            if ($apply && $updated !== $content) {
                if (@file_put_contents($abs, $updated) === false) {
                    throw new CodiwareException(
                        'Failed to write file during replace: ' . $rel,
                        'write_failed',
                        500,
                        ['path' => $rel]
                    );
                }
            }
        }

        return [
            'apply' => $apply,
            'changed_files' => count($results),
            'total_replacements' => $totalReplacements,
            'results' => $results,
        ];
    }

    /**
     * @return iterable<string>
     */
    private function walkFiles(string $base): iterable
    {
        if (is_file($base)) {
            yield $base;
            return;
        }
        $directory = new RecursiveDirectoryIterator($base, \FilesystemIterator::SKIP_DOTS);
        // Prune hidden entries (e.g. ".git", ".vscode") so the iterator never
        // descends into them and they are excluded from the results.
        $filtered = new \RecursiveCallbackFilterIterator(
            $directory,
            static fn (\SplFileInfo $info): bool => !str_starts_with($info->getFilename(), '.')
        );
        $it = new RecursiveIteratorIterator($filtered, RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($it as $info) {
            /** @var \SplFileInfo $info */
            if ($info->isFile()) {
                yield $info->getPathname();
            }
        }
    }

    private function compilePattern(string $query, bool $regex, bool $caseSensitive): string
    {
        $body = $regex ? $query : preg_quote($query, '~');
        $flags = 'u';
        if (!$caseSensitive) {
            $flags .= 'i';
        }
        $compiled = '~' . $body . '~' . $flags;
        // Validate.
        if (@preg_match($compiled, '') === false) {
            throw new CodiwareException(
                'Invalid search pattern.',
                'bad_request',
                400,
                ['query' => $query]
            );
        }
        return $compiled;
    }

    private function looksBinary(string $probe): bool
    {
        if ($probe === '') {
            return false;
        }
        if (str_contains($probe, "\x00")) {
            return true;
        }
        $nonPrintable = 0;
        $len = strlen($probe);
        for ($i = 0; $i < $len; $i++) {
            $c = ord($probe[$i]);
            if ($c < 9 || ($c > 13 && $c < 32) || $c === 127) {
                $nonPrintable++;
            }
        }
        return $len > 0 && ($nonPrintable / $len) > 0.30;
    }
}
