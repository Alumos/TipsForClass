import type { DisplayPosition } from './types.js';

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Keep reminder windows inside the Windows work area. The center mode is a
 * center card is larger and more prominent; top-right stays a compact floating card.
 * Neither mode is full-screen or maximized.
 */
export function overlayBounds(workArea: Rect, position: DisplayPosition): Rect {
  const margin = 20;
  const preferred = position === 'center'
    ? { width: 760, height: 480 }
    : { width: 460, height: 300 };
  const width = Math.max(1, Math.min(preferred.width, workArea.width - margin * 2));
  const height = Math.max(1, Math.min(preferred.height, workArea.height - margin * 2));
  const maxX = workArea.x + workArea.width - width - margin;
  const maxY = workArea.y + workArea.height - height - margin;
  const x = position === 'center'
    ? workArea.x + (workArea.width - width) / 2
    : maxX;
  const y = position === 'center'
    ? workArea.y + (workArea.height - height) / 2
    : workArea.y + margin;
  return {
    x: Math.round(Math.max(workArea.x + margin, Math.min(x, maxX))),
    y: Math.round(Math.max(workArea.y + margin, Math.min(y, maxY))),
    width: Math.round(width),
    height: Math.round(height),
  };
}
