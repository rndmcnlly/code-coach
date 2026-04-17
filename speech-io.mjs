// =========================================================================
// <speech-io> : Browser TTS + push-to-talk STT
//
// Attributes: tts-mode ("off" | "browser")
// Methods:
//   speak(text)
// Listens: "speak" on document (detail: { text })
// Events dispatched on document:
//   "transcript"           – detail: { text } (from STT)
// =========================================================================
class SpeechIO extends HTMLElement {
  #ttsMode = "off";
  #ttsVoice = null;
  #recognition = null;
  #listening = false;
  #captionsEnabled = true;
  #captionOverlay = null;

  connectedCallback() {
    // Voice always starts off each session. Turning it on is the user
    // gesture that unlocks speechSynthesis in the browser.
    this.#ttsMode = "off";
    this.#captionsEnabled = localStorage.getItem("CODE_COACH_CAPTIONS") !== "false";
    this.#captionOverlay = document.getElementById("caption-overlay");

    // TTS mode selector
    const ttsSelect = document.getElementById("tts-select");
    ttsSelect.value = "off";
    ttsSelect.addEventListener("change", () => {
      this.#ttsMode = ttsSelect.value;
      if (this.#ttsMode === "browser") {
        // Runs inside a trusted user gesture (the select change event),
        // which unlocks speechSynthesis for all future async calls.
        const test = new SpeechSynthesisUtterance("Voice on.");
        const voice = this.#pickVoice();
        if (voice) test.voice = voice;
        test.rate = 1.05;
        speechSynthesis.speak(test);
      } else {
        speechSynthesis.cancel();
      }
    });

    // Captions toggle
    const captionsBtn = document.getElementById("captions-btn");
    this.#updateCaptionsBtn(captionsBtn);
    captionsBtn.addEventListener("click", () => {
      this.#captionsEnabled = !this.#captionsEnabled;
      localStorage.setItem("CODE_COACH_CAPTIONS", this.#captionsEnabled);
      this.#updateCaptionsBtn(captionsBtn);
      if (!this.#captionsEnabled) this.#captionOverlay.classList.remove("visible");
    });

    // Voice selection
    speechSynthesis.addEventListener("voiceschanged", () => this.#pickVoice());

    // Listen for speak events
    document.addEventListener("speak", (e) => this.speak(e.detail.text));

    // Init STT
    this.#initSTT();
  }

  speak(text) {
    if (this.#captionsEnabled) {
      this.#captionOverlay.textContent = text;
      this.#captionOverlay.classList.add("visible");
      const readTime = Math.max(3000, text.length * 50);
      setTimeout(() => this.#captionOverlay.classList.remove("visible"), readTime);
    }
    if (this.#ttsMode === "browser") this.#browserTTS(text);
  }

  #browserTTS(text) {
    const speaking = speechSynthesis.speaking || speechSynthesis.pending;
    if (speaking) {
      speechSynthesis.cancel();
      // Defer so Chrome finishes processing the cancel before we queue.
      setTimeout(() => this.#speakUtterance(text), 100);
    } else {
      this.#speakUtterance(text);
    }
  }

  #speakUtterance(text) {
    const utter = new SpeechSynthesisUtterance(text);
    const voice = this.#pickVoice();
    if (voice) utter.voice = voice;
    utter.rate = 1.05;
    utter.pitch = 1.0;
    utter.onerror = (e) => console.warn("[TTS] error:", e.error);
    speechSynthesis.speak(utter);
  }

  #pickVoice() {
    if (this.#ttsVoice) return this.#ttsVoice;
    const voices = speechSynthesis.getVoices();
    this.#ttsVoice =
      voices.find(v => v.name.includes("Samantha")) ||
      voices.find(v => v.lang.startsWith("en") && v.name.includes("Natural")) ||
      voices.find(v => v.lang.startsWith("en-US")) ||
      voices.find(v => v.lang.startsWith("en")) ||
      voices[0];
    return this.#ttsVoice;
  }

  #updateCaptionsBtn(btn) {
    btn.textContent = `Captions: ${this.#captionsEnabled ? "On" : "Off"}`;
    btn.classList.toggle("active", this.#captionsEnabled);
  }

  #initSTT() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = document.getElementById("mic-btn");
    const userInput = document.getElementById("user-input");

    if (!SpeechRecognition) {
      micBtn.title = "Speech recognition not supported in this browser";
      micBtn.disabled = true;
      return;
    }

    this.#recognition = new SpeechRecognition();
    this.#recognition.continuous = false;
    this.#recognition.interimResults = false;
    this.#recognition.lang = "en-US";

    this.#recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      document.dispatchEvent(new CustomEvent("transcript", { detail: { text: transcript } }));
    };

    this.#recognition.onend = () => { this.#listening = false; micBtn.classList.remove("listening"); };
    this.#recognition.onerror = () => { this.#listening = false; micBtn.classList.remove("listening"); };

    micBtn.addEventListener("click", () => this.#toggleMic(micBtn));


  }

  #toggleMic(btn) { if (this.#listening) this.#stopMic(btn); else this.#startMic(btn); }

  #startMic(btn) {
    if (!this.#recognition || this.#listening) return;
    speechSynthesis.cancel();
    this.#listening = true;
    btn.classList.add("listening");
    this.#recognition.start();
  }

  #stopMic(btn) {
    if (!this.#recognition || !this.#listening) return;
    this.#recognition.stop();
  }
}
customElements.define("speech-io", SpeechIO);
