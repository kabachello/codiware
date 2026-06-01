<?php
declare(strict_types=1);

namespace Codiware\Workspace;

use Codiware\Config\CodiwareConfig;
use Codiware\Exception\CodiwareException;

/**
 * Resolves `repo/{workspacePath}` URLs to a concrete, allowed workspace root and
 * provides access to the configured list of roots (used in the "Add Folder to
 * Workspace" UI in the future).
 *
 * A workspace root is described by:
 *   - alias       a stable id, e.g. "exface/core"
 *   - path        absolute path on disk
 *   - label       human-readable label
 *
 * Roots can be configured in two ways:
 *   1. Via the `BASE_FOLDER` config (typically `vendor/`). Any first-level
 *      `vendor/subdir/...` path that exists on disk is allowed.
 *   2. Via explicit `ALLOWED_ROOTS` entries with `alias`, `path`, `label`.
 */
final class WorkspaceResolver
{
    public function __construct(private readonly CodiwareConfig $config)
    {
    }

    /**
     * Resolve a workspace path (the `{workspacePath}` portion of `repo/{path}`).
     *
     * @throws CodiwareException When the path does not match any allowed root.
     */
    public function resolve(string $workspacePath): WorkspaceRoot
    {
        $workspacePath = trim($workspacePath, "/\\ \t");
        if ($workspacePath === '') {
            throw new CodiwareException(
                'A workspace path is required (use codiware/repo/{path}).',
                'workspace_required',
                400
            );
        }

        // Try explicit allowed roots first - exact alias or absolute path prefix match.
        foreach ($this->allowedRoots() as $root) {
            if ($root->alias === $workspacePath) {
                return $root;
            }
        }

        // Try resolving under BASE_FOLDER, e.g. vendor/exface/core.
        $baseFolder = $this->config->baseFolder();
        if ($baseFolder !== null) {
            $candidate = $baseFolder . DIRECTORY_SEPARATOR
                . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $workspacePath);
            $real = realpath($candidate);
            if ($real !== false && is_dir($real) && $this->isUnder($real, $baseFolder)) {
                return new WorkspaceRoot(
                    alias: $workspacePath,
                    path: $real,
                    label: $workspacePath
                );
            }
        }

        throw new CodiwareException(
            'Workspace "' . $workspacePath . '" is not in the allowed roots.',
            'workspace_not_allowed',
            403,
            ['workspace' => $workspacePath]
        );
    }

    /**
    * @return WorkspaceRoot[] Explicitly configured roots only (does not auto-list BASE_FOLDER children).
     */
    public function allowedRoots(): array
    {
        $out = [];
        $configured = (array)($this->config->get('ALLOWED_ROOTS', []) ?? []);
        $baseFolder = $this->config->baseFolder();
        foreach ($configured as $entry) {
            if (!is_array($entry)) {
                continue;
            }
            $alias = (string)($entry['alias'] ?? '');
            $rawPath = (string)($entry['path'] ?? '');
            $label = (string)($entry['label'] ?? $alias);
            if ($alias === '' || $rawPath === '') {
                continue;
            }
            $abs = $this->absolutize($rawPath, $baseFolder);
            $real = realpath($abs);
            if ($real === false || !is_dir($real)) {
                continue;
            }
            $out[] = new WorkspaceRoot($alias, $real, $label);
        }
        return $out;
    }

    /**
     * Look up a root by alias. Used by API endpoints that receive `?root=` query parameters.
     *
     * The root may be either an explicitly configured root or a base-folder-relative path
     * that has already been validated as a workspace.
     *
     * @throws CodiwareException When the alias is unknown or no longer resolvable.
     */
    public function rootByAlias(string $alias): WorkspaceRoot
    {
        return $this->resolve($alias);
    }

    private function absolutize(string $path, ?string $baseFolder): string
    {
        if ($this->isAbsolute($path)) {
            return $path;
        }
        if ($baseFolder !== null) {
            return $baseFolder . DIRECTORY_SEPARATOR . $path;
        }
        return getcwd() . DIRECTORY_SEPARATOR . $path;
    }

    private function isAbsolute(string $path): bool
    {
        if ($path === '') {
            return false;
        }
        if ($path[0] === '/' || $path[0] === '\\') {
            return true;
        }
        // Windows drive letter: C:\ or C:/
        return strlen($path) >= 3
            && ctype_alpha($path[0])
            && $path[1] === ':'
            && ($path[2] === '\\' || $path[2] === '/');
    }

    private function isUnder(string $candidate, string $parent): bool
    {
        $candidate = rtrim($this->normalize($candidate), DIRECTORY_SEPARATOR);
        $parent = rtrim($this->normalize($parent), DIRECTORY_SEPARATOR);
        if ($candidate === $parent) {
            return true;
        }
        return str_starts_with($candidate, $parent . DIRECTORY_SEPARATOR);
    }

    private function normalize(string $path): string
    {
        return str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);
    }
}
