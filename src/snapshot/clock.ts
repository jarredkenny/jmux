import type { Clock } from "./deps";

export class ProductionClock implements Clock {
  now(): number {
    return Date.now();
  }

  setInterval(fn: () => void, ms: number): () => void {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  }
}
