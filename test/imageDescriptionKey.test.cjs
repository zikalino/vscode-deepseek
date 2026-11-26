const assert = require('node:assert/strict');
const { test } = require('node:test');

const { imagePartsKey, isImagePart } = require('../out/provider/vision/descriptionKey.js');

const image = (bytes, mimeType = 'image/png') => ({
  type: 'data',
  mimeType,
  data: Uint8Array.from(bytes),
});

test('the same image always maps to the same key', () => {
  const bytes = [1, 2, 3, 4, 5];
  assert.equal(imagePartsKey([image(bytes)]), imagePartsKey([image(bytes)]));
});

test('different bytes or MIME types map to different keys', () => {
  const first = imagePartsKey([image([1, 2, 3])]);
  const second = imagePartsKey([image([1, 2, 4])]);
  const third = imagePartsKey([image([1, 2, 3], 'image/jpeg')]);

  assert.notEqual(first, second);
  assert.notEqual(first, third);
});

test('messages without an image have no key', () => {
  assert.equal(imagePartsKey([{ type: 'text', value: 'hello' }]), undefined);
});

test('only image data parts are recognized', () => {
  assert.equal(isImagePart(image([1])), true);
  assert.equal(isImagePart({ type: 'data', mimeType: 'application/pdf', data: [] }), false);
  assert.equal(isImagePart({ type: 'text', value: 'x' }), false);
});
