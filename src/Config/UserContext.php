<?php
declare(strict_types=1);

namespace Codiware\Config;

/**
 * Identity passed in from the host application for git commits and audit logging.
 *
 * Codiware never authenticates users itself; the host decides who is using the IDE
 * and tells Codiware via this value object.
 */
final class UserContext
{
    /**
     * @param string|null $name  Display name / git committer name.
     * @param string|null $email Git committer email.
     * @param string|null $id    Stable user id used for per-user log entries.
     */
    public function __construct(
        public readonly ?string $name = null,
        public readonly ?string $email = null,
        public readonly ?string $id = null
    ) {
    }

    /**
     * @return bool True if both name and email are present (required for git commits).
     */
    public function hasGitIdentity(): bool
    {
        return $this->name !== null && $this->name !== ''
            && $this->email !== null && $this->email !== '';
    }
}
