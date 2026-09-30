import React, { useEffect, useRef, useState } from 'react';
import type { CaptureTile, LocalObservation } from '../contracts';
import type { PerceptionResult } from '../vision/contracts';

interface PreviewProps {
  observation: LocalObservation;
  ocr?: PerceptionResult;
  faces?: PerceptionResult;
  selected?: number;
  selectedFace?: number;
  showControls: boolean;
  showText: boolean;
  showFaces: boolean;
  fullSize: boolean;
  onSelect: (x: number, y: number) => void;
}

function PreviewTile({ tile, ...props }: PreviewProps & { tile: CaptureTile }) {
  const { observation, ocr, faces, selected, selectedFace, showControls, showText, showFaces, onSelect } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: canvas.closest('.preview-scroll'), rootMargin: '480px',
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!visible) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      canvas.width = tile.width; canvas.height = tile.end - tile.start;
      const context = canvas.getContext('2d'); if (!context) return;
      context.drawImage(image, 0, tile.start - tile.y, tile.width, canvas.height, 0, 0, tile.width, canvas.height);
      // Each canvas shows its ownership band; overlays stay in full-page pixels.
      context.translate(0, -tile.start);
      const vp = observation.dom.viewport;
      const sx = observation.imageWidth / observation.captureBounds.width, sy = observation.imageHeight / observation.captureBounds.height;
      context.lineWidth = Math.max(2, sx * 2); context.font = `${12 * sx}px sans-serif`;
      if (showControls) for (const [i, element] of observation.dom.elements.entries()) {
        const box = element.bounds;
        context.strokeStyle = element.disabled ? '#c77a13' : '#16816a'; context.fillStyle = context.strokeStyle;
        const x = (box.x + vp.scrollX - vp.offsetX - observation.captureBounds.x) * sx,
          y = (box.y + vp.scrollY - vp.offsetY - observation.captureBounds.y) * sy;
        context.strokeRect(x, y, box.width * sx, box.height * sy);
        context.fillText(String(i + 1), x + 3, y + 13 * sy);
      }
      if (showFaces && faces?.observationId === observation.dom.observationId) for (const [i, region] of faces.regions.entries()) {
        const b = region.bounds;
        if (b.y > tile.end + 20 || b.y + b.height < tile.start) continue;
        context.strokeStyle = '#e44e70'; context.lineWidth = selectedFace === i ? 4 : 2;
        context.strokeRect(b.x, b.y, b.width, b.height);
        if (selectedFace === i) { context.fillStyle = '#e44e7022'; context.fillRect(b.x, b.y, b.width, b.height); }
        context.fillStyle = '#be2448'; context.fillText(`Face ${i + 1}`, b.x, Math.max(14, b.y - 5));
      }
      if (showText && ocr?.observationId === observation.dom.observationId) for (const [i, region] of ocr.regions.entries()) {
        const b = region.bounds;
        if (b.y > tile.end || b.y + b.height < tile.start) continue;
        context.strokeStyle = selected === i ? '#b34408' : '#5d4bdd';
        context.lineWidth = selected === i ? 3 : 1.5;
        context.strokeRect(b.x, b.y, b.width, b.height);
        if (selected === i) { context.fillStyle = '#ffc35d55'; context.fillRect(b.x, b.y, b.width, b.height); }
      }
    };
    image.src = tile.screenshot;
    return () => { cancelled = true; image.src = ''; canvas.width = 0; canvas.height = 0; };
  }, [visible, tile, observation, ocr, faces, selected, selectedFace, showControls, showText, showFaces]);
  // Explicit aspect ratio preserves scrolling while offscreen canvases release
  // their backing buffers. Full size still displays original image pixels.
  return <canvas ref={canvasRef} style={{ aspectRatio: `${tile.width} / ${tile.end - tile.start}`,
    width: props.fullSize ? tile.width : '100%', height: 'auto' }}
    aria-label="Local screenshot with text and face bounding boxes" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      onSelect((event.clientX - rect.left) * tile.width / rect.width,
        tile.start + (event.clientY - rect.top) * (tile.end - tile.start) / rect.height);
    }} />;
}

export function PagePreview(props: PreviewProps) {
  return <div className={`preview-scroll ${props.fullSize ? 'full-size' : ''}`}>
    {props.observation.tiles.map(tile => <PreviewTile key={tile.start} {...props} tile={tile} />)}
  </div>;
}
