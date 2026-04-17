// =========================================================================
// Effects : Sound (jsfxr) and particles (canvas-confetti)
//
// Thin wrappers around CDN globals: window.sfxr, window.confetti.
// Both scripts must be loaded before this module runs.
//
// Exports:
//   SfxEngine  – play("add") / play("complete"), enabled toggle
//   particles  – spawn(x, y, count?) using canvas-confetti
// =========================================================================

// ---- SFX via jsfxr ----

// Deterministic sound definitions (sfxr parameter objects).
// Generated from blipSelect/powerUp presets, validated to produce audio,
// then frozen as JSON. sfxr.play() on a fixed object is deterministic.
const SOUNDS = {
  add: {
    oldParams: true, wave_type: 1,
    p_env_attack: 0, p_env_sustain: 0.08786237127836559,
    p_env_punch: 0.38391008620163014, p_env_decay: 0.24247658277452136,
    p_base_freq: 0.4127722393536667, p_freq_limit: 0,
    p_freq_ramp: 0, p_freq_dramp: 0,
    p_vib_strength: 0, p_vib_speed: 0,
    p_arp_mod: 0.4358939612721729, p_arp_speed: 0.6266209140742006,
    p_duty: 0, p_duty_ramp: 0,
    p_repeat_speed: 0, p_pha_offset: 0, p_pha_ramp: 0,
    p_lpf_freq: 1, p_lpf_ramp: 0, p_lpf_resonance: 0,
    p_hpf_freq: 0, p_hpf_ramp: 0,
    sound_vol: 0.25, sample_rate: 44100, sample_size: 8,
  },
  complete: {
    oldParams: true, wave_type: 1,
    p_env_attack: 0, p_env_sustain: 0.0681742970582556,
    p_env_punch: 0.42243409924120046, p_env_decay: 0.44252358061411645,
    p_base_freq: 0.8731305186150191, p_freq_limit: 0,
    p_freq_ramp: 0, p_freq_dramp: 0,
    p_vib_strength: 0, p_vib_speed: 0,
    p_arp_mod: 0.25813930015844255, p_arp_speed: 0.6078401963589114,
    p_duty: 0, p_duty_ramp: 0,
    p_repeat_speed: 0, p_pha_offset: 0, p_pha_ramp: 0,
    p_lpf_freq: 1, p_lpf_ramp: 0, p_lpf_resonance: 0,
    p_hpf_freq: 0, p_hpf_ramp: 0,
    sound_vol: 0.25, sample_rate: 44100, sample_size: 8,
  },
};

export class SfxEngine {
  #enabled;

  constructor() {
    this.#enabled = localStorage.getItem("CODE_COACH_SFX") !== "false";
  }

  get enabled() { return this.#enabled; }
  set enabled(v) {
    this.#enabled = v;
    localStorage.setItem("CODE_COACH_SFX", v);
  }

  play(sound) {
    if (!this.#enabled) return;
    const def = SOUNDS[sound];
    if (def) sfxr.play(def);
  }
}

// ---- Particles via canvas-confetti ----

/**
 * Spawn a small burst of confetti at pixel coordinates.
 * canvas-confetti uses 0–1 normalized origin, so we convert.
 */
export function spawnParticles(x, y, count = 12) {
  confetti({
    particleCount: count,
    startVelocity: 15,
    spread: 360,
    gravity: 0.6,
    ticks: 60,
    scalar: 0.6,
    origin: {
      x: x / window.innerWidth,
      y: y / window.innerHeight,
    },
    colors: ["#569cd6", "#6a9955", "#ce9178"],
    disableForReducedMotion: true,
  });
}
