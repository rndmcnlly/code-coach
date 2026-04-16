// =========================================================================
// <sfx-engine> : WebAudio synth feedback sounds
//
// Listens: "sfx-play" on document (detail: { sound: "add"|"complete" })
// Attribute: enabled (boolean, toggles via sfx-btn)
// =========================================================================
class SfxEngine extends HTMLElement {
  #ctx = null;
  #enabled = true;

  connectedCallback() {
    this.#enabled = localStorage.getItem("CODE_COACH_SFX") !== "false";
    const btn = document.getElementById("sfx-btn");
    this.#updateBtn(btn);
    btn.addEventListener("click", () => {
      this.#enabled = !this.#enabled;
      localStorage.setItem("CODE_COACH_SFX", this.#enabled);
      this.#updateBtn(btn);
    });
    document.addEventListener("sfx-play", (e) => this.#play(e.detail.sound));
  }

  #updateBtn(btn) {
    btn.textContent = `SFX: ${this.#enabled ? "On" : "Off"}`;
    btn.classList.toggle("active", this.#enabled);
  }

  #getCtx() {
    if (!this.#ctx) this.#ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.#ctx;
  }

  // Expose for components that need raw AudioContext (e.g. TTS playback)
  get audioContext() { return this.#getCtx(); }

  #play(sound) {
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
customElements.define("sfx-engine", SfxEngine);
