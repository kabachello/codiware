<?php
declare(strict_types=1);

namespace Codiware\Service;

use Codiware\Config\CodiwareConfig;
use Codiware\Exception\CodiwareException;
use Codiware\Workspace\WorkspaceRoot;
use Psr\Log\LoggerInterface;
use Symfony\Component\Process\Process;

/**
 * Runs whitelisted shell commands inside a workspace.
 *
 * Policy is deny-by-default: a command runs only if its label matches a
 * configured preset OR the command string matches one of the `allow_patterns`
 * regular expressions. All executions are logged.
 */
final class ConsoleService
{
    /** @var array<int,array{label:string,command:string}> */
    private array $presets;

    /** @var string[] */
    private array $allowPatterns;

    private int $timeout;

    public function __construct(
        private readonly CodiwareConfig $config,
        private readonly LoggerInterface $logger
    ) {
        $rawPresets = $config->get('CONSOLE.PRESETS', []);
        $this->presets = is_array($rawPresets) ? array_values(array_filter(
            $rawPresets,
            fn($p) => is_array($p) && isset($p['label'], $p['command'])
        )) : [];
        $patterns = $config->get('CONSOLE.ALLOW_PATTERNS', []);
        $this->allowPatterns = is_array($patterns)
            ? array_values(array_filter($patterns, 'is_string'))
            : [];
        $this->timeout = max(1, (int)($config->get('CONSOLE.TIMEOUT_SECONDS', 300) ?? 300));
    }

    /**
     * @return array<int,array{label:string,command:string}>
     */
    public function presets(): array
    {
        return $this->presets;
    }

    /**
     * Execute a command inside `$root`. The caller may pass either a preset label
     * (matched against the configured presets) or a raw command string.
     *
     * @return array{command:string,exit_code:int,stdout:string,stderr:string,timed_out:bool}
     */
    public function run(WorkspaceRoot $root, string $command, ?string $presetLabel = null): array
    {
        if ($this->config->get('CONSOLE.ENABLED', true) !== true) {
            throw new CodiwareException('Console is disabled by configuration.', 'console_disabled', 403);
        }

        $resolved = $command;
        if ($presetLabel !== null && $presetLabel !== '') {
            $preset = $this->findPreset($presetLabel);
            if ($preset === null) {
                throw new CodiwareException(
                    'Unknown preset: ' . $presetLabel,
                    'unknown_preset',
                    400,
                    ['preset' => $presetLabel]
                );
            }
            $resolved = $preset['command'];
        }

        $resolved = trim($resolved);
        if ($resolved === '') {
            throw new CodiwareException('Command must not be empty.', 'bad_request', 400);
        }

        if (!$this->isAllowed($resolved, $presetLabel !== null)) {
            $this->logger->warning('Codiware console rejected command', [
                'command' => $resolved,
                'workspace' => $root->alias,
            ]);
            throw new CodiwareException(
                'Command is not allowed by configuration.',
                'command_denied',
                403,
                ['command' => $resolved]
            );
        }

        $this->logger->info('Codiware console execute', [
            'command' => $resolved,
            'workspace' => $root->alias,
            'preset' => $presetLabel,
        ]);

        // We run through the system shell so users can use pipes/redirection within
        // allowed patterns. The pattern allowlist is the security boundary.
        $process = Process::fromShellCommandline($resolved, $root->path);
        $process->setTimeout((float)$this->timeout);
        $timedOut = false;
        try {
            $process->run();
        } catch (\Symfony\Component\Process\Exception\ProcessTimedOutException) {
            $timedOut = true;
        }

        return [
            'command' => $resolved,
            'exit_code' => (int)($process->getExitCode() ?? -1),
            'stdout' => $process->getOutput(),
            'stderr' => $process->getErrorOutput(),
            'timed_out' => $timedOut,
        ];
    }

    /**
     * @return array{label:string,command:string}|null
     */
    private function findPreset(string $label): ?array
    {
        foreach ($this->presets as $p) {
            if ($p['label'] === $label) {
                return $p;
            }
        }
        return null;
    }

    private function isAllowed(string $command, bool $fromPreset): bool
    {
        if ($fromPreset) {
            // Presets are explicitly configured by the operator, so they are trusted.
            return true;
        }
        foreach ($this->allowPatterns as $pattern) {
            $regex = '~' . str_replace('~', '\~', $pattern) . '~i';
            if (@preg_match($regex, $command) === 1) {
                return true;
            }
        }
        return false;
    }
}
