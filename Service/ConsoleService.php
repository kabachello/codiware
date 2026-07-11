<?php
declare(strict_types=1);

namespace kabachello\Codiware\Service;

use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Workspace\WorkspaceRoot;
use Psr\Log\LoggerInterface;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessTimedOutException;

/**
 * Runs whitelisted shell commands inside a workspace and streams their output
 * incrementally (line-by-line) as they run.
 *
 * Policy is deny-by-default: a command runs only if its label matches a
 * configured preset OR the command string matches one of the `allow_patterns`
 * regular expressions. All executions are logged.
 *
 * Output is forwarded verbatim (ANSI escape codes preserved) so a terminal
 * front-end such as xterm.js can render colors. Command-family tweaks (e.g.
 * forcing Git color) are applied through injected
 * {@see CommandNormalizerInterface} implementations, keeping this service
 * generic.
 */
final class ConsoleService
{
    /** @var array<int,array{label:string,command:string}> */
    private array $presets;

    /** @var string[] */
    private array $allowPatterns;

    private int $timeout;

    /** @var CommandNormalizerInterface[] */
    private array $normalizers;

    /**
     * @param CommandNormalizerInterface[] $normalizers Applied (in order) to the
     *        resolved command before execution. Defaults to a {@see GitColorNormalizer}.
     */
    public function __construct(
        private readonly CodiwareConfig $config,
        private readonly LoggerInterface $logger,
        array $normalizers = []
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
        $this->normalizers = $normalizers === [] ? [new GitColorNormalizer()] : $normalizers;
    }

    /**
     * @return array<int,array{label:string,command:string}>
     */
    public function presets(): array
    {
        return $this->presets;
    }

    /**
     * Validate and resolve a command, then return a generator that yields its
     * output incrementally as the process runs.
     *
     * Validation (enabled flag, preset resolution, allow-list, empty check) runs
     * synchronously, so a rejected command throws before any streaming response
     * is started. The returned generator drives the process and yields raw output
     * buffers (ANSI preserved) on each iteration.
     *
     * @return \Generator<int,string>
     * @throws CodiwareException If the console is disabled or the command is not allowed.
     */
    public function stream(WorkspaceRoot $root, string $command, ?string $presetLabel = null): \Generator
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

        $resolved = $this->applyNormalizers($resolved);

        $this->logger->info('Codiware console execute', [
            'command' => $resolved,
            'workspace' => $root->alias,
            'preset' => $presetLabel,
        ]);

        return $this->streamProcess($resolved, $root->path);
    }

    /**
     * Apply the configured command normalizers in order.
     */
    public function applyNormalizers(string $command): string
    {
        foreach ($this->normalizers as $normalizer) {
            $command = $normalizer->normalize($command);
        }
        return $command;
    }

    /**
     * Drive a Symfony Process and yield its incremental output buffers.
     *
     * The process is tied to this single streaming request: when the client
     * aborts, the emitter stops reading the stream, the generator is destroyed
     * and the process is terminated by Symfony's destructor.
     *
     * @return \Generator<int,string>
     */
    private function streamProcess(string $command, string $cwd): \Generator
    {
        self::setupStreaming();

        // Run through the system shell so users can use pipes/redirection within
        // allowed patterns. The pattern allow-list is the security boundary.
        $process = Process::fromShellCommandline($command, $cwd, $this->buildEnv(), null, (float)$this->timeout);
        $process->start();

        try {
            foreach ($process as $type => $buffer) {
                if ($buffer !== '') {
                    yield $buffer;
                }
            }
        } catch (ProcessTimedOutException) {
            yield "\r\n\x1b[31m[command timed out after {$this->timeout}s]\x1b[0m\r\n";
            if ($process->isRunning()) {
                $process->stop(0);
            }
        }
    }

    /**
     * Environment variables that coax CLI tools into emitting ANSI colors even
     * when stdout is a non-interactive pipe.
     *
     * @return array<string,string>
     */
    private function buildEnv(): array
    {
        return [
            'FORCE_COLOR' => '1',
            'TERM' => 'xterm-256color',
        ];
    }

    /**
     * Configure PHP so the streaming response body is flushed to the client
     * incrementally instead of being buffered. Modeled on ExFace's
     * `WebConsoleFacade::setupStreaming()`.
     */
    private static function setupStreaming(): void
    {
        @ob_end_clean();
        if (ini_get('zlib.output_compression') == 1) {
            @ini_set('zlib.output_compression', 'Off');
        }
        @set_time_limit(0);
        @ob_implicit_flush(true);
        @ob_end_flush();
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
