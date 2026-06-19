// Computer Use — Background Service Worker
// Routes messages between side panel, content scripts, native host, and CDP.
// Manages coordinate translation and action execution.

const NATIVE_HOST = 'com.computer-use.native';

let nativePort = null;
let tabId = null;
let pendingCallbacks = new Map();
let msgId = 0;

// ── CDP Manager ─────────────────────────────────────────────────────

class CDPManager {
  constructor() {
    this._tabId = null;
    this._attached = false;
  }

  get attached() { return this._attached; }

  attach(tabId) {
    return new Promise((resolve) => {
      if (this._attached && this._tabId === tabId) { resolve(true); return; }
      this._tabId = tabId;
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          console.error('[CDP] attach error:', chrome.runtime.lastError.message);
          resolve(false);
        } else {
          this._attached = true;
          console.log('[CDP] attached to tab', tabId);
          resolve(true);
        }
      });
    });
  }

  detach() {
    return new Promise((resolve) => {
      if (!this._attached) { resolve(); return; }
      chrome.debugger.detach({ tabId: this._tabId }, () => {
        this._attached = false;
        resolve();
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      if (!this._attached) { resolve({ status: 'failed', error: 'CDP not attached' }); return; }
      chrome.debugger.sendCommand({ tabId: this._tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          resolve({ status: 'failed', error: chrome.runtime.lastError.message });
        } else {
          resolve({ status: 'ok', result });
        }
      });
    });
  }

  async ensureAttached(tabId) {
    if (!this._attached || this._tabId !== tabId) {
      const ok = await this.attach(tabId);
      if (!ok) throw new Error('Failed to attach CDP');
    }
  }

  // ── CDP Operations ───────────────────────────────────────────────
  // All return { status, result? , error? }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { status: 'ok', x, y };
  }

  async clickElement(selector, index = 0) {
    const resolved = await this.resolveElement(selector, index);
    if (resolved.status !== 'ok') return resolved;
    return await this.click(resolved.x, resolved.y);
  }

  async fill(selector, value, index = 0) {
    // Use Runtime.evaluate to directly set value with React-compatible events
    const sanitized = JSON.stringify(value);
    const escapedSelector = JSON.stringify(selector);
    const result = await this.send('Runtime.evaluate', {
      expression: `(function(){var el=document.querySelectorAll(${escapedSelector})[${index}];if(!el)return{error:'not found'};el.focus();var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;if(setter)setter.call(el,${sanitized});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{value:${sanitized}}})()`,
      returnByValue: true
    });
    if (result.status !== 'ok') return result;
    if (result.result?.exceptionDetails) {
      return { status: 'failed', error: result.result.exceptionDetails.text };
    }
    return { status: 'filled', selector, value };
  }

  async screenshot(format = 'png') {
    const resp = await this.send('Page.captureScreenshot', { format });
    if (resp.status !== 'ok') return resp;
    return { status: 'ok', data: resp.result.data, mimeType: `image/${format}` };
  }

  async setFileInput(selector, filePaths, index = 0) {
    // Step 1: Get document root
    const doc = await this.send('DOM.getDocument');
    if (doc.status !== 'ok') return doc;
    const docNodeId = doc.result.root.nodeId;

    // Step 2: Query for the input element
    const query = await this.send('DOM.querySelector', {
      nodeId: docNodeId,
      selector: selector
    });
    if (query.status !== 'ok') return query;
    const nodeId = query.result.nodeId;

    // Step 3: Set files
    const result = await this.send('DOM.setFileInputFiles', {
      nodeId: nodeId,
      files: filePaths
    });
    return { status: 'ok', files: filePaths };
  }

  async scroll(deltaX = 0, deltaY = 0, x = 0, y = 0) {
    await this.send('Input.dispatchMouseWheelEvent', {
      deltaX, deltaY, x, y
    });
    return { status: 'ok', deltaX, deltaY };
  }

  async navigate(url) {
    const resp = await this.send('Page.navigate', { url });
    return resp;
  }

  async evaluate(expression) {
    const resp = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true
    });
    if (resp.status !== 'ok') return resp;
    if (resp.result?.exceptionDetails) {
      return { status: 'failed', error: resp.result.exceptionDetails.text };
    }
    return { status: 'ok', result: resp.result.result?.value };
  }

  async getAccessibilityTree() {
    const resp = await this.send('Accessibility.getFullAXTree');
    return resp;
  }

  async getAllInteractive() {
    const resp = await this.evaluate(`(function(){
      var sel='button,a,input,textarea,select,[role="button"],[role="checkbox"],[role="radio"],[onclick],.ant-select,.ant-radio,.ant-checkbox,[tabindex]:not([tabindex="-1"])';
      var els=document.querySelectorAll(sel);
      var out=[];
      for(var i=0;i<els.length&&i<200;i++){
        var r=els[i].getBoundingClientRect();
        if(r.width>0&&r.height>0&&r.x>=0&&r.y>=0){
          out.push({index:i,tag:els[i].tagName,text:(els[i].innerText||'').trim().substring(0,80),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),cx:Math.round(r.x+r.width/2),cy:Math.round(r.y+r.height/2)});
        }
      }
      return out;
    })()`);
    return resp;
  }

  async resolveElement(selector, index = 0) {
    // Get center position of an element by evaluating in page context
    const escapedSelector = JSON.stringify(selector);
    const expr = `(function(){
      var els=document.querySelectorAll(${escapedSelector});
      if(els.length<=${index}) return {error:'not_found',total:els.length};
      var el=els[${index}];
      var r=el.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height),tag:el.tagName};
    })()`;
    const resp = await this.evaluate(expr);
    return resp;
  }
}

const cdp = new CDPManager();

// ── Coordinate Translator ────────────────────────────────────────

class CoordinateTranslator {
  constructor(geo, biases) {
    this.screenX = geo.screenX;
    this.screenY = geo.screenY;
    this.outerW = geo.outerW;
    this.outerH = geo.outerH;
    this.innerW = geo.innerW;
    this.innerH = geo.innerH;
    this.toolbar = geo.outerH - geo.innerH || 91;
    this.xBias = biases?.x || 0;
    this.yBias = biases?.y || 0;
  }

  cssToScreen(cssX, cssY) {
    const xScale = this.outerW / this.innerW;
    const yScale = (this.outerH - this.toolbar) / this.innerH;
    return {
      x: Math.round(this.screenX + cssX * xScale + this.xBias),
      y: Math.round(this.screenY + this.toolbar + cssY * yScale + this.yBias)
    };
  }

  screenToCss(screenX, screenY) {
    const xScale = this.outerW / this.innerW;
    const yScale = (this.outerH - this.toolbar) / this.innerH;
    return {
      x: Math.round((screenX - this.screenX - this.xBias) / xScale),
      y: Math.round((screenY - this.screenY - this.toolbar - this.yBias) / yScale)
    };
  }
}

let translator = null;

async function loadBiases() {
  const result = await chrome.storage.local.get(['x_bias', 'y_bias']);
  return { x: result.x_bias || 0, y: result.y_bias || 0 };
}

async function refreshTranslator() {
  try {
    const geoResp = await sendNative({ type: 'window_geometry' });
    if (geoResp.status !== 'ok') throw new Error('Failed to get window geometry');

    const dimResp = await sendContent({
      type: 'exec_js',
      code: '({outerW:window.outerWidth,outerH:window.outerHeight,innerW:window.innerWidth,innerH:window.innerHeight,dpr:window.devicePixelRatio})'
    });
    const dims = JSON.parse(dimResp.result);

    const biases = await loadBiases();
    translator = new CoordinateTranslator({
      screenX: geoResp.screenX,
      screenY: geoResp.screenY,
      outerW: dims.outerW,
      outerH: dims.outerH,
      innerW: dims.innerW,
      innerH: dims.innerH
    }, biases);

    return { status: 'ok', translator };
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

// ── Native Messaging ──────────────────────────────────────────────

function connectNative() {
  try {
    if (nativePort) {
      try { nativePort.disconnect(); } catch(e) {}
      nativePort = null;
    }
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    if (chrome.runtime.lastError) {
      console.error('[ComputerUse] connectNative error:', chrome.runtime.lastError.message);
      nativePort = null;
      return false;
    }
    console.log('[ComputerUse] Native host connecting...');

    nativePort.onMessage.addListener((msg) => {
      console.log('[ComputerUse] Native msg:', msg.type);
      const cb = pendingCallbacks.get(msg.id);
      if (cb) {
        pendingCallbacks.delete(msg.id);
        cb(msg);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.log('[ComputerUse] Native host disconnected');
      nativePort = null;
      // Reject all pending callbacks so nothing hangs forever
      const err = { type: 'error', message: 'Native host disconnected', status: 'failed' };
      for (const [id, cb] of pendingCallbacks) {
        pendingCallbacks.delete(id);
        cb(err);
      }
    });

    const id = 'init_ping';
    const pingMsg = { id, type: 'ping' };
    nativePort.postMessage(pingMsg);

    console.log('[ComputerUse] Native host connected');
    return true;
  } catch (e) {
    console.error('[ComputerUse] Failed to connect native host:', e.message);
    nativePort = null;
    return false;
  }
}

function sendNative(msg, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!nativePort) connectNative();
    const id = `n${++msgId}`;
    msg.id = id;
    pendingCallbacks.set(id, resolve);
    // Timeout guard so a dead native host doesn't hang forever
    const timer = setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        resolve({ id, type: 'error', message: 'Native host timeout', status: 'failed' });
      }
    }, timeoutMs);
    // Wrap so the cleanup also clears the timer
    pendingCallbacks.set(id, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
    try {
      nativePort.postMessage(msg);
    } catch (e) {
      clearTimeout(timer);
      pendingCallbacks.delete(id);
      resolve({ id, type: 'error', message: e.message, status: 'failed' });
    }
  });
}

// ── Content Script Messaging ─────────────────────────────────────

function sendContent(msg) {
  return new Promise((resolve) => {
    const id = `c${++msgId}`;
    msg.id = id;
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ id, type: 'error', message: chrome.runtime.lastError.message, status: 'failed' });
      } else {
        resolve(response || { id, type: 'error', message: 'No response', status: 'failed' });
      }
    });
  });
}

// ── Side Panel / Popup Messaging ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({
      nativeConnected: nativePort !== null,
      tabId,
      translatorReady: translator !== null,
      cdpAttached: cdp.attached
    });
    return false;
  }

  if (msg.type === 'calibrate') {
    handleCalibrate(msg.cssX, msg.cssY, msg.screenX, msg.screenY).then(sendResponse);
    return true;
  }

  if (msg.type === 'set_tab') {
    tabId = msg.tabId;
    sendResponse({ status: 'ok' });
    return false;
  }

  if (msg.type === 'reconnect') {
    const result = connectNative();
    sendResponse({ status: result ? 'ok' : 'failed', nativePort: !!nativePort });
    return false;
  }

  if (msg.type === 'ping_native') {
    sendNative({ type: 'ping' }).then(sendResponse);
    return true;
  }

  // Execute an action (legacy, DOM-based or native)
  if (msg.type === 'execute_action') {
    executeAction(msg.action).then(sendResponse);
    return true;
  }

  // Full step: screenshot → animate → execute → screenshot
  if (msg.type === 'execute_step') {
    executeStep(msg).then(sendResponse);
    return true;
  }

  // ── CDP operations ────────────────────────────────────────────
  if (msg.type === 'cdp_attach') {
    cdp.attach(msg.tabId || tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_detach') {
    cdp.detach().then(() => sendResponse({ status: 'ok' }));
    return true;
  }

  if (msg.type === 'cdp_click') {
    handleCDPClick(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_fill') {
    handleCDPFill(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_screenshot') {
    handleCDPScreenshot(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_file_input') {
    handleCDPFileInput(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_scroll') {
    cdp.scroll(msg.deltaX || 0, msg.deltaY || 0, msg.x || 0, msg.y || 0).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_evaluate') {
    cdp.evaluate(msg.expression).then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_interactive') {
    cdp.getAllInteractive().then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_ax_tree') {
    cdp.getAccessibilityTree().then(sendResponse);
    return true;
  }

  if (msg.type === 'cdp_navigate') {
    cdp.navigate(msg.url).then(sendResponse);
    return true;
  }

  return false;
});

// ── CDP Action Handlers ──────────────────────────────────────────

async function ensureCDP() {
  if (!cdp.attached) {
    const ok = await cdp.attach(tabId);
    if (!ok) throw new Error('CDP not available');
  }
}

async function handleCDPClick(msg) {
  try {
    await ensureCDP();
    if (msg.x != null && msg.y != null) {
      return await cdp.click(msg.x, msg.y);
    }
    if (msg.selector) {
      return await cdp.clickElement(msg.selector, msg.elementIndex || 0);
    }
    return { status: 'failed', error: 'No x/y or selector specified' };
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

async function handleCDPFill(msg) {
  try {
    await ensureCDP();
    if (!msg.selector || msg.value == null) {
      return { status: 'failed', error: 'Selector and value required' };
    }
    return await cdp.fill(msg.selector, msg.value, msg.elementIndex || 0);
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

async function handleCDPScreenshot(msg) {
  try {
    await ensureCDP();
    const resp = await cdp.screenshot(msg.format || 'png');
    return resp;
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

async function handleCDPFileInput(msg) {
  try {
    await ensureCDP();
    if (!msg.selector || !msg.files || !msg.files.length) {
      return { status: 'failed', error: 'Selector and files[] required' };
    }
    return await cdp.setFileInput(msg.selector, msg.files, msg.elementIndex || 0);
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

// ── Calibration ──────────────────────────────────────────────────

async function handleCalibrate(cssX, cssY, screenX, screenY) {
  await refreshTranslator();
  if (!translator) return { status: 'failed', error: 'Could not get window geometry' };

  const predicted = translator.cssToScreen(cssX, cssY);
  const xBias = screenX - predicted.x;
  const yBias = screenY - predicted.y;

  await chrome.storage.local.set({ x_bias: xBias, y_bias: yBias });
  translator.xBias = xBias;
  translator.yBias = yBias;

  return {
    status: 'ok',
    predicted,
    actual: { x: screenX, y: screenY },
    biases: { x: xBias, y: yBias }
  };
}

// ── Action Executor ──────────────────────────────────────────────

async function executeAction(action) {
  if (action.type === 'screenshot') {
    const resp = await sendNative({ type: 'screenshot' });
    return resp;
  }

  // DOM actions — delegate to content script
  return await sendContent({ type: 'exec_dom_action', action });
}

// ── Full Step Executor ───────────────────────────────────────────

async function executeStep(msg) {
  // 1. Get window geometry and refresh translator
  await refreshTranslator();
  if (!translator) return { status: 'failed', error: 'Translator not ready. Is Chrome focused?' };

  // 2. Animate cursor to target (if using physical mode)
  if (msg.selector && msg.usePhysicalClick !== false) {
    const posResp = await sendContent({
      type: 'get_element_position',
      selector: msg.selector,
      index: msg.elementIndex || 0
    });

    if (posResp.status === 'ok') {
      await sendContent({
        type: 'animate_cursor',
        x: posResp.centerX,
        y: posResp.centerY,
        state: 'hovering',
        label: msg.description || msg.actionType
      });
      await sleep(600);

      const screen = translator.cssToScreen(posResp.centerX, posResp.centerY);

      if (msg.actionType === 'click') {
        await sendContent({
          type: 'animate_cursor',
          x: posResp.centerX, y: posResp.centerY,
          state: 'about-to-click'
        });
        await sleep(200);
        await sendNative({ type: 'mouse_click', x: screen.x, y: screen.y });
        await sendContent({
          type: 'animate_cursor',
          x: posResp.centerX, y: posResp.centerY,
          state: 'clicking'
        });
      } else if (msg.actionType === 'fill') {
        await sendNative({ type: 'mouse_click', x: screen.x, y: screen.y });
        await sleep(300);
        await sendContent({
          type: 'exec_dom_action',
          action: { type: 'fill', selector: msg.selector, value: msg.value, index: msg.elementIndex || 0 }
        });
      } else if (msg.actionType === 'select') {
        await sendNative({ type: 'mouse_click', x: screen.x, y: screen.y });
        await sleep(500);
        await sendContent({
          type: 'exec_dom_action',
          action: { type: 'select', selector: msg.selector, value: msg.value }
        });
      }
    }
  }

  // 3. Wait if needed
  if (msg.waitMs) await sleep(msg.waitMs);

  // 4. Take verification screenshot
  const screenshot = await sendNative({ type: 'screenshot' });

  return { status: 'ok', screenshot: screenshot.path };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Init ──────────────────────────────────────────────────────────

connectNative();
console.log('[ComputerUse] Background service worker started');
