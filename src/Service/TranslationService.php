<?php
declare(strict_types=1);

namespace Codiware\Service;

use Codiware\Exception\CodiwareException;

/**
 * Loads UI translation bundles for the SPA shell.
 *
 * Translation files are simple JSON dictionaries kept under `translations/`
 * relative to the package root (resolved via reflection at construction time).
 * Hosts can pass additional lookup directories so apps can ship overrides.
 */
final class TranslationService
{
    /** @var string[] */
    private array $directories;

    /**
     * @param string[] $extraDirectories Optional additional directories searched
     *                                   before the bundled translations.
     */
    public function __construct(array $extraDirectories = [])
    {
        $packageRoot = dirname(__DIR__, 2);
        $this->directories = array_values(array_filter(array_merge(
            $extraDirectories,
            [$packageRoot . DIRECTORY_SEPARATOR . 'translations']
        ), 'is_string'));
    }

    /**
     * @return array<string,string>
     */
    public function load(string $locale): array
    {
        $locale = $this->sanitizeLocale($locale);
        $merged = [];
        $found = false;
        foreach (array_reverse($this->directories) as $dir) {
            $file = $dir . DIRECTORY_SEPARATOR . $locale . '.json';
            if (!is_file($file)) {
                continue;
            }
            $found = true;
            $raw = @file_get_contents($file);
            if ($raw === false) {
                continue;
            }
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                foreach ($decoded as $k => $v) {
                    if (is_string($k) && is_string($v)) {
                        $merged[$k] = $v;
                    }
                }
            }
        }
        if (!$found && $locale !== 'en') {
            // Fall back to English so the UI is never empty.
            return $this->load('en');
        }
        return $merged;
    }

    private function sanitizeLocale(string $locale): string
    {
        if (preg_match('/^[a-zA-Z]{2}(?:[-_][a-zA-Z0-9]{2,8})?$/', $locale) !== 1) {
            throw new CodiwareException(
                'Invalid locale code.',
                'bad_request',
                400,
                ['locale' => $locale]
            );
        }
        return str_replace('_', '-', strtolower($locale));
    }
}
