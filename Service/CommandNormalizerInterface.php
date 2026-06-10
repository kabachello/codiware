<?php
declare(strict_types=1);

namespace kabachello\Codiware\Service;

/**
 * Tweaks a resolved shell command before it is executed by the console.
 *
 * Normalizers keep command-family specifics (e.g. forcing Git color output)
 * out of the generic console core. They are applied in order; each receives
 * the command produced by the previous one. A normalizer that does not apply
 * must return the command unchanged.
 */
interface CommandNormalizerInterface
{
    /**
     * Return the (possibly rewritten) command string.
     */
    public function normalize(string $command): string;
}
