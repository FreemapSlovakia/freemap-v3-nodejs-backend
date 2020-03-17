const registry = new Map<string, { value: string; takenAt: number }>();

setInterval(cleanup, 60 * 60 * 1000);

function cleanup() {
  const now = Date.now();
  registry.forEach(({ takenAt }, key) => {
    if (now - takenAt > 24 * 60 * 60 * 1000) {
      registry.delete(key);
    }
  });
}

export const requestTokenRegistry = {
  get(key: string): string | null {
    const item = registry.get(key);
    registry.delete(key);
    return item ? item.value : null;
  },

  set(key: string, value: string) {
    registry.set(key, { value, takenAt: Date.now() });
  },
};
