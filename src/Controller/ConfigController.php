<?php
declare(strict_types=1);

namespace Codiware\Controller;

use Codiware\Config\CodiwareConfig;
use Codiware\Config\UserContext;
use Codiware\Exception\CodiwareException;
use Codiware\Http\Responses;
use Codiware\Service\TranslationService;
use Codiware\Workspace\WorkspaceResolver;
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
        unset($all['allowed_roots']);
        unset($all['deny_patterns']);
        unset($all['base_folder']);

        return $this->responses->ok([
            'base_path' => $this->basePath,
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
