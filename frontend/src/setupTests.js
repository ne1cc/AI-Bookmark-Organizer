const createStorageMock = () => {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; }
  };
};

const storageMock = (typeof window !== 'undefined' && window.localStorage) || createStorageMock();

try {
  delete globalThis.localStorage;
} catch {}

Object.defineProperty(globalThis, 'localStorage', {
  value: storageMock,
  configurable: true,
  writable: true
});

if (typeof window !== 'undefined') {
  try {
    delete window.localStorage;
  } catch {}
  Object.defineProperty(window, 'localStorage', {
    value: storageMock,
    configurable: true,
    writable: true
  });
}
