// DOM utility helpers

/**
 * Create an element with optional attributes, classes, and children.
 * @param {string} tag
 * @param {Object} [opts]
 * @param {string|string[]} [opts.className]
 * @param {Object} [opts.attrs]
 * @param {string} [opts.text]
 * @param {string} [opts.html]
 * @param {(Node|string)[]} [opts.children]
 * @param {Object} [opts.events]
 * @param {Object} [opts.style]
 * @param {Object} [opts.dataset]
 * @returns {HTMLElement}
 */
export function el(tag, opts = {}) {
  const element = document.createElement(tag);

  if (opts.className) {
    const raw = Array.isArray(opts.className) ? opts.className : [opts.className];
    const classes = raw
      .filter(Boolean)
      .flatMap(c => c.split(/\s+/))
      .filter(Boolean);
    if (classes.length > 0) {
      element.classList.add(...classes);
    }
  }

  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      element.setAttribute(key, value);
    }
  }

  if (opts.dataset) {
    for (const [key, value] of Object.entries(opts.dataset)) {
      element.dataset[key] = value;
    }
  }

  if (opts.style) {
    Object.assign(element.style, opts.style);
  }

  if (opts.text) {
    element.textContent = opts.text;
  } else if (opts.html) {
    element.innerHTML = opts.html;
  }

  if (opts.children) {
    for (const child of opts.children) {
      if (typeof child === 'string') {
        element.appendChild(document.createTextNode(child));
      } else if (child instanceof Node) {
        element.appendChild(child);
      }
    }
  }

  if (opts.events) {
    for (const [event, handler] of Object.entries(opts.events)) {
      element.addEventListener(event, handler);
    }
  }

  return element;
}

/**
 * Remove all children from an element.
 */
export function clearChildren(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

