// Favicon URL resolution using Chrome's built-in favicon service

/**
 * Get the favicon URL for a page using Chrome's _favicon API.
 * Requires the "favicon" permission in manifest.json.
 * Chrome only supports sizes 16 and 32 — other values get rounded down.
 * @param {string} pageUrl - The URL of the page
 * @param {number} [size=16] - Icon size (16 or 32)
 * @returns {string} The favicon URL
 */
export function getFaviconUrl(pageUrl, size = 16) {
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  // Chrome _favicon API only supports 16 and 32. Request 32 for any size > 16
  // to get the highest quality icon available.
  url.searchParams.set('size', size > 16 ? '32' : '16');
  return url.toString();
}

/**
 * Create an img element for a favicon with fallback handling.
 * @param {string} pageUrl
 * @param {number} [size=16] - Display size (CSS pixels). The actual image
 *   fetched from Chrome may be larger (32px) for better quality on HiDPI.
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
