const SoundSystem = {
    audioContext: null,
    isInitializing: false, // Prevent re-entrant initialization

    // ------------------------------------------------------------------
    // Sound design (Kapoker)
    // ------------------------------------------------------------------
    // Philosophy: sounds sit UNDER the experience, never on top. One warm
    // timbre (sine/triangle), one key (C-major pentatonic), everything
    // routed through a low master bus (~ -12 dB). Every voice gets an
    // exponential attack/release so there are no note-on clicks, plus a
    // little random detune + velocity so repeats never feel robotic.
    // Frequent cues (chip / click) stay tiny, short and low-mid; rare
    // milestones (payout / kaching) can breathe a little more.
    // ------------------------------------------------------------------

    master: null,        // shared output bus
    enabled: true,       // simple on/off; honoured by the bus
    masterVolume: 1.0,   // 0..1 user volume; honoured by the bus
    _peak: 0.25,         // master ceiling (~ -12 dB). Final output never exceeds this.

    // Warm C-major pentatonic palette (Hz). All cues draw notes from here
    // so everything sounds like it belongs to the same instrument.
    _scale: {
        C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.00, A4: 440.00,
        C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.00
    },

    async init() {
        if (this.audioContext || this.isInitializing) return;
        this.isInitializing = true;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // Resume if suspended, often needed on first user gesture
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            console.log('[SOUND] Audio context initialized, state:', this.audioContext.state);
        } catch (error) {
            console.error('[SOUND] WebAudio API not supported or init failed:', error);
            this.audioContext = null; // Ensure it's null on failure
        } finally {
            this.isInitializing = false;
        }
    },

    async _ensureAudioContextRunning() {
        if (!this.audioContext && !this.isInitializing) {
            await this.init(); // Initialize if not already, and not currently trying
        }
        if (!this.audioContext) {
            console.warn("[SOUND] AudioContext could not be initialized.");
            return false;
        }

        if (this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
                console.log("[SOUND] AudioContext resumed on demand. New state:", this.audioContext.state);
            } catch (e) {
                console.error("[SOUND] Error resuming AudioContext on demand:", e);
                return false; // Can't play sound if resume fails
            }
        }
        return this.audioContext.state === 'running';
    },

    _rand(min, max) {
        return min + Math.random() * (max - min);
    },

    // Lazily build (and reuse) the master bus. Its gain is the ONLY place
    // the overall level is set, so nothing can get loud by accident.
    _bus() {
        if (!this.audioContext) return null;
        if (!this.master || this.master.context !== this.audioContext) {
            this.master = this.audioContext.createGain();
            this.master.connect(this.audioContext.destination);
        }
        this.master.gain.value = this.enabled ? this._peak * this.masterVolume : 0;
        return this.master;
    },

    // One warm, click-free voice.
    //   - exponential attack from silence (no 0ms note-on click)
    //   - exponential release (natural tail)
    //   - subtle per-hit detune + velocity so repeats aren't robotic
    //   - optional gentle low-pass to round off any harmonic edge
    _note(freq, opts = {}) {
        const ctx = this.audioContext;
        if (!ctx) return;

        const {
            delay = 0,
            dur = 0.12,
            type = 'sine',
            peak = 0.5,        // pre-master; final = peak * _peak * masterVolume
            attack = 0.01,     // 5-15ms keeps it soft but present
            detune = null,     // null => small random detune
            glideTo = null,    // optional pitch glide
            cutoff = null      // optional low-pass corner (Hz)
        } = opts;

        const bus = this._bus();
        const t = ctx.currentTime + delay;

        const osc = ctx.createOscillator();
        const g = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
        osc.detune.setValueAtTime(detune === null ? this._rand(-6, 6) : detune, t);

        if (cutoff) {
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(cutoff, t);
            osc.connect(lp);
            lp.connect(g);
        } else {
            osc.connect(g);
        }
        g.connect(bus);

        const v = Math.max(0.0002, peak * this._rand(0.9, 1.1)); // +/-10% velocity
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        osc.start(t);
        osc.stop(t + dur + 0.03);
    },

    // Chip edit — fires on EVERY chip update, so it is deliberately kept
    // near-silent: a single soft, short, low-mid blip. Just enough tactile
    // confirmation to register, quiet enough to never fatigue.
    async playChipSound() {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        const notes = [s.E4, s.G4, s.A4];
        const f = notes[Math.floor(Math.random() * notes.length)];
        this._note(f, { dur: 0.06, peak: 0.25, attack: 0.006, type: 'sine', cutoff: 1600 });
    },

    // New player joins — a gentle rising two-note motif. `frequency` is
    // retained for API compatibility (old signature) but the pitch now
    // comes from the shared palette so it matches every other cue.
    async playPopSound(frequency = 1000) {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        this._note(s.G4, { dur: 0.12, peak: 0.50, attack: 0.008, type: 'sine', cutoff: 2200 });
        this._note(s.C5, { delay: 0.075, dur: 0.16, peak: 0.45, attack: 0.010, type: 'sine', cutoff: 2600 });
    },

    // UI click (theme switch / reopen game) — short, soft, rounded.
    // No pitch-sweep "tick"; this can repeat as the user browses themes.
    async playUIClickSound() {
        if (!await this._ensureAudioContextRunning()) return;
        this._note(this._scale.A4, { dur: 0.045, peak: 0.35, attack: 0.005, type: 'triangle', cutoff: 1800 });
    },

    // Lobby created / calculate pressed — a warm ascending three-note
    // chime with a soft octave shimmer on top. Replaces the old harsh
    // square + sawtooth "cash register" metallic clang.
    async playKachingSound() {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        [[s.C4, 0], [s.E4, 0.07], [s.G4, 0.14]].forEach(([f, d]) =>
            this._note(f, { delay: d, dur: 0.28, peak: 0.60, attack: 0.010, type: 'sine', cutoff: 2600 }));
        this._note(s.C5, { delay: 0.14, dur: 0.5, peak: 0.28, attack: 0.020, type: 'sine', cutoff: 3000 });
    },

    // Reset game — a gentle descending motif that reads as "clearing".
    // Replaces the old filtered-noise thump + sawtooth-ish sweeps.
    async playResetSound() {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        [[s.G4, 0], [s.E4, 0.08], [s.C4, 0.16]].forEach(([f, d]) =>
            this._note(f, { delay: d, dur: 0.30, peak: 0.55, attack: 0.012, type: 'triangle', cutoff: 1800 }));
    },

    // Payout reveal — the once-a-night celebration, so it is allowed the
    // most expression: a warm ascending pentatonic arpeggio with a soft
    // bell shimmer that lingers. Still peaks under the master ceiling.
    async playPayoutSound() {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        [[s.C4, 0], [s.E4, 0.09], [s.G4, 0.18], [s.A4, 0.27], [s.C5, 0.36]].forEach(([f, d]) =>
            this._note(f, { delay: d, dur: 0.40, peak: 0.75, attack: 0.012, type: 'sine', cutoff: 3000 }));
        // Shimmering bell partials on top, soft and lingering.
        this._note(s.E5, { delay: 0.36, dur: 0.9, peak: 0.34, attack: 0.030, type: 'sine', cutoff: 3500 });
        this._note(s.G5, { delay: 0.42, dur: 0.8, peak: 0.22, attack: 0.030, type: 'sine', cutoff: 3500 });
    },

    // Remove player — a soft descending two-note "away" gesture. Replaces
    // the old noise puff + 300->70Hz buzz drop.
    async playRemoveSound() {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        this._note(s.A4, { dur: 0.14, peak: 0.50, attack: 0.008, type: 'triangle', cutoff: 1600 });
        this._note(s.E4, { delay: 0.08, dur: 0.22, peak: 0.45, attack: 0.010, type: 'triangle', cutoff: 1400 });
    },

    // Payouts finalized ("Payouts Sent") — a rare confirming rising motif.
    // The call site in app.js has always been guarded by a typeof check but
    // this method never existed, so it was silent; now it's implemented as a
    // gentle success chime (additive, no existing call site changes).
    async playSuccessSound() {
        if (!await this._ensureAudioContextRunning()) return;
        const s = this._scale;
        [[s.C4, 0], [s.G4, 0.08], [s.C5, 0.16]].forEach(([f, d]) =>
            this._note(f, { delay: d, dur: 0.32, peak: 0.60, attack: 0.012, type: 'sine', cutoff: 2800 }));
    }
};

window.SoundSystem = SoundSystem;
