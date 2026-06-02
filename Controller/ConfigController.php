<?php
declare(strict_types=1);

namespace kabachello\Codiware\Controller;

use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Middleware\UserContext;
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Http\Responses;
use kabachello\Codiware\Service\TranslationService;
use kabachello\Codiware\Workspace\WorkspaceResolver;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Exposes configuration metadata and translation bundles to the SPA.
 */
final class ConfigController
{
    public function __construct(
        private readonly Responses $responses,
        private readonly CodiwareConfig $config,
        private readonly TranslationService $translations,
        private readonly UserContext $user,
        private readonly string $basePath
    ) {
    }

    public function getConfig(ServerRequestInterface $request): ResponseInterface
    {
        $all = $this->config->all();
        // Drop internal/operator-only fields before exposing to the browser.
        unset($all['ALLOWED_ROOTS']);
        unset($all['DENY_PATTERNS']);
        unset($all['BASE_FOLDER']);

        return $this->responses->ok([
            'url_base' => $this->basePath,
            'config' => $all,
            'user' => [
                'name' => $this->user->name,
                'email' => $this->user->email,
                'id' => $this->user->id,
                'has_git_identity' => $this->user->hasGitIdentity(),
            ],
        ]);
    }

    public function getTranslations(ServerRequestInterface $request, array $params = []): ResponseInterface
    {
        $locale = isset($params['locale']) ? (string)$params['locale'] : '';
        if ($locale === '') {
            throw new CodiwareException('Locale is required.', 'bad_request', 400);
        }
        return $this->responses->ok([
            'locale' => $locale,
            'messages' => $this->translations->load($locale),
        ]);
    }
}