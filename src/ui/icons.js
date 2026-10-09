/* The one inline SVG sprite: 16 px box, 1.5 px stroke, round caps and joins,
   `stroke="currentColor" fill="none"`.  No icon font, no external set, no duotone.
   `mountSprite(document.body)` once at boot, then `icon('swap', 'i14')` per use. */

/** name -> the inner markup of its <symbol viewBox="0 0 16 16">. */
export const ICONS = {
  /* the 24 core */
  search: '<circle cx="6.9" cy="6.9" r="4.5"/><path d="M10.2 10.2 13.8 13.8"/>',
  'chevron-right': '<path d="M6.2 3.6 10.6 8l-4.4 4.4"/>',
  'chevron-down': '<path d="M3.6 6.2 8 10.6l4.4-4.4"/>',
  'chevron-up': '<path d="M3.6 9.8 8 5.4l4.4 4.4"/>',
  'chevron-left': '<path d="M9.8 3.6 5.4 8l4.4 4.4"/>',
  eye: '<path d="M1.4 8S4 3.7 8 3.7 14.6 8 14.6 8 12 12.3 8 12.3 1.4 8 1.4 8Z"/><circle cx="8" cy="8" r="1.8"/>',
  'eye-off': '<path d="M6.1 4.1A6.9 6.9 0 0 1 8 3.7c4 0 6.6 4.3 6.6 4.3a13 13 0 0 1-2.2 2.6M4 5.3A12.6 12.6 0 0 0 1.4 8S4 12.3 8 12.3c.8 0 1.5-.2 2.2-.4"/><path d="M2.6 2.6 13.4 13.4"/>',
  isolate: '<circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="5.6" stroke-dasharray="2 2.3"/>',
  swap: '<path d="M2.6 5.6h9.8M9.8 3 12.4 5.6 9.8 8.2M13.4 10.4H3.6M6.2 7.8 3.6 10.4l2.6 2.6"/>',
  sparkle: '<path d="M6.6 2.2 7.9 5.5l3.3 1.3-3.3 1.3-1.3 3.3-1.3-3.3L2 6.8l3.3-1.3z"/><path d="M12 9.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>',
  import: '<path d="M8 1.8v7.4M5.2 6.6 8 9.4l2.8-2.8M2.2 11v2.2h11.6V11"/>',
  export: '<path d="M8 10.4V3M5.2 5.8 8 3l2.8 2.8M2.2 11v2.2h11.6V11"/>',
  printer: '<path d="M4.4 6V2.6h7.2V6M2.6 6h10.8v5H2.6z"/><path d="M4.8 9.4h6.4v4H4.8z"/>',
  check: '<path d="M3 8.4 6.4 11.8 13 5.2"/>',
  warn: '<path d="M8 2.4 14.8 13.6H1.2z"/><path d="M8 6.4v3.1"/><circle cx="8" cy="11.5" r=".6" fill="currentColor" stroke="none"/>',
  error: '<circle cx="8" cy="8" r="6.3"/><path d="M5.8 5.8 10.2 10.2M10.2 5.8 5.8 10.2"/>',
  camera: '<path d="M2 5.4h2.7l.9-1.6h4.8l.9 1.6H14v7.2H2z"/><circle cx="8" cy="9" r="2.4"/>',
  frustum: '<path d="M8 2.6 2.4 13.4h11.2z"/><path d="M4.2 9.6h7.6"/><circle cx="8" cy="2.6" r=".9" fill="currentColor" stroke="none"/>',
  expand: '<path d="M2.6 6.2V2.6h3.6M13.4 6.2V2.6H9.8M2.6 9.8v3.6h3.6M13.4 9.8v3.6H9.8"/>',
  move: '<path d="M8 2.2v11.6M2.2 8h11.6M6.2 4 8 2.2 9.8 4M6.2 12 8 13.8 9.8 12M4 6.2 2.2 8 4 9.8M12 6.2 13.8 8 12 9.8"/>',
  rotate: '<path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85"/><path d="M13.6 2.2v2.9h-2.9"/>',
  undo: '<path d="M2.8 6.6h7a3.5 3.5 0 0 1 0 7H6.6M5.4 3.8 2.6 6.6l2.8 2.8"/>',
  redo: '<path d="M13.2 6.6h-7a3.5 3.5 0 0 0 0 7h3.2M10.6 3.8l2.8 2.8-2.8 2.8"/>',
  grid: '<path d="M2.4 2.4h11.2v11.2H2.4zM6.1 2.4v11.2M9.9 2.4v11.2M2.4 6.1h11.2M2.4 9.9h11.2"/>',
  close: '<path d="M3.8 3.8 12.2 12.2M12.2 3.8 3.8 12.2"/>',
  help: '<circle cx="8" cy="8" r="6.3"/><path d="M6.2 6.2a1.85 1.85 0 1 1 2.4 1.8c-.4.2-.6.5-.6 1v.3"/><circle cx="8" cy="11.7" r=".6" fill="currentColor" stroke="none"/>',

  /* the 8 optional */
  theme: '<circle cx="8" cy="8" r="6.3"/><path d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" stroke="none"/>',
  play: '<path d="M5.2 3.2 12.4 8l-7.2 4.8z"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  minus: '<path d="M3.2 8h9.6"/>',
  'dots-vertical': '<circle cx="8" cy="3.4" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="12.6" r=".9" fill="currentColor" stroke="none"/>',
  'external-link': '<path d="M9 3.2h3.8V7M12.6 3.4 7.4 8.6M12 9.6v3.2H3.2V4h3.2"/>',
  cube: '<path d="M8 2.2 13.6 5.1v5.8L8 13.8 2.4 10.9V5.1z"/><path d="M2.4 5.1 8 8.1l5.6-3M8 8.1v5.7"/>',
  lock: '<path d="M4.8 7V5.3a3.2 3.2 0 0 1 6.4 0V7"/><path d="M3.6 7h8.8v6.2H3.6z"/>',

  /* two more the frame needs (not icons in their own right) */
  fit: '<path d="M2.4 5.6V2.4h3.2M13.6 5.6V2.4h-3.2M2.4 10.4v3.2h3.2M13.6 10.4v3.2h-3.2"/><path d="M6.2 6.2h3.6v3.6H6.2z"/>',
  trash: '<path d="M3.4 4.4h9.2M6.4 4.4V2.8h3.2v1.6M4.6 4.4l.6 8.8h5.6l.6-8.8"/>',

  /* the tweak ops */
  stretch: '<path d="M1.8 8h12.4M4.4 5.4 1.8 8l2.6 2.6M11.6 5.4 14.2 8l-2.6 2.6"/><path d="M8 3v10" stroke-dasharray="1.6 1.6"/>',
  scale: '<path d="M2.4 13.6h6v-6h-6z"/><path d="M8.4 7.6 13.6 2.4M9.8 2.4h3.8v3.8"/>',
  thicken: '<path d="M2.4 10.4h11.2v3.2H2.4z"/><path d="M8 8.6V2.4M5.6 4.8 8 2.4l2.4 2.4"/>',
  mirror: '<path d="M8 1.8v12.4" stroke-dasharray="1.6 1.6"/><path d="M6 4 2.2 12H6zM10 4l3.8 8H10z"/>',
  reset: '<path d="M2.8 8a5.2 5.2 0 1 0 1.7-3.85"/><path d="M2.4 2.2v2.9h2.9"/>',
  folder: '<path d="M1.8 4.2v8.4h12.4V5.6H7.6L6.2 3.4H2.6z"/>',
  'folder-link': '<path d="M1.8 4.2v8.4h5.4M14.2 7.4V5.6H7.6L6.2 3.4H2.6"/><path d="M10.4 9.6h-.6a1.6 1.6 0 0 0 0 3.2h.6M12.4 9.6h.6a1.6 1.6 0 0 1 0 3.2h-.6M10.2 11.2h2.4"/>',
  pause: '<path d="M5.2 3.4v9.2M10.8 3.4v9.2"/>',
  keyboard: '<path d="M1.6 4.2h12.8v7.6H1.6z"/><path d="M4 6.4h.1M6.4 6.4h.1M8.8 6.4h.1M11.2 6.4h.1M4 8.4h.1M11.2 8.4h.1M5.8 9.8h4.4"/>',
  unknown: '<circle cx="8" cy="8" r="6.3" stroke-dasharray="2.2 1.8"/><path d="M6.4 6.4a1.6 1.6 0 1 1 2 1.5c-.3.1-.4.4-.4.8v.2"/><circle cx="8" cy="11.2" r=".6" fill="currentColor" stroke="none"/>',
  info: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".6" fill="currentColor" stroke="none"/>',
  download: '<path d="M8 2v8M4.8 7 8 10.2 11.2 7M2.6 13.4h10.8"/>',
  copy: '<path d="M5.4 5.4h7.8v8.2H5.4z"/><path d="M10.6 5.4V2.4H2.8v8.2h2.6"/>'
};

const SVG_NS = 'http://www.w3.org/2000/svg';
let mounted = false;

/** The sprite markup — one `<svg>` holding every `<symbol id="i-…">`. */
export function spriteHTML() {
  const syms = Object.entries(ICONS)
    .map(([k, body]) => `<symbol id="i-${k}" viewBox="0 0 16 16">${body}</symbol>`)
    .join('');
  return `<svg class="rps-sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${syms}</defs></svg>`;
}

/** Put the sprite in the document once.  Safe to call repeatedly. */
export function mountSprite(host) {
  if (mounted) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = spriteHTML();
  (host || document.body).prepend(wrap);
  mounted = true;
}

/**
 * One icon element.
 * @param {string} name  a key of ICONS
 * @param {string} [cls] 'i' (16 px, default) or 'i14' (14 px) plus anything else
 */
export function icon(name, cls = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}
