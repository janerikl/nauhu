/** Downscales an image file to a small JPEG data URL for use as a thumbnail. */
export function captureImageThumbnail(url: string, width = 320, height = 180): Promise<string | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(undefined);
        // cover-fit: scale to fill the canvas, cropping the overflow axis
        const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
        const drawWidth = img.naturalWidth * scale;
        const drawHeight = img.naturalHeight * scale;
        ctx.drawImage(img, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve(undefined);
      }
    };
    img.onerror = () => resolve(undefined);
    img.src = url;
  });
}
