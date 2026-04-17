// =========================================================================
// SfxEngine : WebAudio synth feedback sounds
//
// Plain class. Constructed by boot, called directly.
//
// Constructor: new SfxEngine()
// Methods:
//   play(sound)         – "add" | "complete"
//   get audioContext     – raw AudioContext for other uses (e.g. TTS playback)
//   get enabled / set enabled
// =========================================================================

export class SfxEngine {
  #ctx = null;
  #enabled;

  constructor() {
    this.#enabled = localStorage.getItem("CODE_COACH_SFX") !== "false";
  }

  get enabled() { return this.#enabled; }
  set enabled(v) {
    this.#enabled = v;
    localStorage.setItem("CODE_COACH_SFX", v);
  }

  get audioContext() { return this.#getCtx(); }

  #getCtx() {
    if (!this.#ctx) this.#ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.#ctx;
  }

  play(sound) {
    if (!this.#enabled) return;
    if (sound === "add") this.#playAdd();
    else if (sound === "complete") this.#playComplete();
  }

  #playAdd() {
    const ctx = this.#getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  }

  #playComplete() {
    const ctx = this.#getCtx();
    [0, 0.1].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(i === 0 ? 660 : 990, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.25);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.25);
    });
  }
}

// =========================================================================
// ParticleFx : Canvas overlay particle system
//
// Plain class. Constructed with a canvas element reference.
//
// Constructor: new ParticleFx(canvasElement)
// Methods:
//   spawn(x, y, count?)
// =========================================================================

export class ParticleFx {
  #canvas;
  #ctx;
  #particles = [];
  #animId = null;

  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d");
    this.#resize();
    window.addEventListener("resize", () => this.#resize());
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
