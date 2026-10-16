// Which portraitgen emotes a portrait plays in each state (web/portraits.js draws them).

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

// At work: eyes running down the page, a glance up now and then, a slight nod as a line lands.
export const WORK_EMOTE = {
  label: 'Work',
  rest: 400,
  repeat: 2,
  steps: [
    { ms: [700, 1000], eyes: { gx: -0.45, gy: 0.55, lid: 0.25 }, head: { dy: 1.5, rot: -1 } },
    { ms: [700, 1000], eyes: { gx: 0.35, gy: 0.6, lid: 0.25 }, head: { dy: 1.5, rot: 0.5 } },
    { ms: [600, 900], eyes: { gx: -0.4, gy: 0.75, lid: 0.3 }, head: { dy: 2.5 } },
    { ms: [500, 700], eyes: { gx: 0.15, gy: 0.1 }, brows: { dy: -1 }, head: null },
  ],
};
