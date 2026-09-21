import type { AuthDisplay } from "@pi-remote/protocol";

/** Memory-only polling. Generation invalidation prevents late responses restoring hidden secrets. */
export class AuthDisplayClient {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private fetch: () => Promise<{ items: AuthDisplay[] }>, private publish: (items: AuthDisplay[]) => void) {}
  setActive(active: boolean): void {
    const generation = ++this.generation;
    clearTimeout(this.timer); this.publish([]);
    if (!active) return;
    const poll = async () => {
      try { const result = await this.fetch(); if (this.generation === generation) this.publish(result.items); }
      catch { if (this.generation === generation) this.publish([]); }
      if (this.generation === generation) this.timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
  }
}
