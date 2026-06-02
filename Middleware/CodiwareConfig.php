<?php
declare(strict_types=1);

namespace kabachello\Codiware\Middleware;

/**
 * Codiware configuration with ExFace-like flat key semantics.
 *
 * Keys are normalized to uppercase and use dot notation, e.g. `GIT.BINARY`.
 * Loaded from package defaults + optional JSON file + optional host overrides.
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
        $this->data = self::flattenConfig($data);
    }

    private const DEFAULTS_FILE = __DIR__ . '/../config/defaults.config.json';

    /**
     * Build a config from defaults merged with optional overrides.
     *
     * @param array<string,mixed> $overrides
     */
    public static function fromArray(array $overrides = []): self
    {
        return (new self(self::defaults()))->merge($overrides);
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
     * @return array<string,mixed> Default configuration map.
     */
    public static function defaults(): array
    {
        if (!is_file(self::DEFAULTS_FILE)) {
            throw new \RuntimeException('Codiware defaults file not found: ' . self::DEFAULTS_FILE);
        }
        $raw = file_get_contents(self::DEFAULTS_FILE);
        if ($raw === false) {
            throw new \RuntimeException('Unable to read Codiware defaults file: ' . self::DEFAULTS_FILE);
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('Codiware defaults file is not valid JSON: ' . self::DEFAULTS_FILE);
        }
        return self::flattenConfig($decoded);
    }

    /**
     * Override a single config key.
     */
    public function set(string $key, mixed $value): self
    {
        $this->data[self::normalizeKey($key)] = $value;
        return $this;
    }

    /**
     * Merge nested or flat config arrays into the current config.
     *
     * Nested objects are flattened into `SECTION.KEY` form while list-like arrays
     * and arrays of objects are preserved as values.
     *
     * @param array<string,mixed> $overrides
     */
    public function merge(array $overrides): self
    {
        foreach (self::flattenConfig($overrides) as $key => $value) {
            $this->data[$key] = $value;
        }
        return $this;
    }

    /**
     * Get a value via dot-notation key, e.g. `GIT.AUTHOR_NAME`.
     */
    public function get(string $key, mixed $default = null): mixed
    {
        $normalized = self::normalizeKey($key);
        if (array_key_exists($normalized, $this->data)) {
            return $this->data[$normalized];
        }
        return $default;
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
        $bp = (string)($this->data['URL_TO_API'] ?? '/codiware');
        $bp = '/' . ltrim($bp, '/');
        return rtrim($bp, '/') ?: '/';
    }

    /**
     * Absolute base folder used to resolve `repo/{path}` URLs. May be null when only
     * absolute allowed roots are configured.
     */
    public function baseFolder(): ?string
    {
        $bf = $this->data['BASE_FOLDER'] ?? null;
        if (!is_string($bf) || $bf === '') {
            return null;
        }
        $real = realpath($bf);
        return $real !== false ? $real : $bf;
    }

    private static function normalizeKey(string $key): string
    {
        return strtoupper(trim($key));
    }

    /**
     * @param array<string,mixed> $source
     * @return array<string,mixed>
     */
    private static function flattenConfig(array $source): array
    {
        $out = [];
        self::flattenInto($source, $out);
        return $out;
    }

    /**
     * @param array<string,mixed> $source
     * @param array<string,mixed> $target
     */
    private static function flattenInto(array $source, array &$target, string $prefix = ''): void
    {
        foreach ($source as $key => $value) {
            if (!is_string($key) && !is_int($key)) {
                continue;
            }

            $segment = self::normalizeKey((string)$key);
            $fullKey = $prefix === '' ? $segment : $prefix . '.' . $segment;

            if (is_array($value) && self::isAssociative($value) && !str_contains($fullKey, '.')) {
                self::flattenInto($value, $target, $fullKey);
                continue;
            }
            $target[$fullKey] = $value;
        }
    }

    /**
     * @param array<mixed> $arr
     */
    private static function isAssociative(array $arr): bool
    {
        if ($arr === []) {
            return false;
        }
        return array_keys($arr) !== range(0, count($arr) - 1);
    }
}