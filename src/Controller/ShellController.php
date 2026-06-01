<?php
declare(strict_types=1);

namespace Codiware\Controller;

use Codiware\Config\CodiwareConfig;
use Codiware\Config\UserContext;
use Codiware\Exception\CodiwareException;
use Codiware\Http\Responses;
use Codiware\Workspace\WorkspaceResolver;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Serves the SPA shell HTML for `GET {basePath}/repo/{workspacePath...}`.
 *
 * The shell HTML embeds a boot configuration object that the JS app reads
 * synchronously to know its base URL, target workspace, theme, locale, and
 * registered extensions. All API calls then go to `{basePath}/...`.
 */
final class ShellController
{
    public function __construct(
        private readonly Responses $responses,
        private readonly CodiwareConfig $config,
        private readonly WorkspaceResolver $resolver,
        private readonly string $basePath,
        private readonly UserContext $user
    ) {
    }

    public function open(ServerRequestInterface $request, array $params = []): ResponseInterface
    {
        $workspacePath = (string)($params['workspacePath'] ?? '');
        if ($workspacePath === '') {
            throw new CodiwareException(
                'No workspace specified.',
                'bad_request',
                400
            );
        }
        $root = $this->resolver->resolve($workspacePath);

        $html = $this->renderShell([
            'base_path' => $this->basePath,
            'workspace' => $root->toArray(),
            'workspace_path' => $workspacePath,
            'user' => [
                'name' => $this->user->name,
                'email' => $this->user->email,
                'id' => $this->user->id,
            ],
            'theme' => [
                'default' => $this->config->get('THEME.DEFAULT', 'light'),
                'allow_user_override' => (bool)$this->config->get('THEME.ALLOW_USER_OVERRIDE', true),
                'skin' => $this->config->get('THEME.SKIN'),
            ],
            'locale' => $this->config->get('TRANSLATIONS.DEFAULT_LOCALE', 'en'),
            'extensions' => $this->config->get('EXTENSIONS.ENABLED', []),
            'editor' => [
                'tab_size' => (int)$this->config->get('EDITOR.TAB_SIZE', 4),
                'word_wrap' => (bool)$this->config->get('EDITOR.WORD_WRAP', false),
            ],
            'file_icons' => [
                'default' => $this->config->get('FILE_ICONS.DEFAULT', 'fa fa-file-o'),
                'folder' => $this->config->get('FILE_ICONS.FOLDER', 'fa fa-folder'),
                'folder_open' => $this->config->get('FILE_ICONS.FOLDER_OPEN', 'fa fa-folder-open'),
                'by_name' => $this->config->get('FILE_ICONS.BY_NAME', new \stdClass()),
                'by_ext' => $this->config->get('FILE_ICONS.BY_EXT', new \stdClass()),
            ],
            'features' => [
                'git' => (bool)$this->config->get('GIT.ENABLED', true),
                'console' => (bool)$this->config->get('CONSOLE.ENABLED', true),
            ],
        ]);

        return $this->responses->raw(200, $html, 'text/html; charset=utf-8', [
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    /**
     * @param array<string,mixed> $boot
     */
    private function renderShell(array $boot): string
    {
        $shellFile = dirname(__DIR__, 2) . '/public/index.html';
        if (!is_file($shellFile)) {
            // Fall back to a minimal inline shell if assets are not yet installed.
            return $this->fallbackHtml($boot);
        }
        $template = (string)file_get_contents($shellFile);
        $json = json_encode($boot, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        // The marker pair brackets a fallback `null` so the JS is still valid before substitution.
        $out = preg_replace_callback(
            '~/\*__CODIWARE_BOOT__\*/.*?/\*__/CODIWARE_BOOT__\*/~s',
            static fn (): string => $json,
            $template,
            1
        );
        return $out ?? $template;
    }

    /**
     * @param array<string,mixed> $boot
     */
    private function fallbackHtml(array $boot): string
    {
        $json = htmlspecialchars(
            json_encode($boot, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) ?: '{}',
            ENT_QUOTES | ENT_SUBSTITUTE,
            'UTF-8'
        );
        return <<<HTML
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Codiware</title>
<style>body{font-family:sans-serif;padding:2rem;color:#222}pre{background:#f4f4f4;padding:1rem;overflow:auto}</style>
</head><body>
<h1>Codiware</h1>
<p>The SPA shell has not been built yet. Boot configuration:</p>
<pre>{$json}</pre>
</body></html>
HTML;
    }
}
