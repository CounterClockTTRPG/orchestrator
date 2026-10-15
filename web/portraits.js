// Agent portraits from the vendored portraitgen. A role fixes the race, outfit and colours; the agent's
// name seeds the face; the agent's state picks the expression (which only changes brows and mouth).

import { generate, render } from '/vendor/portraitgen/index.js';

const EXPRESSION = {
  queued: 'neutral', working: 'stern', blocked: 'surprised', done: 'smile',
  failed: 'sad', cancelled: 'tired', interrupted: 'tired',
  thinking: 'stern', waiting: 'neutral', idle: 'tired',
};

const cache = new Map();

export function portraitSvg({ seed, role, status, style, size = 160 }) {
  const expression = EXPRESSION[status] ?? 'neutral';
  const key = `${seed}|${role?.describe}|${JSON.stringify(role?.colors ?? {})}|${expression}|${style}|${size}`;
  let svg = cache.get(key);
  if (!svg) {
    try {
      const traits = generate({
        theme: 'fantasy', seed, describe: role?.describe ?? 'human adventurer',
        colors: role?.colors, expression, style,
      });
      svg = render(traits, { size });
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
