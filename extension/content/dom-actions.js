// DOM Actions — Generic, React-safe DOM manipulation primitives.
// Works on any webpage. Handles React synthetic events properly.

const DOMActions = {
  /**
   * Find an element by selector. Returns bounding rect and metadata.
   * selector: CSS selector, or { text: "Find by text content" }
   */
  findElement(selector, index = 0) {
    let els;
    if (typeof selector === 'object' && selector.text) {
      // Find by text content — search all leaf elements
      els = this._findByText(selector.text);
    } else {
      els = document.querySelectorAll(selector);
    }

    if (!els || els.length <= index) {
      return { status: 'not_found', selector: selector, index: index, total: els ? els.length : 0 };
    }

    const el = els[index];
    const rect = el.getBoundingClientRect();
    return {
      status: 'ok',
      tagName: el.tagName,
      className: el.className?.substring?.(0, 80) || '',
      text: (el.innerText || el.textContent || '').trim().substring(0, 100),
      x: rect.x, y: rect.y,
      width: rect.width, height: rect.height,
      centerX: rect.x + rect.width / 2,
      centerY: rect.y + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0,
      elementIndex: index
    };
  },

  _findByText(text) {
    const results = [];
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_ELEMENT,
      { acceptNode: (node) => {
        if (node.children.length === 0 && (node.innerText || '').trim() === text) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }}
    );
    while (walker.nextNode()) results.push(walker.currentNode);

    // If no exact match, try contains
    if (results.length === 0) {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.children.length <= 2 && (el.innerText || '').trim().includes(text)) {
          results.push(el);
        }
      }
    }
    return results;
  },

  /**
   * Click an element — React-safe (native click + MouseEvent sequence).
   */
  clickElement(selector, index = 0) {
    const found = this.findElement(selector, index);
    if (found.status !== 'ok') return found;

    const el = this._getElement(selector, index);
    if (!el) return { status: 'not_found' };

    // Dispatch full mouse event sequence (mousedown → mouseup → click)
    const events = ['mousedown', 'mouseup', 'click'];
    events.forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: found.centerX, clientY: found.centerY, button: 0
      }));
    });

    // Also do native click
    el.click();

    return { ...found, status: 'clicked' };
  },

  /**
   * Fill an input/textarea — React-safe (native value setter + input event).
   */
  fillInput(selector, value, index = 0) {
    const el = this._getElement(selector, index);
    if (!el) return { status: 'not_found', selector: selector };

    const tag = el.tagName.toLowerCase();
    let setter;

    if (tag === 'textarea') {
      setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    } else if (tag === 'input') {
      setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    } else if (tag === 'select') {
      setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    } else {
      // contenteditable or custom — try setting textContent
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { status: 'filled', selector: selector };
    }

    if (setter) {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Also trigger React's onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || setter;
      if (tag === 'input') {
        const ev = new Event('input', { bubbles: true });
        el.dispatchEvent(ev);
      }
    }

    return { status: 'filled', selector: selector, value: value };
  },

  /**
   * Select an option in a dropdown. Supports native <select> and Ant Design .ant-select.
   */
  selectOption(selector, optionText, index = 0) {
    const el = this._getElement(selector, index);
    if (!el) return { status: 'not_found' };

    const tag = el.tagName.toLowerCase();

    // Native <select>
    if (tag === 'select') {
      for (const opt of el.options) {
        if (opt.text.trim() === optionText) {
          opt.selected = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { status: 'selected', option: optionText };
        }
      }
      return { status: 'option_not_found', option: optionText };
    }

    // Ant Design Select: click the rendered selection to open dropdown
    const rendered = el.querySelector('.ant-select-selection__rendered') || el;
    rendered.click();
    rendered.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    rendered.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));

    // Dropdown items appear in a portal — need to wait and then click
    return new Promise((resolve) => {
      const check = () => {
        const items = document.querySelectorAll('.ant-select-dropdown-menu-item');
        for (const item of items) {
          if (item.innerText.trim() === optionText && item.getBoundingClientRect().width > 0) {
            item.click();
            item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            resolve({ status: 'selected', option: optionText });
            return;
          }
        }
        // Not found yet, retry
        setTimeout(check, 200);
      };
      setTimeout(check, 300);
    });
  },

  /**
   * Scroll element into view smoothly.
   */
  scrollTo(selector, index = 0) {
    const el = this._getElement(selector, index);
    if (!el) return { status: 'not_found' };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { status: 'scrolled' };
  },

  /**
   * Wait for an element to appear (poll getComputedStyle or bounding rect).
   */
  waitFor(selector, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = this._getElement(selector, 0);
        if (el && el.getBoundingClientRect().width > 0) {
          resolve({ status: 'found', elapsed: Date.now() - start });
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ status: 'timeout', selector: selector, elapsed: timeoutMs });
          return;
        }
        setTimeout(check, 200);
      };
      setTimeout(check, 100);
    });
  },

  /**
   * Get all interactive elements on the page with their rects.
   */
  getAllInteractive() {
    const selectors = 'button, a, input, textarea, select, [role="button"], [onclick], .ant-select, .ant-radio, .ant-checkbox';
    const els = document.querySelectorAll(selectors);
    const results = [];
    for (let i = 0; i < Math.min(els.length, 100); i++) {
      const r = els[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0) {
        results.push({
          index: i,
          tagName: els[i].tagName,
          className: (els[i].className || '').substring(0, 60),
          text: (els[i].innerText || '').trim().substring(0, 50),
          x: r.x, y: r.y,
          width: r.width, height: r.height,
          centerX: r.x + r.width / 2,
          centerY: r.y + r.height / 2
        });
      }
    }
    return results;
  },

  /**
   * Get the element reference for a selector + index combo.
   */
  _getElement(selector, index = 0) {
    if (typeof selector === 'string') {
      const els = document.querySelectorAll(selector);
      return els.length > index ? els[index] : null;
    }
    if (typeof selector === 'object' && selector.text) {
      const found = this._findByText(selector.text);
      return found.length > index ? found[index] : null;
    }
    return null;
  }
};

// Expose
window.__cuActions = DOMActions;
