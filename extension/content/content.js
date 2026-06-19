// Computer Use — Content Script Entry Point
// Listens for messages from the background service worker and delegates to
// VirtualCursor, DOMActions, and PageScreenshot modules.

(function() {
  // Ensure virtual cursor is initialized
  if (!window.__cuCursor) {
    // Re-inject if page navigated (SPA)
    window.__cuCursor = new VirtualCursor();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // ── Virtual Cursor ──────────────────────────────────────────
    if (msg.type === 'animate_cursor') {
      const cursor = window.__cuCursor;
      if (cursor) {
        cursor.moveTo(msg.x, msg.y, msg.state || 'hovering', msg.label || '')
          .then(() => sendResponse({ status: 'ok' }));
      } else {
        sendResponse({ status: 'failed', error: 'Cursor not initialized' });
      }
      return true; // async
    }

    if (msg.type === 'get_cursor_position') {
      const cursor = window.__cuCursor;
      sendResponse(cursor ? cursor.getPosition() : { x: -1, y: -1 });
      return false;
    }

    // ── Element Position ────────────────────────────────────────
    if (msg.type === 'get_element_position') {
      const result = DOMActions.findElement(msg.selector, msg.index || 0);
      sendResponse(result);
      return false;
    }

    // ── DOM Actions ─────────────────────────────────────────────
    if (msg.type === 'exec_dom_action') {
      const action = msg.action;
      let result;

      switch (action.type) {
        case 'click':
          result = DOMActions.clickElement(action.selector, action.index || 0);
          break;
        case 'fill':
          result = DOMActions.fillInput(action.selector, action.value, action.index || 0);
          break;
        case 'select':
          result = DOMActions.selectOption(action.selector, action.value, action.index || 0);
          // selectOption may return a Promise
          if (result instanceof Promise) {
            result.then(sendResponse);
            return true;
          }
          break;
        case 'scroll':
          result = DOMActions.scrollTo(action.selector, action.index || 0);
          break;
        case 'wait':
          DOMActions.waitFor(action.selector, action.timeoutMs || 10000).then(sendResponse);
          return true;
        case 'find':
          result = DOMActions.findElement(action.selector, action.index || 0);
          break;
        case 'getAllInteractive':
          result = DOMActions.getAllInteractive();
          break;
        default:
          result = { status: 'unknown_action', action: action.type };
      }

      sendResponse(result);
      return false;
    }

    // ── JS Execution (returns JSON) ─────────────────────────────
    if (msg.type === 'exec_js') {
      try {
        const result = (function() { return eval(msg.code); })();
        sendResponse({ status: 'ok', result: typeof result === 'string' ? result : JSON.stringify(result) });
      } catch (e) {
        sendResponse({ status: 'failed', error: e.message });
      }
      return false;
    }

    // ── Page Screenshot ─────────────────────────────────────────
    if (msg.type === 'page_screenshot') {
      if (msg.selector) {
        window.__cuScreenshot.captureElement(msg.selector, msg.index || 0).then(sendResponse);
      } else {
        window.__cuScreenshot.capture().then(sendResponse);
      }
      return true;
    }

    // ── Ping ────────────────────────────────────────────────────
    if (msg.type === 'ping') {
      sendResponse({
        status: 'ok',
        cursorReady: !!window.__cuCursor,
        actionsReady: !!window.__cuActions,
        url: window.location.href
      });
      return false;
    }

    return false;
  });

  console.log('[ComputerUse] Content script loaded');
})();
