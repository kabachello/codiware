<?php
declare(strict_types=1);

namespace kabachello\Codiware\Http;

use Psr\Http\Message\StreamInterface;

/**
 * A read-only PSR-7 stream backed by a {@see \Traversable} (typically a PHP
 * generator). Each `read()` pulls as many iterator items as needed and
 * concatenates them, so the stream produces output incrementally as the
 * generator yields it.
 *
 * This lets a PSR-7 emitter flush command output line-by-line to the client
 * instead of buffering the whole response. It is a framework-neutral copy of
 * the model proven in ExFace's `IteratorStream`, so Codiware does not depend
 * on `exface/core`.
 */
final class IteratorStream implements StreamInterface
{
    private ?\Iterator $iterator;

    private int $position = 0;

    /**
     * @param \Traversable $iterator The source iterator/generator yielding strings.
     */
    public function __construct(\Traversable $iterator)
    {
        while ($iterator instanceof \IteratorAggregate) {
            $iterator = $iterator->getIterator();
        }
        $this->iterator = $iterator instanceof \Iterator ? $iterator : new \IteratorIterator($iterator);
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::__toString()
     */
    public function __toString(): string
    {
        if ($this->iterator === null) {
            return '';
        }
        $this->iterator->rewind();
        return $this->getContents();
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::close()
     */
    public function close(): void
    {
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::detach()
     */
    public function detach()
    {
        $iterator = $this->iterator;
        $this->iterator = null;
        return $iterator;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::getSize()
     */
    public function getSize(): ?int
    {
        if ($this->iterator instanceof \Countable) {
            return count($this->iterator);
        }
        return null;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::tell()
     */
    public function tell(): int
    {
        return $this->position;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::eof()
     */
    public function eof(): bool
    {
        if ($this->iterator === null) {
            return true;
        }
        return ! $this->iterator->valid();
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::isSeekable()
     */
    public function isSeekable(): bool
    {
        return false;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::seek()
     */
    public function seek($offset, $whence = SEEK_SET): void
    {
        throw new \RuntimeException('Cannot seek a streaming command output.');
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::rewind()
     */
    public function rewind(): void
    {
        if ($this->iterator !== null) {
            $this->iterator->rewind();
            $this->position = 0;
        }
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::isWritable()
     */
    public function isWritable(): bool
    {
        return false;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::write()
     */
    public function write($string): int
    {
        throw new \RuntimeException('Cannot write to a read-only stream.');
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::isReadable()
     */
    public function isReadable(): bool
    {
        return true;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::read()
     */
    public function read($length): string
    {
        if ($this->iterator === null) {
            return '';
        }
        $index = 0;
        $contents = '';
        while ($this->iterator->valid() && $index < $length) {
            $contents .= $this->iterator->current();
            $this->iterator->next();
            ++$this->position;
            ++$index;
        }
        return $contents;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::getContents()
     */
    public function getContents(): string
    {
        if ($this->iterator === null) {
            return '';
        }
        $contents = '';
        while ($this->iterator->valid()) {
            $contents .= $this->iterator->current();
            $this->iterator->next();
            ++$this->position;
        }
        return $contents;
    }

    /**
     * {@inheritDoc}
     * @see \Psr\Http\Message\StreamInterface::getMetadata()
     */
    public function getMetadata($key = null)
    {
        return $key === null ? [] : null;
    }
}
