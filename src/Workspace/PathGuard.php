<?php
declare(strict_types=1);

namespace Codiware\Workspace;

use Codiware\Config\CodiwareConfig;
use Codiware\Exception\CodiwareException;

/**
 * Single authority for filesystem-path safety.
 *
 * Every API that touches the filesystem MUST resolve user-provided paths through
 * `PathGuard::resolveInside()`. It rejects traversal, symlink escape, and
 * matches against the configured deny patterns.
 */
final class PathGuard
{
    /** @var string[] glob-like patterns from config */
    private array $denyPatterns;

    public function __construct(CodiwareConfig $config)
    {
        $patterns = $config->get('deny_patterns', []);
        $this->denyPatterns = is_array($patterns) ? array_values(array_filter($patterns, 'is_string')) : [];
    }

    /**
     * Resolve `$relative` inside `$root` to a canonical absolute path.
     *
     * - `$relative` may use `/` or `\` separators.
     * - Empty / "." means the root itself.
     * - Throws when the resolved path escapes the root, contains denied segments,
     *   or matches a deny pattern.
     *
     * The path does NOT need to exist for this call to succeed when
     * `$mustExist` is false (useful for write/create endpoints).
     *
     * @throws CodiwareException
     */
    public function resolveInside(WorkspaceRoot $root, string $relative, bool $mustExist = true): string
    {
        $rootReal = realpath($root->path);
        if ($rootReal === false) {
            throw new CodiwareException(
                'Workspace root no longer exists on disk.',
                'workspace_missing',
                500,
                ['root' => $root->alias]
            );
        }

        $relative = $this->sanitizeRelative($relative);
        $joined = $rootReal . ($relative === '' ? '' : DIRECTORY_SEPARATOR . $relative);

        if ($mustExist) {
            $real = realpath($joined);
            if ($real === false) {
                throw new CodiwareException(
                    'Path does not exist.',
                    'path_not_found',
                    404,
                    ['path' => $relative]
                );
            }
        } else {
            // Resolve the parent and append the leaf name to avoid escaping via "..".
            $parent = dirname($joined);
            $parentReal = realpath($parent);
            if ($parentReal === false) {
                throw new CodiwareException(
                    'Parent directory does not exist.',
                    'parent_not_found',
                    404,
                    ['path' => $relative]
                );
            }
            $real = $parentReal . DIRECTORY_SEPARATOR . basename($joined);
        }

        if (!$this->isUnder($real, $rootReal)) {
            throw new CodiwareException(
                'Path is outside the workspace.',
                'path_denied',
                403,
                ['path' => $relative]
            );
        }

        $relForCheck = ltrim(substr($real, strlen($rootReal)), DIRECTORY_SEPARATOR);
        if ($this->isDenied($relForCheck)) {
            throw new CodiwareException(
                'Path is denied by configuration.',
                'path_denied',
                403,
                ['path' => $relForCheck]
            );
        }

        return $real;
    }

    /**
     * Return the workspace-relative form of `$absolute` (with forward slashes).
     */
    public function relativize(WorkspaceRoot $root, string $absolute): string
    {
        $rootReal = realpath($root->path) ?: $root->path;
        $absolute = rtrim($absolute, DIRECTORY_SEPARATOR);
        if (str_starts_with($absolute, $rootReal)) {
            $rel = ltrim(substr($absolute, strlen($rootReal)), DIRECTORY_SEPARATOR);
            return str_replace(DIRECTORY_SEPARATOR, '/', $rel);
        }
        return str_replace(DIRECTORY_SEPARATOR, '/', $absolute);
    }

    private function sanitizeRelative(string $relative): string
    {
        $relative = trim($relative, "/\\ \t");
        if ($relative === '' || $relative === '.') {
            return '';
        }
        // Reject NUL bytes and other control chars.
        if (preg_match('/[\x00-\x1F]/', $relative) === 1) {
            throw new CodiwareException(
                'Path contains control characters.',
                'path_invalid',
                400,
                ['path' => $relative]
            );
        }
        $relative = str_replace('\\', '/', $relative);
        $parts = [];
        foreach (explode('/', $relative) as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }
            if ($segment === '..') {
                if ($parts === []) {
                    throw new CodiwareException(
                        'Path attempts to traverse above the workspace.',
                        'path_denied',
                        403,
                        ['path' => $relative]
                    );
                }
                array_pop($parts);
                continue;
            }
            $parts[] = $segment;
        }
        return implode(DIRECTORY_SEPARATOR, $parts);
    }

    private function isUnder(string $candidate, string $parent): bool
    {
        $candidate = rtrim($candidate, DIRECTORY_SEPARATOR);
        $parent = rtrim($parent, DIRECTORY_SEPARATOR);
        if ($candidate === $parent) {
            return true;
        }
        return str_starts_with($candidate, $parent . DIRECTORY_SEPARATOR);
    }

    private function isDenied(string $relative): bool
    {
        if ($relative === '') {
            return false;
        }
        $forward = str_replace(DIRECTORY_SEPARATOR, '/', $relative);
        foreach ($this->denyPatterns as $pattern) {
            if (fnmatch($pattern, $forward, FNM_CASEFOLD) === true) {
                return true;
            }
            // Also match against the basename so patterns like "*.key" hit nested files.
            if (fnmatch($pattern, basename($forward), FNM_CASEFOLD) === true) {
                return true;
            }
        }
        return false;
    }
}
