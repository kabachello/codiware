<?php
declare(strict_types=1);

namespace kabachello\Codiware\Workspace;

/**
 * Immutable description of one workspace root (e.g. a vendor package directory).
 */
final class WorkspaceRoot
{
    public function __construct(
        public readonly string $alias,
        public readonly string $path,
        public readonly string $label
    ) {
    }

    /**
     * @return array{alias:string,path:string,label:string,is_git:bool}
     */
    public function toArray(): array
    {
        return [
            'alias' => $this->alias,
            'path' => $this->path,
            'label' => $this->label,
            'is_git' => is_dir($this->path . DIRECTORY_SEPARATOR . '.git'),
        ];
    }
}
