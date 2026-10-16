// Agent portraits from the vendored portraitgen. A role fixes the race, outfit and colours; the agent's
// name seeds the face; the agent's state picks the expression (which only changes brows and mouth) and,
// on the large portraits, an animation (portraitgen emotes): at work, thinking, talking, asleep.

import { generate, render, registerEmote } from '/vendor/portraitgen/index.js';

const EXPRESSION = {
  queued: 'neutral', waiting: 'neutral', working: 'stern', blocked: 'surprised', done: 'smile',
  failed: 'sad', cancelled: 'tired', interrupted: 'tired',
  thinking: 'stern', listening: 'neutral', idle: 'tired',
};

// At work: eyes running down the page, a glance up now and then, a slight nod as a line lands.
registerEmote('work', {
  label: 'Work',
  rest: 400,
  repeat: 2,
  steps: [
    { ms: [700, 1000], eyes: { gx: -0.45, gy: 0.55, lid: 0.25 }, head: { dy: 1.5, rot: -1 } },
    { ms: [700, 1000], eyes: { gx: 0.35, gy: 0.6, lid: 0.25 }, head: { dy: 1.5, rot: 0.5 } },
    { ms: [600, 900], eyes: { gx: -0.4, gy: 0.75, lid: 0.3 }, head: { dy: 2.5 } },
    { ms: [500, 700], eyes: { gx: 0.15, gy: 0.1 }, brows: { dy: -1 }, head: null },
  ],
});

/**
 * The emotes for a portrait's state. `kind` is 'agent' or 'leader'; `talking` (a line of text) makes it speak.
 *   working: reads its work · thinking or blocked: ponders · queued, done: at ease, blinking and breathing
 *   waiting for others, interrupted, a leader at rest: asleep · failed, recalled: only blinks
 */
export function motionFor(kind, status, talking) {
  if (talking) return ['blink', 'talk'];
  if (kind === 'leader') {
    return { thinking: ['blink', 'breathe', 'thinking'], listening: ['blink', 'breathe'] }[status] ?? ['sleep'];
  }
  return {
    working: ['blink', 'breathe', 'work'],
    blocked: ['blink', 'thinking'],
    queued: ['blink', 'breathe'],
    done: ['blink', 'breathe'],
    waiting: ['sleep'],
    interrupted: ['sleep'],
  }[status] ?? ['blink'];
}

const cache = new Map();
let portraitTheme = 'fantasy';
let animated = true;

/** The portraitgen theme (fantasy, modern or scifi) used when a call does not name one. */
export function setPortraitTheme(id) { portraitTheme = id; }
/** Turn portrait animations on or off (they are also off for viewers who prefer reduced motion). */
export function setPortraitMotion(on) { animated = on !== false; }

function hashKey(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return (h >>> 0).toString(36);
}

// `presentation` (masculine, feminine, androgynous) keeps the face in line with the agent's name; without one,
// portraitgen draws it from the seed. `emotes` animates it; `say` is the line a talking portrait lip-syncs.
export function portraitSvg({ seed, role, status, style, size = 160, theme = portraitTheme, presentation, emotes, say }) {
  const expression = EXPRESSION[status] ?? 'neutral';
  const motion = animated && emotes?.length ? emotes : null;
  const line = motion?.includes('talk') ? String(say ?? '').slice(0, 140) : '';
  const key = `${theme}|${seed}|${role?.describe}|${JSON.stringify(role?.colors ?? {})}|${expression}|${style}|${size}|${presentation ?? ''}|${motion?.join(',') ?? ''}|${line}`;
  let svg = cache.get(key);
  if (!svg) {
    try {
      const traits = generate({
        theme, seed, describe: role?.describe ?? 'human adventurer',
        colors: role?.colors, expression, style, presentation,
      });
      // An animated portrait's CSS is page-wide: give each variant its own ids so two of them never clash.
      svg = render(traits, { size, ...(motion ? { emotes: motion, say: line || undefined, idPrefix: `gp${hashKey(key)}` } : {}) });
    } catch (err) {
      console.warn('portrait failed', err);
      svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="${size}" height="${size}"><rect width="10" height="10" fill="#222"/></svg>`;
    }
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(key, svg);
  }
  return { key, svg };
}

/** Put a portrait into `el`, skipping the DOM work when it is already showing that exact portrait. */
export function setPortrait(el, opts) {
  const { key, svg } = portraitSvg(opts);
  if (el.dataset.portrait !== key) {
    el.innerHTML = svg;
    el.dataset.portrait = key;
  }
}

export const STYLES = ['painterly', 'illustrated', 'realistic', 'engraving', 'inkwash', 'anime', 'pixel'];
