<?php
declare(strict_types=1);

require $argv[1] ?? dirname(__DIR__) . '/vendor/autoload.php';
spl_autoload_register(static function (string $class): void {
    $prefix = 'kabachello\\Codiware\\';
    if (str_starts_with($class, $prefix)) {
        require dirname(__DIR__) . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    }
}, true, true);

use GuzzleHttp\Psr7\HttpFactory;
use GuzzleHttp\Psr7\ServerRequest;
use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Middleware\CodiwareMiddleware;
use kabachello\Codiware\Middleware\UserContext;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Symfony\Component\Process\Process;

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function git(string $cwd, array $args, array $expected = [0]): string
{
    $process = new Process(array_merge(['git'], $args), $cwd);
    $process->run();
    check(in_array($process->getExitCode(), $expected, true), $process->getErrorOutput());
    return $process->getOutput();
}

function removeFixture(string $path): void
{
    foreach (new FilesystemIterator($path, FilesystemIterator::SKIP_DOTS) as $entry) {
        if ($entry->isDir() && !$entry->isLink()) {
            removeFixture($entry->getPathname());
        } else {
            chmod($entry->getPathname(), 0666);
            unlink($entry->getPathname());
        }
    }
    rmdir($path);
}

$fixture = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'codiware-merge-test-' . bin2hex(random_bytes(6));
mkdir($fixture);
$repo = $fixture . DIRECTORY_SEPARATOR . 'main repo';
$tree = $fixture . DIRECTORY_SEPARATOR . 'resolution tree';
mkdir($repo);

try {
    git($repo, ['init', '-b', 'main']);
    git($repo, ['config', 'user.name', 'Merge Test']);
    git($repo, ['config', 'user.email', 'merge@example.invalid']);
    git($repo, ['config', 'core.autocrlf', 'false']);
    foreach (['sample.txt', 'ours-deleted.txt', 'theirs-deleted.txt', 'literal[1].txt', 'denied.key'] as $path) {
        file_put_contents($repo . DIRECTORY_SEPARATOR . $path, "base\n");
    }
    file_put_contents($repo . DIRECTORY_SEPARATOR . 'binary.dat', "base\0data");
    git($repo, ['add', '.']);
    git($repo, ['commit', '-m', 'Base']);
    git($repo, ['checkout', '-b', 'incoming']);
    foreach (['sample.txt', 'ours-deleted.txt', 'literal[1].txt', 'denied.key', 'added.txt'] as $path) {
        file_put_contents($repo . DIRECTORY_SEPARATOR . $path, "incoming\n");
    }
    git($repo, ['rm', 'theirs-deleted.txt']);
    file_put_contents($repo . DIRECTORY_SEPARATOR . 'binary.dat', "incoming\0data");
    git($repo, ['add', '.']);
    git($repo, ['commit', '-m', 'Incoming']);
    git($repo, ['checkout', 'main']);
    foreach (['sample.txt', 'theirs-deleted.txt', 'literal[1].txt', 'denied.key', 'added.txt'] as $path) {
        file_put_contents($repo . DIRECTORY_SEPARATOR . $path, "ours\n");
    }
    git($repo, ['rm', 'ours-deleted.txt']);
    file_put_contents($repo . DIRECTORY_SEPARATOR . 'binary.dat', "ours\0data");
    git($repo, ['add', '.']);
    git($repo, ['commit', '-m', 'Current']);
    git($repo, ['worktree', 'add', '-b', 'resolution', $tree]);
    git($tree, ['merge', 'incoming'], [1]);

    $config = CodiwareConfig::fromArray([
        'ALLOWED_ROOTS' => [['alias' => 'allowed', 'path' => $repo]],
        'DENY_PATTERNS' => ['*.key'],
    ]);
    $factory = new HttpFactory();
    $logger = new class extends \Psr\Log\AbstractLogger {
        public function log($level, $message, array $context = []): void
        {
            if ($level === 'critical') {
                fwrite(STDERR, $message . "\n" . ($context['exception'] ?? '') . "\n");
            }
        }
    };
    $middleware = new CodiwareMiddleware($config, $factory, $factory, logger: $logger, userContext: new UserContext('Resolver', 'resolver@example.invalid'), basePath: '/host/api/ide');
    $next = new class implements RequestHandlerInterface {
        public function handle(ServerRequestInterface $request): ResponseInterface
        {
            throw new RuntimeException('Request unexpectedly passed through');
        }
    };
    $request = static function (string $path, ?array $body = null, ?string $worktree = 'resolution tree', int $status = 200) use ($middleware, $factory, $next): array {
        $query = ['root' => 'allowed', 'path' => $path];
        if ($worktree !== null) {
            $query['worktree'] = $worktree;
        }
        $request = (new ServerRequest($body === null ? 'GET' : 'PUT', '/host/api/ide/git/conflict'))->withQueryParams($query);
        if ($body !== null) {
            $request = $request->withBody($factory->createStream(json_encode(['path' => $path] + $body, JSON_THROW_ON_ERROR)));
        }
        $response = $middleware->process($request, $next);
        $json = json_decode((string)$response->getBody(), true, 512, JSON_THROW_ON_ERROR);
        check($response->getStatusCode() === $status, 'Unexpected API result: ' . json_encode($json));
        return $json['data'] ?? $json['error'];
    };
    $operationRequest = static function (?array $body = null, int $status = 200) use ($middleware, $factory, $next): array {
        $request = (new ServerRequest($body === null ? 'GET' : 'POST', '/host/api/ide/git/' . ($body === null ? 'status' : 'finish-operation')))
            ->withQueryParams(['root' => 'allowed', 'worktree' => 'resolution tree']);
        if ($body !== null) {
            $request = $request->withBody($factory->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        $response = $middleware->process($request, $next);
        $json = json_decode((string)$response->getBody(), true, 512, JSON_THROW_ON_ERROR);
        check($response->getStatusCode() === $status, 'Unexpected operation result: ' . json_encode($json));
        return $json['data'] ?? $json['error'];
    };

    $state = $request('sample.txt');
    $operation = $operationRequest()['operation'];
    check($operation['type'] === 'merge' && !$operation['ready'] && $operation['conflicts'] === 7, 'Merge must expose its unresolved operation and full conflict count');
    $operationRequest(['token' => $operation['token'], 'abort' => false], 409);
    $operationRequest(['token' => 'stale-operation', 'abort' => true], 409);
    check($state['base']['content'] === "base\n", 'Stage 1 must be the common ancestor');
    check($state['ours']['content'] === "ours\n" && $state['theirs']['content'] === "incoming\n", 'Source panes must use stages 2 and 3');
    check(!$state['rebasing'], 'Ordinary merge must not be labelled a rebase');
    check(str_contains($state['result'], '<<<<<<<'), 'Result starts from the actual working file');
    $unmerged = git($tree, ['ls-files', '-u', '--', 'sample.txt']);
    $request('sample.txt', ['content' => $state['result'], 'token' => $state['token'], 'complete' => true], status: 409);
    check(git($tree, ['ls-files', '-u', '--', 'sample.txt']) === $unmerged, 'Unresolved completion must not stage');
    $draft = "edited draft\n<<<<<<< HEAD\nours\n=======\nincoming\n>>>>>>> incoming\n";
    $saved = $request('sample.txt', ['content' => $draft, 'token' => $state['token']]);
    check(!$saved['resolved'] && $saved['token'] !== $state['token'], 'Saving must return an updated snapshot token');
    check(git($tree, ['ls-files', '-u', '--', 'sample.txt']) === $unmerged, 'Saving progress must retain all unmerged stages');
    check(file_get_contents($tree . DIRECTORY_SEPARATOR . 'sample.txt') === $draft, 'Saving writes exactly the draft');
    $request('sample.txt', ['content' => 'stale overwrite', 'token' => $state['token']], status: 409);
    check(file_get_contents($tree . DIRECTORY_SEPARATOR . 'sample.txt') === $draft, 'Stale save must not overwrite progress');
    file_put_contents($tree . DIRECTORY_SEPARATOR . 'sample.txt', "external edit\n");
    $request('sample.txt', ['content' => 'overwrite external', 'token' => $saved['token']], status: 409);
    $state = $request('sample.txt');
    $done = $request('sample.txt', ['content' => "reviewed\n", 'token' => $state['token'], 'complete' => true]);
    check($done['resolved'], 'Completing must mark the result resolved');
    check(git($tree, ['ls-files', '-u', '--', 'sample.txt']) === '', 'Completed path must have no unmerged stages');
    check(git($tree, ['show', ':sample.txt']) === "reviewed\n", 'Index must contain the reviewed result');
    check(file_get_contents($repo . DIRECTORY_SEPARATOR . 'sample.txt') === "ours\n", 'Worktree editing must not touch the main checkout');
    $request('sample.txt', status: 409);

    $added = $request('added.txt');
    check(!$added['base']['exists'] && $added['base']['content'] === '', 'Add/add conflicts have no base, not an API failure');
    $request('added.txt', ['content' => "\xEF\xBB\xBF<<<<<<< HEAD\n", 'token' => $added['token'], 'complete' => true], status: 409);
    $deleted = $request('ours-deleted.txt');
    check(!$deleted['ours']['exists'] && $deleted['theirs']['exists'], 'Deletion on ours must remain explicit');
    $request('ours-deleted.txt', ['content' => '', 'token' => $deleted['token'], 'deleted' => true, 'complete' => true]);
    check(!file_exists($tree . DIRECTORY_SEPARATOR . 'ours-deleted.txt'), 'Deletion choice must delete the working file');
    check(git($tree, ['ls-files', '-u', '--', 'ours-deleted.txt']) === '', 'Deletion choice must resolve the index');
    $deleted = $request('theirs-deleted.txt');
    check(!$deleted['theirs']['exists'], 'Deletion on theirs must remain explicit');
    $request('theirs-deleted.txt', ['content' => '', 'token' => $deleted['token'], 'complete' => true]);
    check(is_file($tree . DIRECTORY_SEPARATOR . 'theirs-deleted.txt'), 'An empty result must not be mistaken for deletion');
    check(git($tree, ['show', ':theirs-deleted.txt']) === '', 'Empty result must be staged as an empty file');
    $literal = $request('literal[1].txt');
    $request('literal[1].txt', ['content' => "literal\n", 'token' => $literal['token'], 'complete' => true]);
    check(git($tree, ['show', ':literal[1].txt']) === "literal\n", 'Git pathspec characters must be treated literally');
    check($request('binary.dat', status: 400)['code'] === 'merge_unsupported', 'Binary conflicts must fail explicitly');
    check($request('denied.key', status: 403)['code'] === 'path_denied', 'Deny patterns must protect conflict blobs');
    $request('..\\outside.txt', status: 403);
    $request('added.txt', ['content' => 42, 'token' => $added['token']], status: 400);
    $request('added.txt', ['content' => '', 'token' => $added['token'], 'deleted' => 'yes'], status: 400);
    $request('added.txt', ['content' => '', 'token' => $added['token'], 'complete' => null], status: 400);

    $index = git($tree, ['ls-files', '-u', '--', 'added.txt']);
    $incomingBlob = trim(git($tree, ['rev-parse', 'incoming:added.txt']));
    $changedIndex = preg_replace('/[0-9a-f]{40}(?= 2\t)/', $incomingBlob, $index);
    $process = new Process(['git', 'update-index', '--index-info'], $tree);
    $process->setInput($changedIndex);
    $process->mustRun();
    $request('added.txt', ['content' => 'stale index overwrite', 'token' => $added['token']], status: 409);
    check(str_contains(file_get_contents($tree . DIRECTORY_SEPARATOR . 'added.txt'), '<<<<<<<'), 'Stale index save must not overwrite the working result');

    $operationRequest(['token' => $operationRequest()['operation']['token'], 'abort' => true]);
    check($operationRequest()['operation'] === null && $operationRequest()['clean'], 'Aborting a merge must restore the checkout and remove the warning state');
    check(file_get_contents($tree . DIRECTORY_SEPARATOR . 'sample.txt') === "ours\n", 'Abort must restore the pre-merge content');
    $operationRequest(['token' => $operation['token'], 'abort' => true], 409);

    $resolveAll = static function () use ($operationRequest, $request): void {
        foreach ($operationRequest()['files'] as $file) {
            if (!$file['conflict']) {
                continue;
            }
            if ($file['path'] === 'binary.dat' || $file['path'] === 'denied.key') {
                continue;
            }
            $state = $request($file['path']);
            $request($file['path'], ['content' => $state['ours']['content'], 'deleted' => !$state['ours']['exists'], 'token' => $state['token'], 'complete' => true]);
        }
    };
    git($tree, ['merge', 'incoming'], [1]);
    $resolveAll();
    foreach (['binary.dat', 'denied.key'] as $path) {
        git($tree, ['checkout', '--ours', '--', $path]);
        git($tree, ['add', '--', $path]);
    }
    $ready = $operationRequest()['operation'];
    check($ready['ready'] && $ready['conflicts'] === 0, 'Merge remains active and ready after its last conflict is staged');
    $operationRequest(['token' => $ready['token'], 'abort' => false, 'message' => 'Reviewed merge']);
    check($operationRequest()['operation'] === null, 'Committing a merge must clear its operation');
    check(count(explode(' ', trim(git($tree, ['rev-list', '--parents', '-1', 'HEAD'])))) === 3, 'Finishing must create a two-parent merge commit even with no staged difference from HEAD');

    git($tree, ['checkout', '-b', 'pick-resolution', 'main']);
    git($tree, ['cherry-pick', 'incoming'], [1]);
    $pick = $operationRequest()['operation'];
    check($pick['type'] === 'cherry-pick' && !$pick['ready'], 'Cherry-pick conflicts must expose the same operation workflow');
    $operationRequest(['token' => $pick['token'], 'abort' => true]);
    check($operationRequest()['operation'] === null && $operationRequest()['clean'], 'Aborting cherry-pick must restore the checkout');
    git($tree, ['cherry-pick', 'incoming'], [1]);
    // Pick incoming content so the cherry-pick is nonempty, and keep original authorship.
    foreach ($operationRequest()['files'] as $file) {
        if ($file['conflict']) {
            $path = $file['path'];
            if ($path === 'theirs-deleted.txt') {
                git($tree, ['rm', '--', $path]);
            } else {
                git($tree, ['checkout', '--theirs', '--', $path]);
                git($tree, ['add', '--', $path]);
            }
        }
    }
    $pick = $operationRequest()['operation'];
    check($pick['ready'] && $pick['type'] === 'cherry-pick', 'Resolved cherry-pick must stay ready until continued');
    $operationRequest(['token' => $pick['token'], 'abort' => false]);
    check($operationRequest()['operation'] === null, 'Cherry-pick continue must finish the sequencer');
    check(trim(git($tree, ['log', '-1', '--format=%s'])) === 'Incoming', 'Cherry-pick must keep the original message');
    check(trim(git($tree, ['log', '-1', '--format=%an|%cn'])) === 'Merge Test|Resolver', 'Cherry-pick must keep original author and use host committer');

    git($repo, ['rebase', 'incoming'], [1]);
    $rebase = $request('sample.txt', worktree: null);
    check($rebase['rebasing'], 'Actual rebase must be identified');
    check($rebase['ours']['content'] === "incoming\n" && $rebase['theirs']['content'] === "ours\n", 'Rebase must report actual Git sides, not guessed branch roles');

    echo "PASS: conflict editing, scoped merge/cherry-pick warning state, abort, completion, original cherry-pick authorship, stale operations and rebase\n";
} finally {
    removeFixture($fixture);
}
