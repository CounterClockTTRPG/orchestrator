// The global concurrency cap on party members across all quests (the Archmages are not counted). Waiting agents
// with a higher priority (a longer chain of work behind them) start first; equal ones in arrival order.

export class Scheduler {
  /** `limit()` gives the current cap, so a change of settings applies at the next start. */
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = []; // [{ start, priority }]
  }

  /** Run `start` now if a slot is free, or queue it. */
  acquire(start, priority = 1) {
    if (this.running < this.limit()) { this.running++; start(); } else this.queue.push({ start, priority });
  }

  release() {
    this.running = Math.max(0, this.running - 1);
    this.drain();
  }

  /** Take a callback off the queue. True if it was waiting there (so it never held a slot). */
  dequeue(start) {
    const i = this.queue.findIndex((e) => e.start === start);
    if (i >= 0) this.queue.splice(i, 1);
    return i >= 0;
  }

  drain() {
    while (this.queue.length && this.running < this.limit()) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority > this.queue[best].priority) best = i;
      this.running++;
      this.queue.splice(best, 1)[0].start();
    }
  }
}
