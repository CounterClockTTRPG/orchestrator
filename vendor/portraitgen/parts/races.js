// Features for non-human races: feline (tabaxi), goat-folk (satyr) and reptile
// (lizardfolk) traits, used by the fantasy archetypes.
import { registerPart } from '../registry.js';
import { pt, mirrored, facePath } from '../geometry.js';
import { darken, lighten, mix } from '../color.js';

const f = (n) => +n.toFixed(2);

const defs = [
  {
    id: 'catEars', label: 'Cat ears', group: 'horns', layer: 'accHead',
    render({ g, colors }) {
      const fur = colors.skin;
      const { cx, w, top } = g;
      // The base sits on the curve of the skull (inner edge high on the crown, outer edge down the
      // side of the head), so the ear grows out of the head instead of floating above it.
      const inner = [cx + w * 0.22, top + 12], outer = [cx + w * 0.92, top + 46], tip = [cx + w * 0.8, top - 46];
      const one = `<path d="M${pt(...inner)}Q${pt(cx + w * 0.42, top - 20)} ${pt(...tip)}Q${pt(cx + w + 8, top)} ${pt(...outer)}Q${pt(cx + w * 0.6, top + 18)} ${pt(...inner)}Z" fill="${fur}" stroke="${darken(fur, 0.55)}" stroke-width="2.6" stroke-linejoin="round"/>` +
        `<path d="M${pt(cx + w * 0.38, top + 14)}Q${pt(cx + w * 0.52, top - 10)} ${pt(cx + w * 0.78, top - 28)}Q${pt(cx + w * 0.88, top + 6)} ${pt(cx + w * 0.82, top + 32)}Z" fill="${mix(fur, '#e8a0a0', 0.5)}"/>` +
        `<path d="M${pt(cx + w * 0.5, top + 10)}l6,-14M${pt(cx + w * 0.58, top + 16)}l8,-12M${pt(cx + w * 0.66, top + 20)}l8,-10" stroke="${lighten(fur, 0.4)}" stroke-width="1.4" stroke-linecap="round" opacity="0.8"/>` +
        `<path d="M${pt(...tip)}l-1,-10M${pt(...tip)}l4,-9" stroke="${darken(fur, 0.4)}" stroke-width="2" stroke-linecap="round"/>`;
      return { accHead: one + mirrored(cx, one) };
    },
  },
  {
    id: 'whiskers', label: 'Whiskers', layer: 'accFace',
    render({ g }) {
      const { cx, noseY } = g;
      let one = '';
      for (let i = 0; i < 3; i++) one += `M${pt(cx + 20, noseY + 10 + i * 4)}Q${pt(cx + 50, noseY + 4 + i * 6)} ${pt(cx + 76, noseY + i * 10)}`;
      const d = `<path d="${one}" fill="none" stroke="#f4efe6" stroke-width="1.2" opacity="0.85" stroke-linecap="round"/>`;
      return { accFace: d + mirrored(cx, d) };
    },
  },
  {
    id: 'felineMuzzle', label: 'Feline muzzle', layer: 'marks',
    render({ g, colors }) {
      const { cx, noseY, mouthY } = g;
      const pale = lighten(colors.skin, 0.4);
      // Pale muzzle pads, a triangular nose leather and the philtrum split.
      return {
        marks: `<ellipse cx="${cx}" cy="${noseY + 10}" rx="34" ry="30" fill="${pale}" opacity="0.35"/>` +
          `<ellipse cx="${cx - 15}" cy="${noseY + 16}" rx="19" ry="14" fill="${pale}" opacity="0.9"/><ellipse cx="${cx + 15}" cy="${noseY + 16}" rx="19" ry="14" fill="${pale}" opacity="0.9"/>` +
          `<path d="M${pt(cx - 11, noseY - 3)}Q${pt(cx, noseY - 6)} ${pt(cx + 11, noseY - 3)}L${pt(cx, noseY + 9)}Z" fill="${mix(colors.skin, '#a85060', 0.7)}" stroke="${darken(colors.skin, 0.55)}" stroke-width="1.2"/>` +
          `<path d="M${pt(cx, noseY + 8)}V${f(mouthY - 4)}" stroke="${darken(colors.skin, 0.45)}" stroke-width="1.6"/>` +
          [-1, 1].flatMap((k) => [0, 1, 2].map((i) => `<circle cx="${cx + k * (10 + i * 7)}" cy="${noseY + 14 + i * 2}" r="1.2" fill="${darken(colors.skin, 0.5)}"/>`)).join(''),
      };
    },
  },
  {
    id: 'furMarkings', label: 'Fur markings', layer: 'marks',
    render({ g, colors, uid, rng }) {
      const clip = uid('fur');
      const dk = darken(colors.skin, 0.45);
      const { cx, w, top, eyeY, browY } = g;
      let s = '';
      // Forehead stripes and cheek bars, like a tabby's.
      for (let i = -2; i <= 2; i++) s += `<path d="M${pt(cx + i * 12, top + 6)}Q${pt(cx + i * 10, top + 26)} ${pt(cx + i * 7, browY - 12)}" stroke="${dk}" stroke-width="${4 - Math.abs(i)}" fill="none" stroke-linecap="round" opacity="0.6"/>`;
      for (const k of [-1, 1]) for (let i = 0; i < 3; i++) s += `<path d="M${pt(cx + k * (w - 2), eyeY + 18 + i * 12)}q${k * -18},${f(rng.range(-3, 3))} ${k * -32},${f(rng.range(2, 6))}" stroke="${dk}" stroke-width="3.5" fill="none" stroke-linecap="round" opacity="0.55"/>`;
      return { defs: `<clipPath id="${clip}"><path d="${facePath(g)}"/></clipPath>`, marks: `<g clip-path="url(#${clip})">${s}</g>` };
    },
  },
  {
    id: 'ramHorns', label: 'Ram horns', group: 'horns', layer: 'accHead',
    render({ g }) {
      const { cx, w, top } = g;
      const bone = '#d8c8a8';
      // Horn curling back and down around the ear, ridged.
      const d = `M${pt(cx + w * 0.4, top + 16)}C${pt(cx + w * 0.6, top - 30)} ${pt(cx + w + 50, top - 30)} ${pt(cx + w + 46, top + 34)}C${pt(cx + w + 42, top + 74)} ${pt(cx + w + 6, top + 70)} ${pt(cx + w + 10, top + 44)}` +
        `C${pt(cx + w + 22, top + 46)} ${pt(cx + w + 24, top + 14)} ${pt(cx + w * 0.82, top + 8)}C${pt(cx + w * 0.7, top + 6)} ${pt(cx + w * 0.62, top + 20)} ${pt(cx + w * 0.66, top + 30)}Z`;
      let ridges = '';
      for (let i = 0; i < 6; i++) ridges += `M${pt(cx + w * 0.62 + i * 12, top - 4 - Math.sin(i / 2) * 8)}l6,14`;
      const one = `<path d="${d}" fill="${bone}" stroke="#6b5d45" stroke-width="3" stroke-linejoin="round"/><path d="${ridges}" stroke="#8a7a5a" stroke-width="2" fill="none"/>`;
      return { accHead: one + mirrored(cx, one) };
    },
  },
  {
    id: 'scales', label: 'Scales', layer: 'marks',
    render({ g, colors, uid }) {
      const clip = uid('scaleClip');
      const pat = uid('scale');
      const dk = darken(colors.skin, 0.35), lt = lighten(colors.skin, 0.2);
      return {
        defs: `<clipPath id="${clip}"><path d="${facePath(g)}"/></clipPath>` +
          `<pattern id="${pat}" width="10" height="8" patternUnits="userSpaceOnUse"><path d="M0,8Q5,1 10,8M-5,4Q0,-3 5,4M5,4Q10,-3 15,4" fill="none" stroke="${dk}" stroke-width="1.1"/><path d="M2,7Q5,3 8,7" fill="none" stroke="${lt}" stroke-width="0.8" opacity="0.6"/></pattern>`,
        marks: `<g clip-path="url(#${clip})"><rect width="512" height="512" fill="url(#${pat})" opacity="0.7"/></g>`,
      };
    },
  },
  {
    id: 'lizardCrest', label: 'Reptile crest', group: 'horns', layer: 'accHead',
    render({ g, colors }) {
      const { cx, top, w } = g;
      const c = mix(colors.skin, colors.accent, 0.35);
      let d = `M${pt(cx - w * 0.5, top + 10)}`;
      for (let i = 0; i <= 8; i++) {
        const t = i / 8, x = cx - w * 0.5 + t * w;
        d += `L${pt(x, top - 34 - Math.sin(t * Math.PI) * 26)}L${pt(x + w / 16, top - 4)}`;
      }
      d += `L${pt(cx + w * 0.55, top + 10)}Z`;
      return { accHead: `<path d="${d}" fill="${c}" stroke="${darken(c, 0.55)}" stroke-width="2.6" stroke-linejoin="round"/><path d="M${pt(cx - w * 0.5, top + 4)}Q${pt(cx, top - 10)} ${pt(cx + w * 0.55, top + 4)}" fill="none" stroke="${darken(c, 0.3)}" stroke-width="2" opacity="0.7"/>` };
    },
  },
];

// A coat of fur for feline faces: short strokes following the fur's direction (up and out
// from the nose) and tufts breaking the outline of the cheeks.
defs.push({
  id: 'felineFur', label: 'Feline fur', layer: 'marks',
  render({ g, colors, uid, rng }) {
    const { cx, w, top, bottom, eyeY, noseY, jawY, cheekW } = g;
    const clip = uid('furClip');
    const lt = lighten(colors.skin, 0.25), dk = darken(colors.skin, 0.25);
    let strokes = '';
    for (let i = 0; i < 380; i++) {
      const x = cx + rng.range(-w, w), y = rng.range(top, bottom);
      // Direction: radiating from just above the nose, like a cat's facial fur.
      let dx = x - cx, dy = y - (noseY - 6);
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      const len = rng.range(4, 8);
      strokes += `M${pt(x, y)}l${f(dx * len)},${f(dy * len)}`;
    }
    // Fur edge: the cheek and jaw outline frayed into fine tufts (a stroke along the face
    // contour, roughened by noise), below the eyes only.
    const fray = uid('furEdge');
    const below = uid('furBelow');
    const edge = `<filter id="${fray}" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feTurbulence type="fractalNoise" baseFrequency="0.25" numOctaves="2" seed="${rng.int(1, 9999)}" result="n"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="11" xChannelSelector="R" yChannelSelector="G"/></filter>` +
      `<clipPath id="${below}"><rect x="0" y="${eyeY - 14}" width="512" height="512"/></clipPath>`;
    return {
      defs: `<clipPath id="${clip}"><path d="${facePath(g)}"/></clipPath>${edge}`,
      marks: `<g clip-path="url(#${below})"><g filter="url(#${fray})"><path d="${facePath(g)}" fill="none" stroke="${mix(colors.skin, dk, 0.25)}" stroke-width="10" opacity="0.9"/></g></g>` +
        `<g clip-path="url(#${clip})"><path d="${strokes}" stroke="${lt}" stroke-width="1" opacity="0.45" stroke-linecap="round"/>` +
        `<path d="${strokes.split('M').slice(0, 140).join('M')}" stroke="${dk}" stroke-width="0.9" opacity="0.35" stroke-linecap="round" transform="translate(2,1)"/></g>`,
    };
  },
});

for (const d of defs) registerPart('accessories', d);
