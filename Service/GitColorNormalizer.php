<?php
declare(strict_types=1);

namespace kabachello\Codiware\Service;

/**
 * Forces colored output for `git` commands.
 *
 * Git disables ANSI color when its output is not a TTY (which is always the
 * case behind a web server pipe). Injecting `-c color.ui=always` right after
 * the `git` binary makes Git emit color codes that xterm.js can render. The
 * global-config form is used because it is accepted by every subcommand,
 * unlike a per-subcommand `--color` flag.
 *
 * The normalizer is skipped when the first token is not `git` or when the user
 * already forced a color preference (`-c color.*` or `--color`/`--no-color`).
 */
final class GitColorNormalizer implements CommandNormalizerInterface
{
    /**
     * {@inheritDoc}
     * @see \kabachello\Codiware\Service\CommandNormalizerInterface::normalize()
     */
    public function normalize(string $command): string
    {
        $trimmed = ltrim($command);
        if (! preg_match('/^git(\.exe)?\s/i', $trimmed)) {
            return $command;
        }
        // Respect an explicit color choice made by the user.
        if (preg_match('/(^|\s)(-c\s+color\.|--color\b|--no-color\b)/i', $trimmed) === 1) {
            return $command;
        }
        return preg_replace('/^(\s*git(\.exe)?)(\s)/i', '$1 -c color.ui=always$3', $command, 1) ?? $command;
    }
}
