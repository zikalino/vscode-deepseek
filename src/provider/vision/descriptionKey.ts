// Content-addressed identities for the images in one chat message.
//
// The vision proxy replaces an image with a text description before the request
// is sent. That description is model output, so regenerating it re-writes the
// serialized conversation: DeepSeek caches an exact prompt prefix, and a single
// changed byte invalidates every token after it. Keying the description by the
// image payload lets the proxy reuse the text it already produced.

type Part = Record<string, any>;

/** True for a `LanguageModelDataPart` carrying an image. */
export function isImagePart(part: unknown): boolean {
  const value = part as Part | undefined;
  return (
    !!value &&
    value.type === 'data' &&
    typeof value.mimeType === 'string' &&
    value.mimeType.startsWith('image/')
  );
}

/**
 * Stable key for the image payloads of a message, or `undefined` when the
 * message has none. The MIME type is part of the key, so the same bytes sent as
 * a different image type are treated as a different image.
 */
export function imagePartsKey(parts: readonly unknown[]): string | undefined {
  const images = parts.filter(isImagePart) as Part[];
  if (images.length === 0) {
    return undefined;
  }

  let hash = 0x811c9dc5;
  for (const image of images) {
    hash = hashString(hash, image.mimeType ?? '');
    hash = hashBytes(hash, imageBytes(image));
  }
  return `img:${(hash >>> 0).toString(16)}`;
}

function imageBytes(part: Part): Uint8Array {
  const data = part.data ?? part.value;
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data as ArrayBufferView | undefined)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(data)) {
    return Uint8Array.from(data as number[]);
  }
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  return new TextEncoder().encode(JSON.stringify(data ?? ''));
}

function hashBytes(hash: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

function hashString(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}
