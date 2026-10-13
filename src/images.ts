/**
 * Image limits and re-encoding for images sent to the model: the
 * view_image and view_canvas tools (attachments in ChatContainer.svelte
 * still have their own copy; switching them over is a follow-up). Browser
 * APIs only (createImageBitmap, <canvas>), so it works the same on desktop
 * and mobile.
 */
import { arrayBufferToBase64 } from "obsidian";

/** Same per-image limit as attachments. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest side sent; larger images are scaled down (as attachments are when re-encoded). */
export const MAX_IMAGE_SIDE = 2048;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Image formats that read_file refuses and view_image can't send (SVG is text, so read_file reads it). */
const OTHER_IMAGE_EXTENSIONS = ["bmp", "tif", "tiff", "heic", "heif", "avif", "ico"];

/** The media type of a PNG, JPEG, GIF or WebP path; undefined for anything else. */
export function imageMediaType(path: string): string | undefined {
  return IMAGE_TYPES[extensionOf(path)];
}

/** Any image file, including formats view_image can't send. */
export function isImagePath(path: string): boolean {
  const extension = extensionOf(path);
  return extension in IMAGE_TYPES || OTHER_IMAGE_EXTENSIONS.includes(extension);
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Decodes image bytes; null if this device can't. */
export async function decodeImage(bytes: ArrayBuffer, mediaType: string): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes], { type: mediaType }));
  } catch {
    return null;
  }
}

/** A detached <canvas> element of the given size. */
export function createCanvasElement(width: number, height: number): HTMLCanvasElement {
  const canvas = createEl("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export interface EncodedImage {
  mediaType: string;
  /** Base64 without the data-URL prefix. */
  data: string;
  sizeBytes: number;
  /** Pixel size, when known. */
  width?: number;
  height?: number;
}

type EncodableCanvas = Pick<HTMLCanvasElement, "width" | "height" | "toBlob">;

/**
 * Encodes a canvas as PNG or JPEG (quality 0.85). A PNG over the size
 * limit is tried once more as JPEG. Throws if it still doesn't fit.
 */
export async function encodeCanvas(canvas: EncodableCanvas, mediaType: "image/png" | "image/jpeg"): Promise<EncodedImage> {
  let type: string = mediaType;
  let blob = await toBlob(canvas, type);
  if (blob.size > MAX_IMAGE_BYTES && type === "image/png") {
    type = "image/jpeg";
    blob = await toBlob(canvas, type);
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`the image is still over ${formatBytes(MAX_IMAGE_BYTES)} after scaling down`);
  }
  return {
    mediaType: type,
    data: arrayBufferToBase64(await blob.arrayBuffer()),
    sizeBytes: blob.size,
    width: canvas.width,
    height: canvas.height,
  };
}

export interface FittedImage extends EncodedImage {
  /** Pixel size of the original, when this device could decode it. */
  originalWidth?: number;
  originalHeight?: number;
  /** False when the original bytes are sent as they are. */
  reencoded: boolean;
}

/**
 * Fits image bytes into the limits: at most MAX_IMAGE_SIDE px on the long
 * side and MAX_IMAGE_BYTES. Images within both are sent unchanged; others
 * are scaled down and re-encoded (PNG stays PNG if it fits, otherwise
 * JPEG). GIFs are never re-encoded, which would drop the animation.
 */
export async function fitImage(bytes: ArrayBuffer, mediaType: string): Promise<FittedImage> {
  const bitmap = await decodeImage(bytes, mediaType);
  const width = bitmap?.width;
  const height = bitmap?.height;
  const original = { originalWidth: width, originalHeight: height };
  const tooManyBytes = bytes.byteLength > MAX_IMAGE_BYTES;
  const tooLarge = tooManyBytes || (bitmap !== null && Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_SIDE);
  if (!tooLarge || (mediaType === "image/gif" && !tooManyBytes)) {
    bitmap?.close();
    return { mediaType, data: arrayBufferToBase64(bytes), sizeBytes: bytes.byteLength, width, height, ...original, reencoded: false };
  }
  if (mediaType === "image/gif") {
    bitmap?.close();
    throw new Error(`GIF files must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller`);
  }
  if (!bitmap) throw new Error("the image is too large and this device can't decode it to scale it down");
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = createCanvasElement(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image conversion is unavailable on this device");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { ...await encodeCanvas(canvas, mediaType === "image/png" ? "image/png" : "image/jpeg"), ...original, reencoded: true };
  } finally {
    bitmap.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toBlob(canvas: EncodableCanvas, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("image conversion failed")),
      type,
      0.85,
    );
  });
}
