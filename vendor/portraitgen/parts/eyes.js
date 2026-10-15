import { registerPart } from '../registry.js';
import { mirrored, pt, blurFilter } from '../geometry.js';
import { darken, lighten, outline, mix } from '../color.js';

// Eye shape parameters: half-width, upper/lower opening, outer-corner lift, iris radius.
export const eyeTypes = {
  almond: { label: 'Almond', ew: 16, top: 9, bot: 6, lift: 1, r: 7 },
  round: { label: 'Round', ew: 14, top: 11, bot: 10, lift: 0, r: 7.5 },
  narrow: { label: 'Narrow', ew: 16, top: 5, bot: 3.5, lift: 1, r: 6.5 },
  large: { label: 'Large', ew: 18, top: 13, bot: 11, lift: 1, r: 9.5 },
  cat: { label: 'Upturned', ew: 17, top: 8, bot: 6, lift: 6, r: 7 },
  sleepy: { label: 'Hooded', ew: 16, top: 8, bot: 6, lift: 0, r: 7, hooded: true },
  lashes: { label: 'Lashes', ew: 16, top: 10, bot: 7, lift: 3, r: 7.5, lashes: true },
  slit: { label: 'Slit pupil', ew: 16, top: 9, bot: 7, lift: 3, r: 8, slit: true },
  glow: { label: 'Glowing', ew: 16, top: 8, bot: 6, lift: 2, r: 0, glow: true },
  blank: { label: 'Blank (white)', ew: 16, top: 9, bot: 6, lift: 1, r: 0, blank: true },
};

export function scleraPath(e) {
  const { ew, top, bot, lift } = e;
  return `M${pt(-ew, 0)}C${pt(-ew * 0.5, -top * 1.33)} ${pt(ew * 0.45, -top * 1.33 - lift)} ${pt(ew, -lift)}` +
    `C${pt(ew * 0.5, bot * 1.33 - lift * 0.5)} ${pt(-ew * 0.5, bot * 1.33)} ${pt(-ew, 0)}Z`;
}

for (const [id, e] of Object.entries(eyeTypes)) {
  registerPart('eyes', {
    id,
    label: e.label,
    render({ g, colors, uid }) {
      const skin = colors.skin;
      const iris = colors.eyes;
      const line = darken(outline(skin), 0.3);
      const clip = uid('eyeClip');
      const glowF = uid('eyeGlow');
      const sclera = scleraPath(e);
      const ex = g.cx + g.eyeDX;
      const ey = g.eyeY;
      let defs = `<clipPath id="${clip}"><path d="${sclera}"/></clipPath>`;
      let inner;
      if (e.glow || e.blank) {
        const c = e.blank ? '#f4f8ff' : lighten(iris, 0.35);
        defs += `${blurFilter(glowF, 3)}`;
        inner = `<path d="${sclera}" fill="${e.blank ? '#bcd4ff' : iris}" filter="url(#${glowF})" opacity="0.9" transform="scale(1.35)"/>` +
          `<path d="${sclera}" fill="${c}"/>`;
      } else {
        const iy = 1;
        const pupil = e.slit
          ? `<ellipse cx="0" cy="${iy}" rx="1.8" ry="${e.r * 0.9}" fill="#120c0a"/>`
          : `<circle cx="0" cy="${iy}" r="${e.r * 0.45}" fill="#120c0a"/>`;
        const scleraFill = e.slit ? mix('#fff6d8', iris, 0.15) : '#fbf8f4';
        inner = `<path d="${sclera}" fill="${scleraFill}"/>` +
          `<g clip-path="url(#${clip})"><circle cx="0" cy="${iy}" r="${e.r}" fill="${iris}" stroke="${darken(iris, 0.45)}" stroke-width="1.5"/>` +
          `<circle cx="0" cy="${iy}" r="${e.r * 0.62}" fill="${lighten(iris, 0.18)}" opacity="0.45"/>${pupil}` +
          `<path d="M${pt(-e.ew, -e.top * 0.4)}Q0,${-e.top * 1.6} ${pt(e.ew, -e.top * 0.4)}" fill="none" stroke="#000" stroke-width="4" opacity="0.12"/></g>`;
      }
      const upper = `M${pt(-e.ew - 1, 0.5)}C${pt(-e.ew * 0.5, -e.top * 1.33)} ${pt(e.ew * 0.45, -e.top * 1.33 - e.lift)} ${pt(e.ew + 1.5, -e.lift - 0.5)}`;
      let lid = `<path d="${upper}" fill="none" stroke="${line}" stroke-width="3.4" stroke-linecap="round"/>`;
      lid += `<path d="${sclera}" fill="none" stroke="${line}" stroke-width="1.2" opacity="0.6"/>`;
      if (e.hooded) {
        lid = `<path d="${upper}L${pt(e.ew + 1, -e.lift + 2)}Q0,${-e.top * 0.25} ${pt(-e.ew - 1, 2)}Z" fill="${darken(skin, 0.05)}" stroke="${line}" stroke-width="2.6" stroke-linejoin="round"/>`;
      }
      if (e.lashes) {
        lid += `<path d="M${pt(e.ew * 0.55, -e.top - 1.5)}l3,-5M${pt(e.ew * 0.85, -e.top * 0.55 - e.lift)}l5,-4M${pt(e.ew + 1, -e.lift - 0.5)}l6,-2" stroke="${line}" stroke-width="2.2" stroke-linecap="round"/>`;
      }
      // Crease above the eye.
      const crease = `<path d="M${pt(-e.ew * 0.7, -e.top - 5)}Q${pt(0, -e.top * 1.5 - 7)} ${pt(e.ew * 0.85, -e.top - e.lift - 3)}" fill="none" stroke="${darken(skin, 0.25)}" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>`;
      const es = g.eyeScale ?? 1;
      const one = `<g transform="translate(${pt(ex, ey)}) scale(${es})">${inner}${crease}${lid}</g>`;
      // Specular highlights are not mirrored so both eyes share a light source.
      const hl = e.glow || e.blank ? '' :
        [ex, g.cx * 2 - ex].map((x) => `<circle cx="${x - e.r * 0.35 * es}" cy="${ey - e.r * 0.3 * es}" r="${Math.max(1.6, e.r * 0.26 * es)}" fill="#fff" opacity="0.9"/>`).join('');
      return { defs, eyes: one + mirrored(g.cx, one) + hl };
    },
  });
}

// ---------------------------------------------------------------- eyebrows
// Each brow: centre-line from inner (near nose) to outer end, plus stroke width.
export const browTypes = {
  natural: { label: 'Natural', d: 'M-14,2Q2,-6 18,-1', w: 5 },
  thin: { label: 'Thin', d: 'M-13,1Q2,-6 18,0', w: 3 },
  thick: { label: 'Thick', d: 'M-15,3Q0,-6 18,0', w: 8 },
  arched: { label: 'Arched', d: 'M-14,3Q4,-12 19,2', w: 5 },
  straight: { label: 'Straight', d: 'M-15,0L18,-2', w: 6 },
  angry: { label: 'Stern', d: 'M-15,6Q2,0 18,-4', w: 6 },
  worried: { label: 'Raised', d: 'M-14,-5Q2,-6 18,2', w: 5 },
  bushy: { label: 'Bushy', d: 'M-15,3Q0,-7 19,0', w: 9, bushy: true },
  none: { label: 'None', d: null },
};

for (const [id, b] of Object.entries(browTypes)) {
  registerPart('brows', {
    id,
    label: b.label,
    render({ g, colors }) {
      if (!b.d) return {};
      const c = darken(colors.hair, 0.15);
      const x = g.cx + g.eyeDX - 2;
      let s = `<path d="${b.d}" fill="none" stroke="${c}" stroke-width="${b.w}" stroke-linecap="round"/>`;
      if (b.bushy) {
        s += `<path d="M-12,-1l-3,-5M-4,-4l-2,-6M5,-5l1,-6M13,-3l3,-5" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`;
      }
      const one = `<g transform="translate(${pt(x, g.browY)})">${s}</g>`;
      return { brows: one + mirrored(g.cx, one) };
    },
  });
}
