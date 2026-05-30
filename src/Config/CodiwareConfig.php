<?php
declare(strict_types=1);

namespace Codiware\Config;

/**
 * Immutable Codiware configuration.
 *
 * Loaded from defaults + optional JSON file + optional host overrides.
 * See `Docs/Implementation/Architecture.md` for the documented config schema.
 */
final class CodiwareConfig
{
    /** @var array<string,mixed> */
    private array $data;

    /**
     * @param array<string,mixed> $data Effective merged config tree.
     */
    public function __construct(array $data)
    {
        $this->data = $data;
    }

    /**
     * Build a config from defaults merged with optional overrides.
     *
     * @param array<string,mixed> $overrides
     */
    public static function fromArray(array $overrides = []): self
    {
        return new self(self::deepMerge(self::defaults(), $overrides));
    }

    /**
     * Build a config from a JSON file, falling back to defaults if the file is missing.
     */
    public static function fromFile(?string $path): self
    {
        if ($path === null || !is_file($path)) {
            return self::fromArray([]);
        }
        $raw = file_get_contents($path);
        if ($raw === false) {
            return self::fromArray([]);
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException("Codiware config at {$path} is not valid JSON.");
        }
        return self::fromArray($decoded);
    }

    /**
     * @return array<string,mixed> Default configuration tree.
     */
    public static function defaults(): array
    {
        return [
            'base_path' => '/codiware',
            'base_folder' => 'vendor',
            'allowed_roots' => [],
            'deny_patterns' => [
                '.env',
                '.env.*',
                '*.key',
                '*.pem',
                '*.p12',
                '*.pfx',
            ],
            'max_upload_bytes' => 52428800,
            'theme' => [
                'default' => 'light',
                'allow_user_override' => true,
                'skin' => null,
            ],
            'git' => [
                'enabled' => true,
                'author_name' => null,
                'author_email' => null,
                'default_history_limit' => 100,
                'binary' => 'git',
            ],
            'console' => [
                'enabled' => true,
                'timeout_seconds' => 300,
                'allow_patterns' => [
                    '^git\s+(status|log|diff|show|clean|fetch|remote|branch|checkout|merge|rebase|pull|tag)\b',
                ],
                'presets' => [
                    ['label' => 'Git status', 'command' => 'git status --short --branch'],
                    ['label' => 'Git fetch', 'command' => 'git fetch --all --prune'],
                    ['label' => 'Git graph', 'command' => 'git log --oneline --graph --decorate --max-count=30'],
                    ['label' => 'Dry-run clean', 'command' => 'git clean -nd'],
                    ['label' => 'Clean untracked', 'command' => 'git clean -fd'],
                    ['label' => 'Remotes', 'command' => 'git remote -v'],
                ],
            ],
            'editor' => [
                'tab_size' => 4,
                'word_wrap' => false,
            ],
            'translations' => [
                'default_locale' => 'en',
            ],
            'extensions' => [
                'enabled' => [],
                'manifests' => [],
            ],
        ];
    }

    /**
     * @param array<string,mixed> $base
     * @param array<string,mixed> $over
     * @return array<string,mixed>
     */
    private static function deepMerge(array $base, array $over): array
    {
        foreach ($over as $key => $value) {
            if (is_array($value) && isset($base[$key]) && is_array($base[$key]) && self::isAssoc($base[$key])) {
                $base[$key] = self::deepMerge($base[$key], $value);
            } else {
                $base[$key] = $value;
            }
        }
        return $base;
    }

    /**
     * @param array<mixed> $arr
     */
    private static function isAssoc(array $arr): bool
    {
        if ($arr === []) {
            return true;
        }
        return array_keys($arr) !== range(0, count($arr) - 1);
    }

    /**
     * Get a value via dot-notation key, e.g. `git.author_name`.
     */
    public function get(string $key, mixed $default = null): mixed
    {
        $parts = explode('.', $key);
        $node = $this->data;
        foreach ($parts as $part) {
            if (!is_array($node) || !array_key_exists($part, $node)) {
                return $default;
            }
            $node = $node[$part];
        }
        return $node;
    }

    /**
     * @return array<string,mixed> Full config tree, used by the `/config` endpoint.
     */
    public function all(): array
    {
        return $this->data;
    }

    /**
     * Normalized base path for the middleware (always with leading slash, no trailing slash).
     */
    public function basePath(): string
    {
        $bp = (string)($this->data['base_path'] ?? '/codiware');
        $bp = '/' . ltrim($bp, '/');
        return rtrim($bp, '/') ?: '/';
    }

    /**
     * Absolute base folder used to resolve `repo/{path}` URLs. May be null when only
     * absolute allowed roots are configured.
     */
    public function baseFolder(): ?string
    {
        $bf = $this->data['base_folder'] ?? null;
        if (!is_string($bf) || $bf === '') {
            return null;
        }
        $real = realpath($bf);
        return $real !== false ? $real : $bf;
    }
}
