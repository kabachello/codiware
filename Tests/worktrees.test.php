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
use kabachello\Codiware\Exception\CodiwareException;
use kabachello\Codiware\Middleware\CodiwareConfig;
use kabachello\Codiware\Middleware\CodiwareMiddleware;
use kabachello\Codiware\Middleware\UserContext;
use kabachello\Codiware\Service\GitService;
use kabachello\Codiware\Workspace\PathGuard;
use kabachello\Codiware\Workspace\WorkspaceResolver;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Psr\Log\NullLogger;
use Symfony\Component\Process\Process;

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function git(string $cwd, array $args): string
{
    $process = new Process(array_merge(['git'], $args), $cwd);
    $process->mustRun();
    return trim($process->getOutput());
}

function rejects(callable $action, string $code): void
{
    try {
        $action();
    } catch (CodiwareException $error) {
        check($error->errorCode === $code, 'Unexpected error: ' . $error->getMessage());
        return;
    }
    throw new RuntimeException('Expected ' . $code);
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

$fixture = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'codiware-worktree-test-' . bin2hex(random_bytes(6));
mkdir($fixture);
$repo = $fixture . DIRECTORY_SEPARATOR . 'repo with spaces';
mkdir($repo);

try {
    git($repo, ['init', '-b', 'main']);
    git($repo, ['config', 'user.name', 'Codiware Test']);
    git($repo, ['config', 'user.email', 'test@example.invalid']);
    file_put_contents($repo . '/sample.txt', 'main content');
    git($repo, ['add', 'sample.txt']);
    git($repo, ['commit', '-m', 'Initial fixture']);
    git($repo, ['branch', 'other']);

    $config = CodiwareConfig::fromArray([
        'ALLOWED_ROOTS' => [['alias' => 'sample/repo', 'path' => $repo, 'label' => 'Sample']],
        'CONSOLE.ALLOW_PATTERNS' => ['^git\s+rev-parse\b'],
    ]);
    $service = new GitService($config, new NullLogger());
    $resolver = new WorkspaceResolver($config, $service);
    $root = $resolver->resolve('sample/repo');
    check(count($service->worktrees($root)) === 1, 'A plain repository has only its main entry');

    $external = $fixture . DIRECTORY_SEPARATOR . 'external tree';
    git($repo, ['worktree', 'add', '-b', 'external', $external]);
    $tree = $resolver->rootByAlias('sample/repo', 'external tree');
    check($tree->path === realpath($external), 'Registered external worktrees must resolve');
    check($tree->toArray()['is_git'], '.git files must count as Git repositories');
    file_put_contents($external . '/sample.txt', 'worktree content');
    rejects(fn () => $resolver->rootByAlias('sample/repo', '../outside'), 'worktree_not_found');
    rejects(fn () => $resolver->rootByAlias('unapproved', 'external tree'), 'workspace_not_allowed');
    rejects(fn () => (new PathGuard($config))->resolveInside($tree, '../repo with spaces/sample.txt'), 'path_denied');

    $factory = new HttpFactory();
    $next = new class implements RequestHandlerInterface {
        public function handle(ServerRequestInterface $request): ResponseInterface
        {
            throw new RuntimeException('Request unexpectedly passed through');
        }
    };
    $request = static function (string $path, array $query = [], ?array $body = null, ?string $method = null, string $basePath = '/codiware') use ($config, $factory, $next): ResponseInterface {
        $middleware = new CodiwareMiddleware($config, $factory, $factory, userContext: new UserContext('Merge Tester', 'merge@example.invalid'), basePath: $basePath);
        $request = (new ServerRequest($method ?? ($body === null ? 'GET' : 'POST'), $basePath . $path))
            ->withQueryParams($query);
        if ($body !== null) {
            $request = $request->withBody($factory->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        return $middleware->process($request, $next);
    };
    $boot = static function (ResponseInterface $response): array {
        check($response->getStatusCode() === 200, 'Shell must return 200');
        preg_match('/window\.CODIWARE_BOOT = (.*?);<\/script>/s', (string)$response->getBody(), $matches);
        return json_decode($matches[1], true, 512, JSON_THROW_ON_ERROR);
    };
    $plain = $fixture . DIRECTORY_SEPARATOR . 'plain';
    mkdir($plain);
    $config->set('ALLOWED_ROOTS', [
        ['alias' => 'sample/repo', 'path' => $repo, 'label' => 'Sample'],
        ['alias' => 'plain', 'path' => $plain, 'label' => 'Plain folder'],
    ]);
    $config->set('GIT.ALLOW_WORKTREE_URL_PARAMETER', true)->set('GIT.ALLOW_BRANCH_URL_PARAMETER', true);
    foreach (['/repo/plain', '/repo/plain/worktrees/missing/'] as $entry) {
        $nonGit = $boot($request($entry, ['worktree' => 'missing', 'branch' => 'other']));
        check(!$nonGit['workspace']['is_git'], 'A plain folder must not enable Git UI');
        check($nonGit['worktree'] === null && $nonGit['git']['worktree_error'] === null, 'Plain folders must not expose worktree state or errors');
        check($nonGit['git']['initial_status'] === null && $nonGit['requested_branch'] === '', 'Plain folders must not bootstrap Git operations');
    }
    $config->set('GIT.ENABLED', false);
    $disabledGit = $boot($request('/repo/sample/repo', ['worktree' => 'external tree', 'branch' => 'other']));
    check(!$disabledGit['features']['git'] && $disabledGit['worktree'] === null && $disabledGit['git']['initial_status'] === null, 'Disabling Git must also disable all worktree bootstrap');
    check(git($repo, ['branch', '--show-current']) === 'main', 'Disabled Git must never switch branches from URL parameters');
    $config->set('GIT.ENABLED', true)->set('GIT.ALLOW_WORKTREE_URL_PARAMETER', false)->set('GIT.ALLOW_BRANCH_URL_PARAMETER', false);

    $ignored = $boot($request('/repo/sample/repo', ['worktree' => 'external tree', 'branch' => 'other']));
    check($ignored['worktree'] === null && $ignored['git']['initial_status']['branch'] === 'main', 'Both URL parameters must default to disabled');
    $config->set('GIT.ALLOW_WORKTREE_URL_PARAMETER', true);
    $selected = $boot($request('/repo/sample/repo', ['worktree' => 'external tree', 'branch' => 'other']));
    check($selected['workspace']['path'] === realpath($external), 'Worktree deep link must select the directory');
    check($selected['git']['initial_status']['branch'] === 'external', 'Worktree opt-in must not enable branch links');
    $config->set('GIT.ALLOW_BRANCH_URL_PARAMETER', true);
    $combined = $boot($request('/repo/sample/repo', ['worktree' => 'external tree', 'branch' => 'other']));
    check($combined['git']['initial_status']['branch'] === 'other', 'Combined links must switch the branch in the selected worktree');
    check(git($repo, ['branch', '--show-current']) === 'main', 'Combined links must not switch the main branch');
    git($external, ['checkout', 'external']);
    $missing = $boot($request('/repo/sample/repo', ['worktree' => 'missing', 'branch' => 'other']));
    check($missing['worktree'] === null && str_contains($missing['git']['worktree_error'], 'missing'), 'Missing worktree must yield a boot error');
    check($missing['git']['initial_status']['branch'] === 'main', 'Missing worktree must not switch the fallback repository branch');
    $xss = $request('/repo/sample/repo', ['worktree' => '</script><script>alert(1)</script>']);
    check(!str_contains((string)$xss->getBody(), '</script><script>alert(1)'), 'Worktree error must be safe inside the boot script');
    $switched = $boot($request('/repo/sample/repo', ['branch' => 'other']));
    check($switched['git']['initial_status']['branch'] === 'other', 'Enabled branch parameter must still work');
    git($repo, ['checkout', 'main']);

    $scope = ['root' => 'sample/repo', 'worktree' => 'external tree'];
    $read = json_decode((string)$request('/files/read', $scope + ['path' => 'sample.txt'])->getBody(), true, 512, JSON_THROW_ON_ERROR);
    check($read['data']['content'] === 'worktree content', 'File API must read the selected worktree');
    $write = $request('/files/write', $scope, ['path' => 'sample.txt', 'content' => 'updated tree'], 'PUT');
    check($write->getStatusCode() === 200, 'File API must write the selected worktree: ' . $write->getBody());
    check(file_get_contents($external . '/sample.txt') === 'updated tree', 'Write must update the linked worktree');
    check(file_get_contents($repo . '/sample.txt') === 'main content', 'Write must leave the main repository untouched');
    check($request('/git/status', $scope)->getStatusCode() === 200, 'Git API must accept worktree scope');
    $search = (string)$request('/search', $scope + ['q' => 'updated tree'])->getBody();
    check(str_contains($search, 'updated tree'), 'Search must use the selected worktree');
    $console = $request('/console/run', $scope, ['command' => 'git rev-parse --show-toplevel']);
    check($console->getStatusCode() === 200, 'Console must accept worktree scope');
    $consolePath = trim((string)$console->getBody());
    check(realpath($consolePath) === realpath($external), 'Console working directory must be the selected worktree: ' . $consolePath);
    check($request('/files/read', ['root' => 'sample/repo', 'worktree' => 'missing', 'path' => 'sample.txt'])->getStatusCode() === 404, 'Stale API scope must fail, never silently read main');

    $config->set('GIT.ALLOW_WORKTREE_URL_PARAMETER', false);
    check($request('/worktrees/external%20tree/repo/sample/repo')->getStatusCode() === 404, 'Worktree-first URLs must not be supported');
    foreach (['/repo/sample/repo/worktrees/external%20tree', '/repo/sample/repo/worktrees/external%20tree/'] as $entry) {
        $interactive = $boot($request($entry));
        check($interactive['worktree'] === 'external tree', 'Interactive route must work with URL parameters disabled');
        check($interactive['workspace_path'] === 'sample/repo', 'Worktree route must preserve the nested repository alias');
        check($interactive['workspace']['path'] === realpath($external), 'Interactive route must open the linked worktree');
    }
    $mounted = $boot($request('/repo/sample/repo/worktrees/external%20tree/', basePath: '/exface/exface/api/ide/codiware'));
    check($mounted['url_to_api'] === '/exface/exface/api/ide/codiware' && $mounted['worktree'] === 'external tree', 'Worktree route must support the ExFace mount path');
    $missingInteractive = $boot($request('/repo/sample/repo/worktrees/missing/'));
    check($missingInteractive['worktree'] === null && str_contains($missingInteractive['git']['worktree_error'], 'missing'), 'Missing worktree suffix must show a worktree error, not resolve as a repository');
    check($boot($request('/repo/sample/repo', ['worktree' => 'external tree']))['worktree'] === null, 'Disabled deep link must still be ignored');

    rejects(fn () => $service->deleteWorktree($root, 'external tree'), 'git_failed');
    rejects(fn () => $service->deleteWorktree($tree, 'external tree'), 'worktree_current');
    git($external, ['checkout', '--', 'sample.txt']);
    git($repo, ['worktree', 'lock', $external]);
    check($service->worktrees($root)[1]['locked'], 'Locked flag must be parsed');
    rejects(fn () => $service->deleteWorktree($root, 'external tree'), 'git_failed');
    git($repo, ['worktree', 'unlock', $external]);

    mkdir($fixture . '/duplicate');
    $duplicate = $fixture . '/duplicate/external tree';
    git($repo, ['worktree', 'add', '-b', 'duplicate', $duplicate]);
    rejects(fn () => $resolver->rootByAlias('sample/repo', 'external tree'), 'worktree_ambiguous');
    git($repo, ['worktree', 'remove', $duplicate]);

    $created = $request('/git/create-worktree', ['root' => 'sample/repo'], ['title' => 'new-tree']);
    check($created->getStatusCode() === 200, 'Create endpoint must succeed: ' . $created->getBody());
    $new = $resolver->rootByAlias('sample/repo', 'new-tree');
    check($new->path === realpath($repo . '.worktrees/new-tree'), 'Creation must use the main repository sibling directory');
    check(git($new->path, ['branch', '--show-current']) === 'new-tree', 'Creation must create the matching branch');
    rejects(fn () => $service->createWorktree($root, '../escape'), 'worktree_title_invalid');
    rejects(fn () => $service->createWorktree($root, 'new-tree'), 'worktree_exists');
    rejects(fn () => $service->deleteWorktree($root, 'repo with spaces'), 'worktree_not_found');
    $deleted = $request('/git/delete-worktree', ['root' => 'sample/repo'], ['title' => 'new-tree']);
    check($deleted->getStatusCode() === 200 && !is_dir($new->path), 'Delete endpoint must remove the directory');
    check(git($repo, ['branch', '--list', 'new-tree']) === 'new-tree', 'Deleting a worktree must retain its branch');

    $cleanup = $fixture . DIRECTORY_SEPARATOR . 'cleanup-folder';
    git($repo, ['worktree', 'add', '-b', 'agents/cleanup-branch', $cleanup]);
    rejects(fn () => $service->deleteWorktree($root, 'cleanup-folder', 'wrong-branch'), 'worktree_branch_changed');
    check(is_dir($cleanup), 'A changed branch must keep the worktree');
    file_put_contents($cleanup . '/cleanup.txt', 'Unmerged work');
    git($cleanup, ['add', 'cleanup.txt']);
    git($cleanup, ['commit', '-m', 'Cleanup fixture']);
    rejects(fn () => $service->deleteWorktree($root, 'cleanup-folder', 'agents/cleanup-branch'), 'worktree_branch_unmerged');
    check(is_dir($cleanup) && git($repo, ['branch', '--list', 'agents/cleanup-branch']) !== '', 'Unmerged refusal must retain both targets');
    git($repo, ['merge', '--ff-only', 'agents/cleanup-branch']);
    git($cleanup, ['branch', '--set-upstream-to=other']);
    rejects(fn () => $service->deleteWorktree($root, 'cleanup-folder', 'agents/cleanup-branch'), 'worktree_branch_unmerged');
    check(is_dir($cleanup), 'Unmerged upstream must be detected before removing the worktree');
    git($cleanup, ['branch', '--unset-upstream']);
    file_put_contents($cleanup . '/dirty.txt', 'Keep dirty files');
    rejects(fn () => $service->deleteWorktree($root, 'cleanup-folder', 'agents/cleanup-branch'), 'git_failed');
    check(is_file($cleanup . '/dirty.txt'), 'Combined cleanup must not force removal of dirty worktrees');
    unlink($cleanup . '/dirty.txt');
    git($repo, ['worktree', 'lock', $cleanup]);
    rejects(fn () => $service->deleteWorktree($root, 'cleanup-folder', 'agents/cleanup-branch'), 'git_failed');
    git($repo, ['worktree', 'unlock', $cleanup]);
    $cleanupResponse = $request('/git/delete-worktree', ['root' => 'sample/repo'], ['title' => 'cleanup-folder', 'branch' => 'agents/cleanup-branch']);
    check($cleanupResponse->getStatusCode() === 200, 'Combined cleanup endpoint must succeed: ' . $cleanupResponse->getBody());
    check(!is_dir($cleanup) && git($repo, ['branch', '--list', 'agents/cleanup-branch']) === '', 'Combined cleanup must delete the actual branch, not the folder name');
    $detached = $fixture . DIRECTORY_SEPARATOR . 'detached-cleanup';
    git($repo, ['worktree', 'add', '--detach', $detached]);
    rejects(fn () => $service->deleteWorktree($root, 'detached-cleanup', 'main'), 'worktree_branch_changed');
    git($repo, ['worktree', 'remove', $detached]);
    $cleanupRoot = $resolver->rootByAlias('sample/repo', 'external tree');
    rejects(fn () => $service->deleteWorktree($cleanupRoot, 'external tree', 'external'), 'worktree_current');

    check($service->status($root)['worktree_merge'] === null, 'Main checkout must not offer merge-back');
    rejects(fn () => $service->mergeWorktree($root, [], null, null), 'worktree_merge_requires_worktree');
    check($service->worktreeMergeState($tree)['commits'] === 0, 'Identical worktrees have no commits to merge');
    file_put_contents($external . '/feature.txt', 'Feature commit');
    git($external, ['add', 'feature.txt']);
    git($external, ['commit', '-m', 'Feature']);
    $pending = $service->status($tree)['worktree_merge'];
    check($pending['commits'] === 1 && $pending['target_branch'] === 'main', 'Count must compare committed ancestry to main checkout');
    $sourceGit = git($external, ['rev-parse', '--absolute-git-dir']);
    file_put_contents($sourceGit . '/CHERRY_PICK_HEAD', $pending['source_head']);
    check($service->worktreeMergeState($tree)['blocked_reason'] === 'source_busy', 'Unfinished source operations must block merge-back');
    rejects(fn () => $service->mergeWorktree($tree, $pending, null, null), 'worktree_merge_blocked');
    unlink($sourceGit . '/CHERRY_PICK_HEAD');
    file_put_contents($repo . '/untracked.txt', 'Keep me');
    check($service->worktreeMergeState($tree)['blocked_reason'] === 'main_dirty', 'Untracked files must block merge-back');
    rejects(fn () => $service->mergeWorktree($tree, $pending, null, null), 'worktree_merge_blocked');
    check(file_get_contents($repo . '/untracked.txt') === 'Keep me', 'Blocked merge must preserve local changes');
    unlink($repo . '/untracked.txt');
    $mainGit = trim(git($repo, ['rev-parse', '--absolute-git-dir']));
    file_put_contents($mainGit . '/MERGE_HEAD', git($external, ['rev-parse', 'HEAD']));
    check($service->worktreeMergeState($tree)['blocked_reason'] === 'main_busy', 'Unfinished merge must block merge-back');
    rejects(fn () => $service->mergeWorktree($tree, $pending, null, null), 'worktree_merge_blocked');
    unlink($mainGit . '/MERGE_HEAD');
    git($repo, ['checkout', '--detach']);
    check($service->worktreeMergeState($tree)['blocked_reason'] === 'main_detached', 'Detached main checkout must be blocked');
    git($repo, ['checkout', 'other']);
    rejects(fn () => $service->mergeWorktree($tree, $pending, null, null), 'worktree_merge_changed');
    $pending = $service->worktreeMergeState($tree);
    check($pending['target_branch'] === 'other', 'Target must be the actual main checkout branch, not main by name');
    $sourceHead = git($external, ['rev-parse', 'HEAD']);
    $merged = $request('/git/merge-worktree', $scope, $pending);
    check($merged->getStatusCode() === 200, 'Merge endpoint must succeed: ' . $merged->getBody());
    check(file_get_contents($repo . '/feature.txt') === 'Feature commit', 'Merge must update the main checkout files');
    check(git($external, ['rev-parse', 'HEAD']) === $sourceHead, 'Merge must not change the source HEAD');
    check($service->worktreeMergeState($tree)['commits'] === 0, 'Merged commits must stop promoting the action');
    rejects(fn () => $service->mergeWorktree($tree, $service->worktreeMergeState($tree), null, null), 'worktree_merge_empty');

    file_put_contents($external . '/sample.txt', 'Feature side');
    git($external, ['add', 'sample.txt']);
    git($external, ['commit', '-m', 'Feature edit']);
    $staleSource = $service->worktreeMergeState($tree);
    file_put_contents($external . '/second.txt', 'Another commit');
    git($external, ['add', 'second.txt']);
    git($external, ['commit', '-m', 'Second feature']);
    rejects(fn () => $service->mergeWorktree($tree, $staleSource, null, null), 'worktree_merge_changed');
    $staleTarget = $service->worktreeMergeState($tree);
    file_put_contents($repo . '/sample.txt', 'Main side');
    git($repo, ['add', 'sample.txt']);
    git($repo, ['commit', '-m', 'Main edit']);
    rejects(fn () => $service->mergeWorktree($tree, $staleTarget, null, null), 'worktree_merge_changed');
    $pending = $service->worktreeMergeState($tree);
    $conflict = $request('/git/merge-worktree', $scope, $pending);
    $error = json_decode((string)$conflict->getBody(), true, 512, JSON_THROW_ON_ERROR)['error'];
    check($conflict->getStatusCode() === 409 && $error['code'] === 'worktree_merge_conflicts', 'Conflicts must be explicit failures');
    check($error['details']['open_main'] && !$error['details']['console']['ok'], 'Conflicts must point to the main checkout with captured console output');
    check(is_file($mainGit . '/MERGE_HEAD'), 'Conflict resolution must remain in the main checkout');
    check(file_get_contents($external . '/sample.txt') === 'Feature side', 'Conflicts must not alter source files');
    check($service->worktreeMergeState($tree)['blocked_reason'] === 'main_busy', 'Repeated merge must be blocked until conflicts are resolved or aborted');
    git($repo, ['merge', '--abort']);

    file_put_contents($repo . '/nonconflicting.txt', 'Main-only addition');
    git($repo, ['add', 'nonconflicting.txt']);
    git($repo, ['commit', '-m', 'Non-conflicting main change']);
    // Resolve the test's conflicting file manually before testing a real merge commit.
    file_put_contents($external . '/sample.txt', 'Main side');
    git($external, ['add', 'sample.txt']);
    git($external, ['commit', '-m', 'Agree on shared file']);
    $merged = $request('/git/merge-worktree', $scope, $service->worktreeMergeState($tree));
    check($merged->getStatusCode() === 200, 'Diverged non-conflicting histories must merge: ' . $merged->getBody());
    check(count(explode(' ', git($repo, ['show', '-s', '--format=%P', 'HEAD']))) === 2, 'Diverged histories must preserve both parents');
    check(git($repo, ['show', '-s', '--format=%an <%ae>', 'HEAD']) === 'Merge Tester <merge@example.invalid>', 'Merge commits must use the host user identity');
    check($service->worktreeMergeState($tree)['commits'] === 0, 'Successful merge must integrate all source commits');

    if (!is_dir($mainGit . '/info')) {
        mkdir($mainGit . '/info');
    }
    check(file_put_contents($mainGit . '/info/exclude', "\nprotected.txt\n", FILE_APPEND) !== false, 'Fixture ignore rule must be written');
    file_put_contents($repo . '/protected.txt', 'Ignored local content');
    file_put_contents($external . '/protected.txt', 'Committed feature content');
    git($external, ['add', '-f', 'protected.txt']);
    git($external, ['commit', '-m', 'Add protected path']);
    $pending = $service->worktreeMergeState($tree);
    check($pending['blocked_reason'] === 'main_ignored', 'Potentially overwritten ignored files need an explicit safety guard');
    $protected = $request('/git/merge-worktree', $scope, $pending);
    check($protected->getStatusCode() === 409, 'Merge must refuse to overwrite ignored local files');
    check(file_get_contents($repo . '/protected.txt') === 'Ignored local content', 'Ignored local files must not be discarded');
    unlink($repo . '/protected.txt');
    mkdir($repo . '/protected.txt');
    file_put_contents($repo . '/protected.txt/local.txt', 'Ignored directory content');
    check($service->worktreeMergeState($tree)['blocked_reason'] === 'main_ignored', 'Ignored directory/file collisions must also be protected');
    unlink($repo . '/protected.txt/local.txt');
    rmdir($repo . '/protected.txt');
    file_put_contents($mainGit . '/info/exclude', "other-local.txt\n", FILE_APPEND);
    file_put_contents($repo . '/other-local.txt', 'Unrelated ignored content');
    check($service->worktreeMergeState($tree)['blocked_reason'] === null, 'Unrelated ignored files must not block merge-back');

    $service->deleteWorktree($root, 'external tree');
    $recreated = $service->createWorktree($root, 'new-tree');
    check($recreated['console']['ok'], 'Create must reuse an existing inactive branch');
    $service->deleteWorktree($root, 'new-tree');

    echo "PASS: worktree resolution, URL gates, scoped APIs, safe create/delete and merge-back safety/conflicts\n";
} finally {
    removeFixture($fixture);
}
