import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * QWERTY Piano — single-file React component
 * - Maps your computer keyboard to musical notes
 * - Synth engine via Web Audio API (polyphonic, ADSR, gentle low-pass)
 * - Mouse/touch playable keys
 * - Sustain, octave +/- , volume, waveform, record & playback
 *
 * Default mapping (starting at C4 on the 'A' key):
 * Row 1:  A  W  S  E  D  F  T  G  Y  H  U  J  K  O  L  P  ;  '
 * Notes:  C C# D D# E  F F# G G# A A# B  C  C# D D# E  F
 */

const WHITE_KEYS = ["A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'"]; // C D E F G A B C D E F
const BLACK_KEYS = ["W", "E", "T", "Y", "U", "O", "P"]; // C# D# F# G# A# C# D#

// Semitone offsets from C for the visual+key mapping (A -> C4)
const KEY_TO_OFFSET: Record<string, number> = {
  A: 0,
  W: 1,
  S: 2,
  E: 3,
  D: 4,
  F: 5,
  T: 6,
  G: 7,
  Y: 8,
  H: 9,
  U: 10,
  J: 11,
  K: 12,
  O: 13,
  L: 14,
  P: 15,
  ";": 16,
  "'": 17,
};

// Utility: MIDI -> frequency (A4=440Hz, MIDI 69)
const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

// Build a note name for display (optional nicety)
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const midiToName = (midi: number) => {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
};

// Simple poly synth voice using Web Audio
class Voice {
  ctx: AudioContext;
  gain: GainNode;
  filter: BiquadFilterNode;
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  ended = false;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    freq: number,
    waveform: OscillatorType,
    volume: number,
  ) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 1800; // soften brightness
    this.filter.Q.value = 0.8;

    this.osc1 = ctx.createOscillator();
    this.osc2 = ctx.createOscillator();
    this.osc1.type = waveform;
    this.osc2.type = waveform === "sine" ? "triangle" : waveform;
    this.osc1.frequency.setValueAtTime(freq, ctx.currentTime);
    this.osc2.frequency.setValueAtTime(freq, ctx.currentTime);
    // Subtle detune for richness
    this.osc1.detune.value = -4;
    this.osc2.detune.value = +4;

    // Envelope
    const now = ctx.currentTime;
    const attack = 0.01;
    const decay = 0.22;
    const sustain = 0.22;

    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(volume, now + attack);
    this.gain.gain.linearRampToValueAtTime(volume * sustain, now + attack + decay);

    // Wiring
    this.osc1.connect(this.filter);
    this.osc2.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(destination);

    this.osc1.start();
    this.osc2.start();
  }

  release(time = 0.35) {
    if (this.ended) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0.0001, now + time);
    setTimeout(() => this.stop(), time * 1000 + 20);
  }

  stop() {
    if (this.ended) return;
    this.ended = true;
    try {
      this.osc1.stop();
      this.osc2.stop();
    } catch {}
    this.gain.disconnect();
    this.filter.disconnect();
  }
}

export default function QwertyPiano() {
  const [octave, setOctave] = useState(4); // C4 on 'A'
  const [sustain, setSustain] = useState(false);
  const [volume, setVolume] = useState(0.35);
  const [waveform, setWaveform] = useState<OscillatorType>("sine");
  const [armed, setArmed] = useState(false); // audio context unlocked

  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const activeVoices = useRef<Map<string, Voice>>(new Map()); // key -> voice

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<{ key: string; type: "down" | "up"; t: number }[]>([]);
  const recordStartRef = useRef<number | null>(null);

  // Build visual keybed (white + black overlay)
  const keybed = useMemo(() => {
    const keys: { key: string; offset: number; sharp: boolean }[] = [];
    const add = (k: string, sharp = false) => keys.push({ key: k, offset: KEY_TO_OFFSET[k], sharp });
    WHITE_KEYS.forEach((k) => add(k, false));
    BLACK_KEYS.forEach((k) => add(k, true));
    return keys.sort((a, b) => a.offset - b.offset + (a.sharp === b.sharp ? 0 : a.sharp ? 0.5 : -0.5));
  }, []);

  const ensureAudio = () => {
    if (!ctxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      ctxRef.current = ctx;
      masterRef.current = ctx.createGain();
      masterRef.current.gain.value = 0.9;
      masterRef.current.connect(ctx.destination);
      setArmed(true);
    }
    return ctxRef.current!;
  };

  const keyToMidi = (key: string) => {
    const offset = KEY_TO_OFFSET[key.toUpperCase()];
    if (offset === undefined) return null;
    // Base at C[octave]
    const baseMidi = 12 * (octave + 1); // MIDI for C(octave)
    return baseMidi + offset;
  };

  const startNote = (key: string) => {
    const k = key.toUpperCase();
    if (activeVoices.current.has(k)) return; // already sounding
    const midi = keyToMidi(k);
    if (midi == null) return;
    const ctx = ensureAudio();
    const freq = midiToFreq(midi);

    const voice = new Voice(ctx, masterRef.current!, freq, waveform, volume);
    activeVoices.current.set(k, voice);
    highlightKey(k, true);
  };

  const stopNote = (key: string) => {
    const k = key.toUpperCase();
    const voice = activeVoices.current.get(k);
    if (!voice) return;
    if (sustain) {
      // defer stop until sustain released
      return;
    }
    voice.release();
    activeVoices.current.delete(k);
    highlightKey(k, false);
  };

  const allNotesOff = () => {
    activeVoices.current.forEach((v) => v.release());
    activeVoices.current.clear();
    clearAllHighlights();
  };

  // Visual key highlight management
  const downSet = useRef<Set<string>>(new Set());
  const highlightKey = (k: string, down: boolean) => {
    if (down) downSet.current.add(k);
    else downSet.current.delete(k);
    // Trigger re-render via dummy state? We'll rely on key components using downSet via ref.
    setRenderTick((x) => x + 1);
  };
  const clearAllHighlights = () => {
    downSet.current.clear();
    setRenderTick((x) => x + 1);
  };
  const [renderTick, setRenderTick] = useState(0);

  // Keyboard handlers
  useEffect(() => {
    const handleDown = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      if (k === " ") {
        // space toggles sustain
        setSustain((s) => !s);
        return;
      }
      if (k === "]") setOctave((o) => Math.min(8, o + 1));
      if (k === "[") setOctave((o) => Math.max(1, o - 1));

      if (KEY_TO_OFFSET[k] !== undefined) {
        e.preventDefault();
        startNote(k);
        if (isRecording) pushRecord(k, "down");
      }
    };
    const handleUp = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      if (KEY_TO_OFFSET[k] !== undefined) {
        e.preventDefault();
        if (isRecording) pushRecord(k, "up");
        stopNote(k);
      }
    };
    window.addEventListener("keydown", handleDown);
    window.addEventListener("keyup", handleUp);
    return () => {
      window.removeEventListener("keydown", handleDown);
      window.removeEventListener("keyup", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, waveform, volume, sustain, octave]);

  // Recording helpers
  const pushRecord = (key: string, type: "down" | "up") => {
    const t0 = recordStartRef.current ?? (recordStartRef.current = performance.now());
    const t = performance.now() - t0;
    setRecording((r) => [...r, { key: key.toUpperCase(), type, t }]);
  };

  const startRecording = () => {
    setRecording([]);
    recordStartRef.current = null;
    setIsRecording(true);
  };

  const stopRecording = () => setIsRecording(false);

  const playRecording = async () => {
    if (!recording.length) return;
    const start = performance.now();
    const sched = () => {
      const now = performance.now() - start;
      recording.forEach((ev) => {
        if (!ev.__scheduled) (ev as any).__scheduled = false;
      });
      recording.forEach((ev) => {
        const evAny = ev as any;
        if (!evAny.__scheduled && ev.t <= now + 5) {
          evAny.__scheduled = true;
          if (ev.type === "down") startNote(ev.key);
          else stopNote(ev.key);
        }
      });
      if ((recording as any).some((ev: any) => !ev.__scheduled)) requestAnimationFrame(sched);
    };
    sched();
  };

  const stopAll = () => {
    allNotesOff();
  };

  // Touch/mouse play
  const handleClickKey = (k: string) => {
    startNote(k);
    setTimeout(() => stopNote(k), sustain ? 400 : 240); // quick tap
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try { allNotesOff(); } catch {}
      try { ctxRef.current?.close(); } catch {}
    };
  }, []);

  const currentBaseMidi = 12 * (octave + 1); // C[octave]

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 flex flex-col items-center p-6 gap-6">
      <header className="w-full max-w-5xl">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">QWERTY Piano</h1>
        <p className="text-neutral-400 mt-1">Type to play. 'A' starts at C{octave}. Use [ / ] to change octave, Space for sustain.</p>
      </header>

      <section className="w-full max-w-5xl grid gap-4 md:grid-cols-2">
        {/* Controls */}
        <div className="bg-neutral-900/60 rounded-2xl p-4 shadow-lg border border-neutral-800">
          <div className="flex flex-wrap gap-3 items-center">
            <button
              className={`px-3 py-2 rounded-xl border border-neutral-700 shadow ${armed ? "bg-emerald-600/20" : "bg-neutral-800"}`}
              onClick={ensureAudio}
            >
              {armed ? "Audio Ready" : "Enable Audio"}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-400">Octave</span>
              <button className="px-2 py-1 rounded-lg border border-neutral-700" onClick={() => setOctave((o) => Math.max(1, o - 1))}>–</button>
              <span className="px-2 tabular-nums">{octave}</span>
              <button className="px-2 py-1 rounded-lg border border-neutral-700" onClick={() => setOctave((o) => Math.min(8, o + 1))}>+</button>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-neutral-400">Volume</label>
              <input
                type="range" min={0} max={1} step={0.01}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-neutral-400">Wave</label>
              <select
                className="bg-neutral-800 border border-neutral-700 rounded-lg px-2 py-1"
                value={waveform}
                onChange={(e) => setWaveform(e.target.value as OscillatorType)}
              >
                <option value="sine">Sine (soft)</option>
                <option value="triangle">Triangle</option>
                <option value="square">Square</option>
                <option value="sawtooth">Saw</option>
              </select>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={sustain} onChange={(e) => setSustain(e.target.checked)} />
              <span className="text-sm">Sustain (Space)</span>
            </label>
          </div>

          <div className="mt-4 flex items-center gap-2">
            {!isRecording ? (
              <button className="px-3 py-2 rounded-xl border border-neutral-700 bg-red-600/20" onClick={startRecording}>● Record</button>
            ) : (
              <button className="px-3 py-2 rounded-xl border border-neutral-700 bg-yellow-600/20" onClick={stopRecording}>■ Stop</button>
            )}
            <button className="px-3 py-2 rounded-xl border border-neutral-700" onClick={playRecording} disabled={!recording.length}>▶ Play</button>
            <button className="px-3 py-2 rounded-xl border border-neutral-700" onClick={stopAll}>⏹ All Notes Off</button>
          </div>

          <div className="mt-3 text-sm text-neutral-400">
            <p>
              Mapping: <span className="font-mono">A W S E D F T G Y H U J K O L P ; '</span>
            </p>
            <p>Hold keys for longer notes. Click keys with the mouse to play too.</p>
          </div>
        </div>

        {/* Note inspector */}
        <div className="bg-neutral-900/60 rounded-2xl p-4 shadow-lg border border-neutral-800">
          <h3 className="font-medium mb-2">Key Reference</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {Object.entries(KEY_TO_OFFSET).sort((a, b) => a[1] - b[1]).map(([k, off]) => {
              const midi = currentBaseMidi + off;
              return (
                <div key={k} className="flex items-center justify-between bg-neutral-800/70 rounded-xl px-3 py-2">
                  <span className="font-mono text-neutral-300">{k}</span>
                  <span className="text-neutral-400">{midiToName(midi)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Keyboard */}
      <section className="w-full max-w-5xl">
        <div className="relative select-none">
          {/* White keys */}
          <div className="flex gap-1 p-3 bg-neutral-900/60 rounded-2xl border border-neutral-800 shadow-lg">
            {WHITE_KEYS.map((k, i) => {
              const isDown = downSet.current.has(k);
              const midi = currentBaseMidi + KEY_TO_OFFSET[k];
              const label = midiToName(midi);
              return (
                <motion.button
                  key={k}
                  onMouseDown={() => handleClickKey(k)}
                  onTouchStart={(e) => { e.preventDefault(); handleClickKey(k); }}
                  whileTap={{ y: 2 }}
                  className={`relative w-16 h-48 rounded-2xl border ${isDown ? "bg-neutral-300 text-neutral-900 border-neutral-300" : "bg-white text-neutral-900 border-neutral-200"} shadow`}
                >
                  <span className="absolute bottom-2 left-2 text-xs font-mono opacity-70">{k}</span>
                  <span className="absolute bottom-2 right-2 text-xs opacity-60">{label}</span>
                </motion.button>
              );
            })}
          </div>

          {/* Black keys overlay */}
          <div className="pointer-events-none absolute left-0 right-0 top-3 h-0">
            <div className="flex gap-1 ml-12 mr-24">
              {BLACK_KEYS.map((k, idx) => {
                // Position black keys above gaps between white keys: pattern [C#, D#, -, F#, G#, A# , -, -]
                const isDown = downSet.current.has(k);
                const midi = currentBaseMidi + KEY_TO_OFFSET[k];
                const label = midiToName(midi);

                // Rough spacing offsets per black key index to align over white keys
                const offsets = [0, 1, 3, 4, 5, 7, 8];
                const left = offsets[idx] * 4.25; // tweak

                return (
                  <motion.div
                    key={k}
                    className="pointer-events-auto"
                    style={{ position: "relative", left: `${left}rem` }}
                  >
                    <motion.button
                      onMouseDown={() => handleClickKey(k)}
                      onTouchStart={(e) => { e.preventDefault(); handleClickKey(k); }}
                      whileTap={{ y: 2 }}
                      className={`w-12 h-32 rounded-xl border ${isDown ? "bg-neutral-700 border-neutral-600" : "bg-neutral-900 border-neutral-800"} shadow-[0_6px_12px_rgba(0,0,0,0.6)]`}
                    >
                      <span className="absolute bottom-2 left-2 text-[10px] font-mono opacity-70 text-white">{k}</span>
                      <span className="absolute bottom-2 right-2 text-[10px] opacity-60 text-white">{label}</span>
                    </motion.button>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <footer className="text-xs text-neutral-500">
        Tips: If you hear nothing, click "Enable Audio" (required by browsers). Use [ / ] to change octaves.
      </footer>
    </div>
  );
}
