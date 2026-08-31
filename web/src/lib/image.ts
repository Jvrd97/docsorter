const MAX_SIDE = 2200;
const QUALITY = 0.85;
const SKIP_UNDER_BYTES = 400 * 1024;

/**
 * Сжатие прямо в телефоне: 4-мегабайтное фото становится ~300 КБ,
 * а текст на нём остаётся читаемым. Экономит и мобильный трафик,
 * и работу слабого сервера. PDF и мелкие картинки не трогаем.
 */
export async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  if (file.size <= SKIP_UNDER_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    // Safari иногда не читает HEIC через createImageBitmap — тогда шлём оригинал,
    // сервер сконвертирует сам.
    return file;
  }
}
