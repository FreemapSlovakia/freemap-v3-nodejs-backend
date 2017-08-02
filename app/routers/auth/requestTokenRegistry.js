const registry = new Map();

setInterval(cleanup, 60 * 60 * 1000);

function cleanup() {
  const now = Date.now();
  registry.forEach(({ timestamp }, key) => {
    if (now - timestamp > 24 * 60 * 60 * 1000) {
      registry.delete(key);
    }
  });
}

module.exports = {
  get(key) {
    const item = registry.get(key);
    registry.delete(key);
    return item ? item.value : null;
  },

  set(key, value) {
    registry.set(key, { value, timestamp: Date.now() });
  },
};
