/**
 * "Look at the lower left": the part of an image a Choom (or Donny) names, as a rectangle in
 * fractions of the image (x, y, width, height; 0..1). Regions nest with ">": "lower left > top
 * right" is the top-right corner of the lower-left quarter. Also takes numbers: "0.1,0.2,0.3,0.3"
 * (fractions, or percentages when any is above 1).
 */
export interface Region { x: number; y: number; w: number; h: number }

const VERTICAL: Record<string, 'top' | 'bottom'> = { top: 'top', upper: 'top', bottom: 'bottom', lower: 'bottom' };
const HORIZONTAL: Record<string, 'left' | 'right'> = { left: 'left', right: 'right' };

function one(text: string): Region | null {
  const t = text.toLowerCase().replace(/[-_]/g, ' ').trim();
  const nums = t.match(/^\[?\s*(-?[\d.]+%?)\s*,\s*(-?[\d.]+%?)\s*,\s*(-?[\d.]+%?)\s*,\s*(-?[\d.]+%?)\s*\]?$/);
  if (nums) {
    let v = nums.slice(1, 5).map((s) => parseFloat(s));
    if (nums.slice(1, 5).some((s) => s.endsWith('%')) || v.some((n) => n > 1)) v = v.map((n) => n / 100);
    const [x, y, w, h] = v;
    if ([x, y, w, h].some((n) => !Number.isFinite(n)) || w <= 0 || h <= 0) return null;
    const cx = Math.min(Math.max(x, 0), 1), cy = Math.min(Math.max(y, 0), 1);
    return { x: cx, y: cy, w: Math.min(w, 1 - cx), h: Math.min(h, 1 - cy) };
  }
  const words = t.split(/\s+/);
  const vert = words.map((w) => VERTICAL[w]).find(Boolean);
  const horiz = words.map((w) => HORIZONTAL[w]).find(Boolean);
  const center = words.some((w) => w === 'center' || w === 'centre' || w === 'middle');
  const part = words.includes('third') || words.includes('thirds') ? 1 / 3
    : words.includes('quarter') || words.includes('fourth') ? 0.25 : 0.5;
  if (vert && horiz) return { x: horiz === 'left' ? 0 : 1 - part, y: vert === 'top' ? 0 : 1 - part, w: part, h: part };
  if (vert) return { x: 0, y: vert === 'top' ? 0 : 1 - part, w: 1, h: part };
  if (horiz) return { x: horiz === 'left' ? 0 : 1 - part, y: 0, w: part, h: 1 };
  if (center) {
    if (part === 1 / 3 && words.some((w) => w === 'band' || w === 'row' || w === 'strip')) return { x: 0, y: 1 / 3, w: 1, h: 1 / 3 };
    return { x: (1 - part) / 2, y: (1 - part) / 2, w: part, h: part };
  }
  if (/^(whole|all|full|everything|entire)/.test(t)) return { x: 0, y: 0, w: 1, h: 1 };
  return null;
}

/** The named region, nested pieces applied in turn; null if it can't be read. */
export function parseRegion(text: string): Region | null {
  if (!text || !text.trim()) return null;
  const pieces = text.split(/\s*(?:>|→|\bthen\b|;)\s*/i).filter(Boolean);
  let r: Region = { x: 0, y: 0, w: 1, h: 1 };
  for (const piece of pieces) {
    const sub = one(piece);
    if (!sub) return null;
    r = { x: r.x + sub.x * r.w, y: r.y + sub.y * r.h, w: sub.w * r.w, h: sub.h * r.h };
  }
  return r;
}

export const REGION_EXAMPLES = '"top half", "lower left", "right third", "center", "top left quarter", "lower left > top right" (nested), or "x,y,w,h" fractions like "0.1,0.6,0.3,0.3"';
