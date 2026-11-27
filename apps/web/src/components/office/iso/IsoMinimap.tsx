// The minimap, drawn as a canvas the size of a thumb.
//
// It is the same floor, one more time, only smaller: the building's diamond, one
// panel per room in that room's own colour, a dot per person, and the rectangle
// the big canvas is currently looking at. Pressing it moves the camera there.
import { useEffect, useMemo, useRef } from 'react';
import { minimapFrame, minimapShapes, minimapToWorld, viewfinderCorners, type MinimapFrame } from './isoMinimap.js';
import { isoWorldBounds } from './isoPlan.js';
import type { IsoBounds, IsoPoint } from './iso.js';

export interface MinimapAgent {
  id: string;
  at: IsoPoint;
  color: string;
  live: boolean;
  selected: boolean;
}

interface Props {
  agents: MinimapAgent[];
  ceo: IsoPoint | null;
  /** The world rectangle the stage is showing, or null before it is measured. */
  visible: IsoBounds | null;
  width: number;
  height: number;
  label: string;
  hint: string;
  onPick: (point: IsoPoint) => void;
}

const BOUNDS = isoWorldBounds();

export function IsoMinimap({ agents, ceo, visible, width, height, label, hint, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = useMemo<MinimapFrame>(() => minimapFrame(BOUNDS, width, height, 5), [width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // The panel the map sits on.
    ctx.fillStyle = 'rgba(6,11,18,0.82)';
    ctx.beginPath();
    roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 7);
    ctx.fill();

    const { building, zones } = minimapShapes(frame);
    // The slab.
    ctx.beginPath();
    building.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(30,44,60,0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(125,211,252,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    for (const zone of zones) {
      ctx.beginPath();
      zone.corners.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.closePath();
      ctx.fillStyle = withAlphaLocal(zone.accent, 0.22);
      ctx.fill();
      ctx.strokeStyle = withAlphaLocal(zone.accent, 0.55);
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // The viewfinder: where the stage is looking.
    if (visible) {
      const corners = viewfinderCorners(frame, visible);
      ctx.beginPath();
      corners.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(248,250,252,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(248,250,252,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // The people: a filled dot for a real state, a ring for someone on a break.
    for (const agent of agents) {
      const point = worldToMinimapLocal(frame, agent.at);
      ctx.beginPath();
      ctx.arc(point.x, point.y, agent.selected ? 3 : 2, 0, Math.PI * 2);
      if (agent.live) {
        ctx.fillStyle = agent.color;
        ctx.fill();
      } else {
        ctx.strokeStyle = agent.color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (agent.selected) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (ceo) {
      const point = worldToMinimapLocal(frame, ceo);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - 4);
      ctx.lineTo(point.x + 3, point.y + 2.4);
      ctx.lineTo(point.x - 3, point.y + 2.4);
      ctx.closePath();
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
    }
  }, [agents, ceo, frame, width, height, visible]);

  return (
    <div className="pointer-events-auto relative">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width, height }}
        role="button"
        tabIndex={0}
        aria-label={`${label}. ${hint}`}
        title={hint}
        className="block cursor-crosshair touch-none rounded-lg border border-white/15"
        onPointerDown={event => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onPick(minimapToWorld(frame, event.clientX - rect.left, event.clientY - rect.top));
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
        }}
      />
      <span className="pointer-events-none absolute -top-4 left-0 text-[9px] font-semibold uppercase tracking-wide text-white/35">{label}</span>
    </div>
  );
}

function worldToMinimapLocal(frame: MinimapFrame, point: IsoPoint): IsoPoint {
  return { x: point.x * frame.scale + frame.offsetX, y: point.y * frame.scale + frame.offsetY };
}

function withAlphaLocal(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return hex;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
