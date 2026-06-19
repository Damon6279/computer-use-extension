// Virtual Cursor — SVG overlay injected into page DOM.
// Animates between CSS viewport coordinates with smooth CSS transitions.
// Never interferes with actual clicks (pointer-events: none).

class VirtualCursor {
  constructor() {
    this.svgNS = 'http://www.w3.org/2000/svg';
    this.ring = null;
    this.dot = null;
    this.pulse = null;
    this.label = null;
    this.currentX = -100;
    this.currentY = -100;
    this.state = 'idle';
    this.animationMs = 350;
    this._ensureDOM();
  }

  _ensureDOM() {
    if (document.getElementById('__cu_overlay')) return;

    const svg = document.createElementNS(this.svgNS, 'svg');
    svg.setAttribute('id', '__cu_overlay');
    svg.setAttribute('style',
      'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
      'pointer-events:none;z-index:2147483647;'
    );

    // Pulse ring
    this.pulse = this._circle('__cu_pulse', 18, '#FF6B35', 2.5, 0.4);
    svg.appendChild(this.pulse);

    // Main ring
    this.ring = this._circle('__cu_ring', 12, '#FF4500', 3, 1);
    svg.appendChild(this.ring);

    // Center dot
    this.dot = this._circle('__cu_dot', 3, '#FF4500', 0, 1);
    this.dot.setAttribute('fill', '#FF4500');
    svg.appendChild(this.dot);

    // Label
    this.label = document.createElementNS(this.svgNS, 'text');
    this.label.setAttribute('id', '__cu_label');
    this.label.setAttribute('x', '-100');
    this.label.setAttribute('y', '-100');
    this.label.setAttribute('dy', '26');
    this.label.setAttribute('text-anchor', 'middle');
    this.label.setAttribute('fill', '#FF4500');
    this.label.setAttribute('font-size', '11');
    this.label.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
    this.label.setAttribute('font-weight', '600');
    this.label.setAttribute('opacity', '0');
    svg.appendChild(this.label);

    document.documentElement.appendChild(svg);
    this._injectStyles();
  }

  _circle(id, r, stroke, sw, opacity) {
    const c = document.createElementNS(this.svgNS, 'circle');
    c.setAttribute('id', id);
    c.setAttribute('r', String(r));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', stroke);
    c.setAttribute('stroke-width', String(sw));
    c.setAttribute('opacity', String(opacity));
    c.setAttribute('cx', '-100');
    c.setAttribute('cy', '-100');
    return c;
  }

  _injectStyles() {
    if (document.getElementById('__cu_styles')) return;
    const style = document.createElement('style');
    style.id = '__cu_styles';
    style.textContent = `
      #__cu_overlay #__cu_ring,
      #__cu_overlay #__cu_dot,
      #__cu_overlay #__cu_pulse {
        transition: cx 0.35s cubic-bezier(0.25,0.46,0.45,0.94),
                    cy 0.35s cubic-bezier(0.25,0.46,0.45,0.94);
      }
      #__cu_overlay #__cu_label {
        transition: x 0.35s cubic-bezier(0.25,0.46,0.45,0.94),
                    y 0.35s cubic-bezier(0.25,0.46,0.45,0.94),
                    opacity 0.2s ease;
      }
      @keyframes __cu_pulse_anim {
        0% { r: 12; opacity: 0.6; }
        50% { r: 24; opacity: 0.15; }
        100% { r: 12; opacity: 0.6; }
      }
      @keyframes __cu_click_flash {
        0% { r: 4; opacity: 1; }
        100% { r: 18; opacity: 0; }
      }
      .__cu_state-idle #__cu_pulse { animation: __cu_pulse_anim 2s ease-in-out infinite; }
      .__cu_state-hovering #__cu_ring { r: 16; }
      .__cu_state-about-to-click #__cu_pulse { animation: __cu_pulse_anim 0.5s ease-in-out infinite; }
      .__cu_state-about-to-click #__cu_ring { r: 18; stroke: #FF0000; }
      .__cu_state-clicking #__cu_dot { animation: __cu_click_flash 0.35s ease-out; }
      .__cu_state-clicking #__cu_ring { r: 20; stroke: #FF0000; }
    `;
    document.head.appendChild(style);
  }

  moveTo(x, y, state = 'hovering', label = '') {
    this.currentX = x;
    this.currentY = y;
    this.state = state;

    const overlay = document.getElementById('__cu_overlay');
    if (overlay) {
      overlay.setAttribute('class', `__cu_state-${state}`);
    }

    requestAnimationFrame(() => {
      [this.ring, this.dot, this.pulse].forEach((el) => {
        if (el) { el.setAttribute('cx', String(x)); el.setAttribute('cy', String(y)); }
      });
      if (this.label) {
        this.label.setAttribute('x', String(x));
        this.label.setAttribute('y', String(y));
        this.label.textContent = label;
        this.label.setAttribute('opacity', label ? '1' : '0');
      }
    });

    return new Promise(resolve => setTimeout(resolve, this.animationMs));
  }

  getPosition() {
    return { x: this.currentX, y: this.currentY };
  }

  hide() {
    this.moveTo(-100, -100, 'idle');
  }

  show() {
    // Will show at last position on next moveTo
  }

  destroy() {
    const overlay = document.getElementById('__cu_overlay');
    if (overlay) overlay.remove();
    const styles = document.getElementById('__cu_styles');
    if (styles) styles.remove();
  }
}

// Singleton
window.__cuCursor = new VirtualCursor();
