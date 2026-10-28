import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/js/editors/SaveQueue.js', import.meta.url), 'utf8');
const { SaveQueue } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('acknowledges A without cleaning B and coalesces trailing requests', async () => {
  const queue = new SaveQueue();
  let content = 'A';
  let baseline = '';
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const writes = [];
  const operation = {
    prepare: async () => Object.freeze({ content }),
    write: async snapshot => { writes.push(snapshot.content); if (writes.length === 1) await started; },
    acknowledge: snapshot => { baseline = snapshot.content; },
  };
  const saving = queue.request('root/file.md', operation);
  await new Promise(resolve => setImmediate(resolve));
  content = 'B';
  release();
  await saving;
  assert.equal(baseline, 'A');
  assert.notEqual(content, baseline);
  const trailing = queue.request('root/file.md', operation);
  await Promise.resolve();
  queue.request('root/file.md', operation);
  queue.request('root/file.md', operation);
  await trailing;
  assert.deepEqual(writes, ['A', 'B', 'B']);
  assert.equal(content, baseline);
});

test('failed writes discard queued successors and retain the baseline', async () => {
  const queue = new SaveQueue();
  let acknowledgments = 0;
  let writes = 0;
  const operation = {
    prepare: async () => ({ content: 'A' }),
    write: async () => { writes++; throw new Error('write failed'); },
    acknowledge: () => { acknowledgments++; },
  };
  const saving = queue.request('root/file.md', operation);
  queue.request('root/file.md', operation);
  await assert.rejects(saving, /write failed/);
  assert.equal(writes, 1);
  assert.equal(acknowledgments, 0);
});