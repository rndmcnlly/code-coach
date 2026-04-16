// =========================================================================
// <particle-fx> : Canvas overlay particle system
//
// Listens: "particles-spawn" on document (detail: { x, y, count? })
// Uses the #particle-canvas element in the DOM.
// =========================================================================
class ParticleFx extends HTMLElement {
  #canvas = null;
  #ctx = null;
  #particles = [];
  #animId = null;

  connectedCallback() {
    this.#canvas = document.getElementById("particle-canvas");
    this.#ctx = this.#canvas.getContext("2d");
    this.#resize();
    window.addEventListener("resize", () => this.#resize());
    document.addEventListener("particles-spawn", (e) => {
      this.spawn(e.detail.x, e.detail.y, e.detail.count || 12);
    });
  }

  #resize() {
    this.#canvas.width = window.innerWidth;
    this.#canvas.height = window.innerHeight;
  }

  spawn(x, y, count = 12) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 40 + Math.random() * 60;
      const size = 2 + Math.random() * 3;
      const hue = 210 + Math.random() * 30;
      this.#particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 20,
        size, life: 1.0,
        decay: 0.02 + Math.random() * 0.02,
        color: `hsla(${hue}, 70%, 65%,`,
      });
    }
    if (!this.#animId) this.#tick();
  }

  #tick() {
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    for (let i = this.#particles.length - 1; i >= 0; i--) {
      const p = this.#particles[i];
      p.x += p.vx * 0.016;
      p.y += p.vy * 0.016;
      p.vy += 80 * 0.016;
      p.life -= p.decay;
      if (p.life <= 0) { this.#particles.splice(i, 1); continue; }
      this.#ctx.beginPath();
      this.#ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      this.#ctx.fillStyle = p.color + p.life + ")";
      this.#ctx.fill();
    }
    if (this.#particles.length > 0) {
      this.#animId = requestAnimationFrame(() => this.#tick());
    } else {
      this.#animId = null;
    }
  }
}
customElements.define("particle-fx", ParticleFx);
