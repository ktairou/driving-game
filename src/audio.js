import { clamp } from "./noise.js";

// All sound is made on the fly with the Web Audio API, so there are no
// sound files to download. iPads only allow sound after the first tap,
// so `start()` is called from a touch.

function noiseBuffer(ctx, seconds, brown = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

// One full engine cycle (two crank turns) of an eight-cylinder engine at
// 1000 rpm: eight combustion pulses with slightly uneven spacing and
// strength, which gives the lumpy V8 burble. Played faster for higher revs.
function engineCycle(ctx) {
  const cycle = 0.12;
  const len = Math.floor(ctx.sampleRate * cycle);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const offsets = [0, 0.13, 0.245, 0.37, 0.5, 0.635, 0.745, 0.875];
  const strength = [1, 0.82, 0.93, 0.78, 0.97, 0.85, 0.9, 0.8];
  for (let k = 0; k < 8; k++) {
    const start = Math.floor(offsets[k] * len);
    for (let i = 0; i < len * 0.12; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 260) * strength[k];
      const thump = Math.sin(2 * Math.PI * 70 * t) * 0.9;
      const crack = (Math.random() * 2 - 1) * 0.55 * Math.exp(-t * 900);
      d[(start + i) % len] += (thump + crack) * env;
    }
  }
  return buf;
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ambience = { birds: 0, town: 0, sea: 0, rain: 0, wind: 0 };
    this._birdTimer = 0;
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state !== "running") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(comp).connect(ctx.destination);

    const white = noiseBuffer(ctx, 2);
    const brown = noiseBuffer(ctx, 3, true);
    const loop = (buffer, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start();
      return s;
    };
    const filter = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    // --- Engine: pulse loop + a growl on top ---------------------------------
    this.engineSrc = loop(engineCycle(ctx));
    this.engineTone = filter("lowpass", 900, 1.2);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 512 - 1) * 2.4;
      curve[i] = Math.tanh(x);
    }
    shaper.curve = curve;
    this.engineGain = gain(0);
    this.engineSrc.connect(this.engineTone).connect(shaper).connect(this.engineGain).connect(this.master);
    this.growl = ctx.createOscillator();
    this.growl.type = "sawtooth";
    this.growlFilter = filter("lowpass", 400, 2);
    this.growlGain = gain(0);
    this.growl.connect(this.growlFilter).connect(this.growlGain).connect(this.master);
    this.growl.start();

    // --- Car noises ---------------------------------------------------------------
    this.tyreGain = gain(0);
    loop(white).connect(filter("bandpass", 1500, 2.5)).connect(this.tyreGain).connect(this.master);
    this.roadGain = gain(0);
    loop(brown).connect(filter("lowpass", 260)).connect(this.roadGain).connect(this.master);
    this.windGain = gain(0);
    this.windFilter = filter("bandpass", 700, 0.6);
    loop(white, 0.7).connect(this.windFilter).connect(this.windGain).connect(this.master);

    // --- Background ---------------------------------------------------------------
    this.ambBreeze = gain(0);
    this.breezeFilter = filter("lowpass", 500);
    loop(brown, 0.6).connect(this.breezeFilter).connect(this.ambBreeze).connect(this.master);
    this.ambTown = gain(0);
    loop(brown, 0.4).connect(filter("bandpass", 180, 0.8)).connect(this.ambTown).connect(this.master);
    this.ambSea = gain(0);
    this.seaFilter = filter("lowpass", 700);
    loop(white, 0.5).connect(this.seaFilter).connect(this.ambSea).connect(this.master);
    this.ambRain = gain(0);
    loop(white).connect(filter("highpass", 900)).connect(filter("lowpass", 6500)).connect(this.ambRain).connect(this.master);
    this.white = white;
    this.brown = brown;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.1);
  }

  _set(param, value, time = 0.08) {
    param.setTargetAtTime(value, this.ctx.currentTime, time);
  }

  // Short one-off noise burst through a filter, e.g. crashes and splashes.
  _burst(type, freq, volume, decay, buffer = this.white) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(volume, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    s.connect(f).connect(g).connect(this.master);
    s.start(now, Math.random());
    s.stop(now + decay + 0.05);
  }

  crash(strength) {
    if (!this.ctx) return;
    this._burst("lowpass", 900, 0.9 * strength, 0.5);
    this._burst("bandpass", 2400, 0.35 * strength, 0.25);
  }

  splash() {
    if (!this.ctx) return;
    this._burst("lowpass", 1200, 1, 1.4);
  }

  thunder(distance) {
    if (!this.ctx) return;
    this._burst("lowpass", 160, clamp(1.4 - distance * 0.25, 0.4, 1.4), 3.5 + distance, this.brown);
  }

  // A little bird song: a few quick whistles that sweep in pitch.
  _chirp(volume) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2400 + Math.random() * 2200;
    for (let n = 0; n < notes; n++) {
      const t = now + n * (0.09 + Math.random() * 0.05);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.2), t);
      o.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(volume, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  // Called every frame. `car` is the vehicle (or null when walking).
  update(dt, { car, onFoot, inCabin, weather, place }) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const speed = car ? car.speed : 0;
    const driving = car && !onFoot;

    // Engine: louder and brighter with throttle; muffled from far away / on foot.
    const rpm = car ? car.rpm : 0;
    const load = car ? car.throttle : 0;
    const near = driving ? 1 : 0.25;
    this._set(this.engineSrc.playbackRate, Math.max(0.5, rpm / 1000), 0.05);
    this._set(this.engineTone.frequency, 500 + load * 2200 + rpm * 0.15);
    this._set(this.engineGain.gain, car ? (0.16 + load * 0.3) * near * (inCabin ? 0.8 : 1) : 0);
    this._set(this.growl.frequency, (rpm / 60) * 4, 0.05);
    this._set(this.growlFilter.frequency, 250 + load * 700);
    this._set(this.growlGain.gain, car ? (0.035 + load * 0.06) * near : 0);

    const slip = car ? clamp((car.slip - 0.1) * 4, 0, 1) : 0;
    this._set(this.tyreGain.gain, driving && car.grounded ? slip * 0.22 * clamp(speed / 8, 0, 1) : 0);
    this._set(this.roadGain.gain, driving && car.grounded ? clamp(speed / 40, 0, 1) * 0.35 : 0);
    const windAmt = driving ? clamp((speed - 8) / 50, 0, 1) : 0;
    this._set(this.windGain.gain, windAmt * windAmt * (inCabin ? 0.12 : 0.3));
    this._set(this.windFilter.frequency, 500 + speed * 18);

    // Background: depends on where you are and the weather.
    const w = weather;
    const rainy = w.rain;
    const outdoorsQuiet = 1 - clamp(windAmt * 1.5, 0, 0.7);
    this._set(this.ambBreeze.gain, (0.05 + w.overcast * 0.06 + w.flakes * 0.05) * outdoorsQuiet, 0.5);
    this._set(this.breezeFilter.frequency, 300 + Math.sin(performance.now() / 2300) * 120 + w.overcast * 200, 0.5);
    this._set(this.ambTown.gain, place.town * 0.12 * outdoorsQuiet, 0.6);
    const swell = 0.5 + 0.5 * Math.sin(performance.now() / 1900);
    this._set(this.ambSea.gain, place.sea * (0.04 + swell * 0.06) * outdoorsQuiet, 0.3);
    this._set(this.seaFilter.frequency, 400 + swell * 600, 0.3);
    this._set(this.ambRain.gain, clamp(rainy, 0, 1.6) * (inCabin ? 0.12 : 0.18), 0.6);

    // Birds sing in fine weather, away from towns.
    const birdChance = (1 - place.town) * (1 - clamp(w.overcast * 1.2, 0, 1)) * (1 - w.flakes);
    this._birdTimer -= dt;
    if (this._birdTimer <= 0) {
      this._birdTimer = 1.5 + Math.random() * 4;
      if (Math.random() < birdChance) this._chirp(0.025 + Math.random() * 0.03);
    }
  }
}
