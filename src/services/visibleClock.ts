export function startVisibleClock(options: {
  isVisible: () => boolean | Promise<boolean>;
  update: (date: Date) => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (timer: number) => void;
  interval?: "second" | "day";
  now?: () => Date;
  onError: (error: unknown) => void;
}) {
  let timer: number | undefined;
  let revision = 0;
  let disposed = false;
  const now = options.now ?? (() => new Date());
  const refresh = async () => {
    if (disposed) return;
    const started = ++revision;
    if (timer !== undefined) options.cancel(timer);
    timer = undefined;
    try {
      const visible = await options.isVisible();
      // Focus and visibility events can overlap asynchronous native queries.
      if (disposed || started !== revision || !visible) return;
      options.update(now());
      const current = now();
      const delay = options.interval === "day"
        ? new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime() - current.getTime() + 50
        : 1000 - current.getTime() % 1000;
      timer = options.schedule(() => { void refresh(); }, delay);
    } catch (error) {
      if (!disposed && started === revision) options.onError(error);
    }
  };
  void refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      ++revision;
      if (timer !== undefined) options.cancel(timer);
      timer = undefined;
    },
  };
}
