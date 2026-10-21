import { ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Field } from "../../ui";

/** An agent's picture where it is listed or edited: the photo when there is one, a letter when there is not. */
export function AgentAvatar({ url, name, size = 36 }: { url: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const style = { width: size, height: size };
  if (url && !failed) return <img src={url} alt="" style={style} className="shrink-0 rounded-full bg-surface-2 object-cover" onError={() => setFailed(true)} />;
  return (
    <span style={style} className="grid shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "A"}
    </span>
  );
}

const OUT = 512;
export const PICTURE_TYPES = "image/png,image/jpeg,image/webp";

/**
 * Crops a chosen picture to a square in the browser (zoom and position), shows what visitors will see, and hands back a 512 px WebP blob. The server
 * validates the upload again and removes metadata; drawing it on a canvas here already drops EXIF.
 */
export function PictureCropper({ onChange }: { onChange: (blob: Blob | null) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(0);

  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);

  const draw = (target: HTMLCanvasElement, size: number) => {
    const im = img.current;
    const ctx = target.getContext("2d");
    if (!im || !ctx) return false;
    target.width = size;
    target.height = size;
    const side = Math.min(im.naturalWidth, im.naturalHeight) / zoom;
    const sx = (im.naturalWidth - side) / 2 + x * ((im.naturalWidth - side) / 2);
    const sy = (im.naturalHeight - side) / 2 + y * ((im.naturalHeight - side) / 2);
    ctx.drawImage(im, sx, sy, side, side, 0, 0, size, size);
    return true;
  };

  useEffect(() => {
    if (!src || !img.current?.complete || !canvas.current) return;
    if (!draw(canvas.current, 176)) return;
    const out = document.createElement("canvas");
    if (!draw(out, OUT)) return;
    out.toBlob((b) => onChange(b), "image/webp", 0.9);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, zoom, x, y, ready]);

  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setError("Use a PNG, JPEG or WebP picture.");
    if (f.size > 12 * 1024 * 1024) return setError("That file is very large. Choose a picture under 12 MB; it is cropped and shrunk here before it is uploaded.");
    setZoom(1);
    setX(0);
    setY(0);
    setSrc(URL.createObjectURL(f));
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2 focus-within:ring-2 focus-within:ring-ring">
        <ImagePlus className="size-4" aria-hidden="true" /> Upload a picture
        <input type="file" accept={PICTURE_TYPES} className="sr-only" aria-label="Upload a picture" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      {src && (
        <div className="flex flex-wrap items-start gap-4">
          <div className="relative size-44 overflow-hidden rounded-full border border-border bg-surface-2" aria-label="Square preview, shown round to visitors" role="img">
            <canvas ref={canvas} width={176} height={176} className="size-full" />
          </div>
          <img ref={img} src={src} alt="" className="hidden" onLoad={() => setReady((n) => n + 1)} />
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <Field label="Zoom">
              <input type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
            </Field>
            <Field label="Left or right">
              <input type="range" min={-1} max={1} step={0.05} value={x} onChange={(e) => setX(Number(e.target.value))} aria-label="Move left or right" />
            </Field>
            <Field label="Up or down">
              <input type="range" min={-1} max={1} step={0.05} value={y} onChange={(e) => setY(Number(e.target.value))} aria-label="Move up or down" />
            </Field>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSrc(null);
                onChange(null);
              }}
            >
              <Trash2 aria-hidden="true" /> Discard this picture
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

