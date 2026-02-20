// Debounce and throttle utilities

/**
 * Debounce a function — only calls it after `delay` ms of inactivity.
 * @param {Function} fn
 * @param {number} delay - Milliseconds
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Throttle a function — calls at most once per `interval` ms.
 * @param {Function} fn
 * @param {number} interval - Milliseconds
 * @returns {Function}
 */
export function throttle(fn, interval) {
  let lastCall = 0;
  let timer;
  return function (...args) {
    const now = Date.now();
    const remaining = interval - (now - lastCall);
    clearTimeout(timer);
    if (remaining <= 0) {
      lastCall = now;
      fn.apply(this, args);
    } else {
      timer = setTimeout(() => {
        lastCall = Date.now();
        fn.apply(this, args);
      }, remaining);
    }
  };
}
