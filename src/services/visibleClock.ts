export function startVisibleClock(options: {
  isVisible: () => boolean | Promise<boolean>;
  update: (date: Date) => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (timer: number) => void;
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
      timer = options.schedule(() => { void refresh(); }, 1000 - now().getTime() % 1000);
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
