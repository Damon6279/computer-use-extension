// Page-level screenshot via html2canvas.
// Requires html2canvas to be loaded before this script (from lib/).

const PageScreenshot = {
  /**
   * Capture current viewport as a data URL.
   * Falls back to null if html2canvas is not available or fails.
   */
  async capture() {
    if (typeof html2canvas === 'undefined') {
      return { status: 'unavailable', error: 'html2canvas not loaded' };
    }
    try {
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: document.documentElement.scrollHeight,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight
      });
      return {
        status: 'ok',
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height
      };
    } catch (e) {
      // Fall back to just capturing the viewport dimensions
      return { status: 'failed', error: e.message };
    }
  },

  /**
   * Get just the viewport dimensions (lightweight, no rendering).
   */
  getDimensions() {
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio
    };
  },

  /**
   * Capture a specific element.
   */
  async captureElement(selector, index = 0) {
    if (typeof html2canvas === 'undefined') {
      return { status: 'unavailable' };
    }
    const el = document.querySelectorAll(selector)[index];
    if (!el) return { status: 'not_found', selector: selector };
    try {
      const canvas = await html2canvas(el, {
        useCORS: true,
        allowTaint: true,
        logging: false
      });
      return {
        status: 'ok',
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height
      };
    } catch (e) {
      return { status: 'failed', error: e.message };
    }
  }
};

window.__cuScreenshot = PageScreenshot;
