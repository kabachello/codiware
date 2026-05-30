<?php
declare(strict_types=1);

namespace Codiware\Http;

use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * Helpers for building JSON, error and empty responses with a consistent shape.
 *
 * All API endpoints return either:
 *   - 2xx with `{ "data": ... }` on success
 *   - 4xx/5xx with `{ "error": { "code": "...", "message": "...", "details": {...} } }`
 */
final class Responses
{
    public function __construct(
        private readonly ResponseFactoryInterface $responseFactory,
        private readonly StreamFactoryInterface $streamFactory
    ) {
    }

    /**
     * @param mixed $data
     */
    public function json(mixed $data, int $status = 200, array $headers = []): ResponseInterface
    {
        $body = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            $body = '{"error":{"code":"encoding_failed","message":"Could not encode response body."}}';
            $status = 500;
        }
        $response = $this->responseFactory->createResponse($status)
            ->withHeader('Content-Type', 'application/json; charset=utf-8')
            ->withHeader('Cache-Control', 'no-store')
            ->withBody($this->streamFactory->createStream($body));
        foreach ($headers as $name => $value) {
            $response = $response->withHeader($name, $value);
        }
        return $response;
    }

    /**
     * @param array<string,mixed> $details
     */
    public function error(int $status, string $code, string $message, array $details = []): ResponseInterface
    {
        return $this->json([
            'error' => [
                'code' => $code,
                'message' => $message,
                'details' => $details,
            ],
        ], $status);
    }

    /**
     * @param mixed $data
     */
    public function ok(mixed $data = null): ResponseInterface
    {
        return $this->json(['data' => $data], 200);
    }

    public function notFound(string $message = 'Not found.'): ResponseInterface
    {
        return $this->error(404, 'not_found', $message);
    }

    public function methodNotAllowed(string $message = 'Method not allowed.'): ResponseInterface
    {
        return $this->error(405, 'method_not_allowed', $message);
    }

    public function badRequest(string $message, array $details = []): ResponseInterface
    {
        return $this->error(400, 'bad_request', $message, $details);
    }

    public function forbidden(string $message, array $details = []): ResponseInterface
    {
        return $this->error(403, 'forbidden', $message, $details);
    }

    public function serverError(string $message, array $details = []): ResponseInterface
    {
        return $this->error(500, 'server_error', $message, $details);
    }

    public function noContent(): ResponseInterface
    {
        return $this->responseFactory->createResponse(204);
    }

    public function raw(int $status, string $body, string $contentType, array $headers = []): ResponseInterface
    {
        $response = $this->responseFactory->createResponse($status)
            ->withHeader('Content-Type', $contentType)
            ->withBody($this->streamFactory->createStream($body));
        foreach ($headers as $name => $value) {
            $response = $response->withHeader($name, $value);
        }
        return $response;
    }

    public function stream(int $status, $resource, string $contentType, array $headers = []): ResponseInterface
    {
        $response = $this->responseFactory->createResponse($status)
            ->withHeader('Content-Type', $contentType)
            ->withBody($this->streamFactory->createStreamFromResource($resource));
        foreach ($headers as $name => $value) {
            $response = $response->withHeader($name, $value);
        }
        return $response;
    }

    public function streamFactory(): StreamFactoryInterface
    {
        return $this->streamFactory;
    }

    public function responseFactory(): ResponseFactoryInterface
    {
        return $this->responseFactory;
    }
}
