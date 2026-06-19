// Computer Use — Side Panel UI

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let activeTabId = null;

// ── Init ──────────────────────────────────────────────────────────

async function init() {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    chrome.runtime.sendMessage({ type: 'set_tab', tabId: tab.id });
  }

  // Check status
  const status = await chrome.runtime.sendMessage({ type: 'get_status' });
  updateStatus(status);

  // Refresh status periodically
  setInterval(async () => {
    const s = await chrome.runtime.sendMessage({ type: 'get_status' });
    updateStatus(s);
  }, 5000);

  // Auto-ping on load
  setTimeout(async () => {
    logEntry('Auto-pinging native host...');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ping_native' });
      if (resp && resp.cliclick) {
        logEntry('Native host connected! cliclick ✓ mac_use ✓', 'success');
        updateStatus({ nativeConnected: true, translatorReady: false });
      } else {
        logEntry('Native host not available: ' + JSON.stringify(resp), 'failed');
      }
    } catch (e) {
      logEntry('Ping error: ' + e.message, 'failed');
    }
  }, 1000);

  // Reconnect after short delay
  setTimeout(async () => {
    await chrome.runtime.sendMessage({ type: 'reconnect' });
  }, 500);

  // Ping content script
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'ping' }, (resp) => {
      if (chrome.runtime.lastError) {
        logEntry('Content script not loaded on this page', 'failed');
      } else if (resp) {
        logEntry(`Connected: ${resp.url}`, 'success');
      }
    });
  }
}

function updateStatus(s) {
  const dot = $('#status-dot');
  const text = $('#status-text');
  if (s.nativeConnected) {
    dot.className = 'dot green';
    text.textContent = s.translatorReady ? 'Ready' : 'Calibrating...';
  } else {
    dot.className = 'dot orange';
    text.textContent = 'Native host not connected';
  }
}

// ── Mode Tabs ────────────────────────────────────────────────────

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.mode-panel').forEach(p => p.classList.remove('active'));
    const modeId = tab.dataset.mode + '-mode';
    $(`#${modeId}`).classList.add('active');
  });
});

// ── Action Log ───────────────────────────────────────────────────

function logEntry(text, status = '') {
  const container = $('#log-entries');
  const entry = document.createElement('div');
  entry.className = `log-entry ${status}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  container.prepend(entry);
  // Keep max 50 entries
  while (container.children.length > 50) container.lastChild.remove();
}

// ── Execute Action ──────────────────────────────────────────────

$('#execute-btn').addEventListener('click', async () => {
  const actionType = $('#action-type').value;
  const selector = $('#selector-input').value;
  const value = $('#value-input').value;
  const delay = parseInt($('#speed-slider').value);

  if (!selector && actionType !== 'screenshot' && actionType !== 'wait') {
    logEntry('Please enter a selector', 'failed');
    return;
  }

  logEntry(`Executing: ${actionType} "${selector || ''}"`);

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'execute_step',
      actionType: actionType,
      selector: selector || undefined,
      value: value || undefined,
      description: `${actionType} ${selector || ''}`,
      waitMs: delay
    });

    if (resp.status === 'ok') {
      logEntry(`✓ ${actionType} completed`, 'success');
      if (resp.screenshot) {
        showScreenshot(resp.screenshot);
      }
    } else {
      logEntry(`✗ ${resp.error || resp.message || 'Unknown error'}`, 'failed');
    }
  } catch (e) {
    logEntry(`✗ ${e.message}`, 'failed');
  }
});

// ── Screenshot Display ───────────────────────────────────────────

function showScreenshot(path) {
  // Native screenshots are local file paths, not loadable from extension.
  // For now, show a placeholder and the path.
  $('#no-screenshot').textContent = `Screenshot: ${path}`;
  logEntry(`Screenshot saved: ${path}`, 'success');
}

// ── Instruction Input ────────────────────────────────────────────

$('#instruction-input').addEventListener('keydown', (e) => {
  // Ctrl+Enter to execute multi-line instruction
  if (e.ctrlKey && e.key === 'Enter') {
    $('#execute-btn').click();
  }
});

// ── Speed Slider ─────────────────────────────────────────────────
$('#speed-slider').addEventListener('input', () => {
  $('#speed-value').textContent = $('#speed-slider').value + 'ms';
});

// ── Record Mode ──────────────────────────────────────────────────
$('#record-btn').addEventListener('click', () => {
  logEntry('Record mode not yet implemented', '');
});
$('#stop-record-btn').addEventListener('click', () => {});
$('#replay-btn').addEventListener('click', () => {
  logEntry('Replay mode not yet implemented', '');
});

// ── Reconnect & Ping ───────────────────────────────────────────
$('#reconnect-btn').addEventListener('click', async () => {
  logEntry('Reconnecting...');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'reconnect' });
    logEntry(resp.status === 'ok' ? 'Reconnected ✓' : 'Reconnect failed', resp.status);
    updateStatus(await chrome.runtime.sendMessage({ type: 'get_status' }));
  } catch (e) {
    logEntry('Reconnect error: ' + e.message, 'failed');
  }
});

$('#ping-btn').addEventListener('click', async () => {
  logEntry('Pinging native host directly...');
  try {
    // Direct connect test
    const port = chrome.runtime.connectNative('com.computer-use.native');
    const err = chrome.runtime.lastError;
    if (err) {
      logEntry('Connect error: ' + err.message, 'failed');
      return;
    }
    logEntry('Port opened, sending ping...');
    port.postMessage({ id: 'sidepanel_ping', type: 'ping' });
    port.onMessage.addListener((msg) => {
      if (msg.status === 'ok') {
        logEntry('Pong! cliclick ✓ mac_use ✓', 'success');
        updateStatus({ nativeConnected: true, translatorReady: false });
      } else {
        logEntry('Ping failed: ' + JSON.stringify(msg), 'failed');
      }
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      logEntry('Port disconnected (may indicate error)', 'failed');
    });
    // Timeout
    setTimeout(() => {
      logEntry('Ping timed out after 5s', 'failed');
      try { port.disconnect(); } catch(e) {}
    }, 5000);
  } catch (e) {
    logEntry('Exception: ' + e.message, 'failed');
  }
});

// ── Start ────────────────────────────────────────────────────────
init();
