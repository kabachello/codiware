<?php
declare(strict_types=1);

namespace Codiware\Exception;

/**
 * Thrown when a request is rejected for security or input-validation reasons.
 *
 * Carries an HTTP status, a stable error code, and optional details that are
 * safe to expose to the client.
 */
class CodiwareException extends \RuntimeException
{
    /**
     * @param array<string,mixed> $details
     */
    public function __construct(
        string $message,
        public readonly string $errorCode = 'codiware_error',
        public readonly int $httpStatus = 500,
        public readonly array $details = [],
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, 0, $previous);
    }
}
