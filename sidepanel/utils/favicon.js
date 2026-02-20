// Favicon URL resolution using Chrome's built-in favicon service

/**
 * Get the favicon URL for a page using Chrome's _favicon API.
 * Requires the "favicon" permission in manifest.json.
 * @param {string} pageUrl - The URL of the page
 * @param {number} [size=16] - Icon size (16 or 32)
 * @returns {string} The favicon URL
 */
export function getFaviconUrl(pageUrl, size = 16) {
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

/**
 * Create an img element for a favicon with fallback handling.
 * @param {string} pageUrl
 * @param {number} [size=16]
 * @returns {HTMLImageElement}
 */
export function createFaviconImg(pageUrl, size = 16) {
  const img = document.createElement('img');
  img.className = 'favicon';
  img.width = size;
  img.height = size;
  img.loading = 'lazy';
  img.alt = '';

  if (pageUrl) {
    img.src = getFaviconUrl(pageUrl, size);
    img.onerror = () => {
      // Fallback: hide the img and show the sibling globe icon
      img.classList.add('favicon-error');
    };
  }

  return img;
}
