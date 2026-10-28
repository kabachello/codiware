import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const eventSource = await readFile(new URL('../public/js/core/EventBus.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/js/editors/ImageEditor.js', import.meta.url), 'utf8');
const eventUrl = `data:text/javascript;base64,${Buffer.from(eventSource).toString('base64')}`;
const moduleSource = source.replace("'../core/EventBus.js'", JSON.stringify(eventUrl));
const { ImageEditor } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);

function editorWithCanvas(content = 'original') {
  const editor = Object.create(ImageEditor.prototype);
  editor._canvas = { toDataURL: () => `data:image/png;base64,${content}` };
  editor._mime = 'image/png';
  editor._ready = true;
  editor._scaling = false;
  editor._baseline = content;
  editor._pending = Promise.resolve();
  return editor;
}

test('save payload stays synchronous and acknowledges only the saved image', () => {
  const editor = editorWithCanvas();
  assert.deepEqual(editor.getSavePayload(), { content: 'original', encoding: 'base64' });
  assert.equal(editor.isDirty(), false);
  const saved = editor.getSavePayload();
  editor._canvas.toDataURL = () => 'data:image/png;base64,later';
  editor.markClean(saved);
  assert.equal(editor.isDirty(), true);
  editor.markClean(editor.getSavePayload());
  assert.equal(editor.isDirty(), false);
});

test('saving waits for an in-flight edit before applying a pending crop', async () => {
  const editor = editorWithCanvas();
  let release;
  const calls = [];
  editor._pending = new Promise(resolve => { release = () => { calls.push('edit'); resolve(); }; });
  editor._cropping = true;
  editor._run = operation => operation();
  editor._applyCrop = async () => { calls.push('crop'); };
  const saving = editor.beforeSave();
  assert.deepEqual(calls, []);
  release();
  await saving;
  assert.deepEqual(calls, ['edit', 'crop']);
});

test('crop mode reveals an inset selection and shade, and cancel restores the normal view', () => {
  assert.ok(source.includes('<cropper-shade hidden>'));
  assert.ok(source.includes('<cropper-grid role="grid" bordered covered'));
  const editor = editorWithCanvas();
  editor._image = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 240 }) };
  editor._cropper = { getCropperCanvas: () => ({ getBoundingClientRect: () => ({ left: 20, top: 10 }) }) };
  const changes = [];
  editor._selection = { hidden: true, $change: (...bounds) => changes.push(bounds) };
  editor._shade = { hidden: true };
  editor._syncControls = () => {};
  editor._startCrop();
  assert.deepEqual(changes, [[120, 64, 320, 192]]);
  assert.equal(editor._selection.hidden, false);
  assert.equal(editor._shade.hidden, false);
  assert.equal(editor._image.scalable, false);
  assert.equal(editor._image.translatable, false);
  assert.equal(editor.isDirty(), false);
  editor._cancelCrop();
  assert.equal(editor._cropping, false);
  assert.equal(editor._selection.hidden, true);
  assert.equal(editor._shade.hidden, true);
  assert.equal(editor._image.scalable, true);
  assert.equal(editor._image.translatable, true);
  assert.equal(editor.isDirty(), false);
});

test('crop rounds source-pixel bounds and clips selections to the image', async () => {
  const editor = editorWithCanvas();
  editor._cropping = true;
  editor._canvas.width = 400;
  editor._canvas.height = 240;
  editor._image = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 480 }) };
  editor._cropper = { getCropperCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) };
  const draws = [];
  const canvas = { getContext: () => ({ drawImage: (...args) => draws.push(args.slice(1)) }) };
  let committed;
  editor._commit = async value => { committed = value; };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas };
  try {
    editor._selection = { x: 100.1, y: 50.1, width: 399.8, height: 479.8 };
    await editor._applyCrop();
    assert.equal(committed.width, 200);
    assert.equal(committed.height, 240);
    assert.deepEqual(draws[0], [0, 0, 200, 240, 0, 0, 200, 240]);
    editor._selection = { x: 0, y: 0, width: 500, height: 530 };
    await editor._applyCrop();
    assert.deepEqual(draws[1], [0, 0, 200, 240, 0, 0, 200, 240]);
    editor._selection = { x: 1000, y: 1000, width: 20, height: 20 };
    await assert.rejects(editor._applyCrop(), /inside the image/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('resize uses the entered pixel dimensions and rejects unsafe canvas sizes', async () => {
  const editor = editorWithCanvas();
  editor._canvas.width = 400;
  editor._canvas.height = 240;
  editor._width = { valueAsNumber: 200 };
  editor._height = { valueAsNumber: 120 };
  const draws = [];
  const canvas = { getContext: () => ({ drawImage: (...args) => draws.push(args.slice(1)) }) };
  editor._commit = async value => { assert.equal(value.width, 200); assert.equal(value.height, 120); };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas };
  try {
    await editor._applySize();
    assert.deepEqual(draws, [[0, 0, 200, 120]]);
    editor._width.valueAsNumber = 0;
    await assert.rejects(editor._applySize(), /Image size/);
    editor._width.valueAsNumber = 10000;
    editor._height.valueAsNumber = 10000;
    await assert.rejects(editor._applySize(), /Image size/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('resize actions appear only for changed inputs and discard restores applied dimensions', () => {
  const editor = editorWithCanvas();
  editor._busy = false;
  editor._cropping = false;
  editor._canvas.width = 400;
  editor._canvas.height = 240;
  editor._width = { value: 400, get valueAsNumber() { return Number(this.value); }, validity: { valid: true } };
  editor._height = { value: 240, get valueAsNumber() { return Number(this.value); }, validity: { valid: true } };
  editor._status = {};
  editor._undo = [];
  editor._redo = [];
  editor._buttons = new Map(['resize', 'cancelResize', 'crop', 'reset'].map(key => [key, { setAttribute() {} }]));
  const apply = editor._buttons.get('resize');
  const discard = editor._buttons.get('cancelResize');
  editor._syncControls();
  assert.equal(apply.hidden, true);
  assert.equal(discard.hidden, true);
  editor._width.value = 200;
  editor._syncControls();
  assert.equal(apply.hidden, false);
  assert.equal(discard.hidden, false);
  assert.equal(apply.disabled, false);
  assert.equal(editor._buttons.get('crop').disabled, true);
  assert.equal(editor.isDirty(), false);
  editor._width.validity.valid = false;
  editor._syncControls();
  assert.equal(apply.disabled, true);
  assert.equal(discard.disabled, false);
  editor._width.validity.valid = true;
  editor._width.value = 10000;
  editor._height.value = 10000;
  editor._syncControls();
  assert.equal(apply.disabled, true);
  assert.equal(discard.disabled, false);
  editor._syncDimensions();
  assert.equal(editor._width.value, 400);
  assert.equal(editor._height.value, 240);
  assert.equal(apply.hidden, true);
  assert.equal(discard.hidden, true);
  assert.equal(editor._buttons.get('crop').disabled, false);
  assert.equal(editor.isDirty(), false);
});

test('scale preview maps corner drags to proportional pixels without changing applied content', () => {
  const editor = editorWithCanvas();
  editor._canvas.width = 400;
  editor._canvas.height = 240;
  editor._scaling = true;
  editor._scalePixelsPerUnit = 2;
  editor._width = {};
  editor._height = {};
  editor._status = {};
  const transforms = [];
  editor._image = { $setTransform: (...matrix) => { assert.equal(editor._image.scalable, true); transforms.push(matrix); } };
  editor._syncControls = () => {};
  editor._previewScale({ detail: { x: 40, y: 30, width: 150, height: 90 } });
  assert.equal(editor._width.value, 300);
  assert.equal(editor._height.value, 180);
  assert.deepEqual(transforms, [[0.375, 0, 0, 0.375, -85, -45]]);
  assert.equal(editor._image.scalable, false);
  assert.equal(editor.isDirty(), false);
  let prevented = false;
  editor._previewScale({ detail: { x: 0, y: 0, width: 20000, height: 12000 }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(transforms.length, 1);
  assert.equal(editor._width.value, 300);
});

test('discarding scale restores the previous viewport and leaves crop mode available', () => {
  const editor = editorWithCanvas();
  editor._scaling = true;
  editor._stage = { dataset: { imageMode: 'scale' } };
  editor._selection = {};
  editor._shade = {};
  editor._scaleTransform = [0.5, 0, 0, 0.5, 10, 20];
  let restored;
  editor._image = { $setTransform: (...matrix) => { restored = matrix; } };
  let synced = false;
  editor._syncDimensions = () => { synced = true; };
  editor._cancelScale();
  assert.deepEqual(restored, editor._scaleTransform);
  assert.equal(editor._scaling, false);
  assert.equal(editor._stage.dataset.imageMode, undefined);
  assert.equal(editor._selection.hidden, true);
  assert.equal(editor._selection.movable, true);
  assert.equal(Number.isNaN(editor._selection.aspectRatio), true);
  assert.equal(editor._image.scalable, true);
  assert.equal(synced, true);
  assert.equal(editor.isDirty(), false);
});

test('saving applies a pending scale before encoding the image', async () => {
  const editor = editorWithCanvas();
  editor._scaling = true;
  let applied = false;
  editor._run = operation => operation();
  editor._applyScale = async () => { applied = true; editor._scaling = false; };
  await editor.beforeSave();
  assert.equal(applied, true);
});

test('fitting keeps small images at native size and shrinks oversized images', () => {
  assert.ok(source.includes('<cropper-image initial-fit="scale-down"'));
  for (const [width, height] of [[200, 100], [1600, 900], [100, 800], [800, 600]]) {
    const editor = editorWithCanvas();
    editor._canvas.width = width;
    editor._canvas.height = height;
    editor._stage = { clientWidth: 800, clientHeight: 600 };
    const calls = [];
    editor._image = {
      $resetTransform: () => calls.push(['reset']),
      $center: mode => calls.push(['center', mode]),
    };
    editor.resize();
    assert.deepEqual(calls, [['reset'], ['center', 'scale-down']]);
    editor._stage.clientWidth = 0;
    calls.length = 0;
    editor.resize();
    assert.deepEqual(calls, []);
    editor._stage.clientWidth = 800;
    editor._cropping = true;
    editor.resize();
    assert.deepEqual(calls, []);
  }
});

test('an editor that has not loaded cannot save', async () => {
  const editor = editorWithCanvas();
  editor._ready = false;
  await assert.rejects(editor.beforeSave(), /not ready/);
});