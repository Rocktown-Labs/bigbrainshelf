// JPEG -> SVG tracing with imagetracerjs (pure JS, runs in the Worker).
// Gives editable, reusable vector versions of each page.
import jpeg from "jpeg-js";
import * as ImageTracer from "imagetracerjs";

export function traceToSvg(jpegBytes: Uint8Array): string {
  const raw = jpeg.decode(jpegBytes);
  const imgd = {
    width: raw.width,
    height: raw.height,
    data: new Uint8ClampedArray(raw.data),
  };
  const svg: string = (ImageTracer as any).imagedataToSVG(imgd, {
    numberofcolors: 2,
    ltres: 1,
    qtres: 1,
    pathomit: 8,
  });
  return svg;
}
