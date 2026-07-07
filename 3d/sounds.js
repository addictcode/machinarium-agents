/*
 * sounds.js — звук мастерской на чистом Web Audio API (без файлов).
 * Амбиент: низкий гул + фильтрованный шум. Эффекты: щелчок, лязг,
 * шипение пара, звон, бульканье. Всё синтезируется на лету.
 */

'use strict';

export const Snd = {
  ctx: null, master: null, on: false,

  /* Ленивая инициализация — только после жеста пользователя. */
  ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    // гул трансформатора: два расстроенных генератора
    for (const [f, type, g] of [[48, 'triangle', 0.05], [96.5, 'sine', 0.022]]) {
      const o = this.ctx.createOscillator(), og = this.ctx.createGain();
      o.type = type; o.frequency.value = f; og.gain.value = g;
      o.connect(og); og.connect(this.master); o.start();
    }
    // дыхание вентиляции: зацикленный шум через низкий фильтр
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = this.ctx.createBufferSource();
    const nf = this.ctx.createBiquadFilter(), ng = this.ctx.createGain();
    noise.buffer = buf; noise.loop = true;
    nf.type = 'lowpass'; nf.frequency.value = 220;
    ng.gain.value = 0.05;
    noise.connect(nf); nf.connect(ng); ng.connect(this.master);
    noise.start();
  },

  toggle(btn) {
    this.ensure();
    this.on = !this.on;
    this.ctx.resume();
    this.master.gain.linearRampToValueAtTime(this.on ? 0.5 : 0, this.ctx.currentTime + 0.4);
    if (btn) btn.textContent = this.on ? '🔊 звук' : '🔇 звук';
  },

  /* Короткий тон с экспоненциальным затуханием. */
  blip(freq, dur, type = 'square', vol = 0.1) {
    if (!this.on) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(this.ctx.currentTime + dur);
  },

  /* Всплеск шума через полосовой фильтр (пар, скрежет). */
  noiseBurst(dur, freq, q, vol = 0.2) {
    if (!this.on) return;
    const len = Math.ceil(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    src.buffer = buf;
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
  },

  click()  { this.blip(1900 + Math.random() * 500, 0.04, 'square', 0.06); },
  clank()  { this.blip(170 + Math.random() * 60, 0.2, 'square', 0.14); this.blip(2600, 0.06, 'triangle', 0.05); },
  hiss()   { this.noiseBurst(0.9, 3200, 0.8, 0.25); },
  creak()  { this.blip(320, 0.3, 'sawtooth', 0.07); this.blip(210, 0.45, 'sawtooth', 0.05); },
  ding()   { this.blip(880, 0.5, 'sine', 0.12); this.blip(1318, 0.8, 'sine', 0.05); },
  bubble() { for (let i = 0; i < 4; i++) setTimeout(() => this.blip(300 + Math.random() * 500, 0.09, 'sine', 0.07), i * 110); },
  // события агентов
  tick()    { this.blip(1400 + Math.random() * 400, 0.03, 'square', 0.03); },
  whoosh()  { this.blip(300, 0.3, 'sine', 0.06); this.noiseBurst(0.3, 1400, 1.2, 0.06); },
  buzz()    { this.blip(90, 0.5, 'sawtooth', 0.15); },
  fanfare() { [660, 880, 1100].forEach((f, i) => setTimeout(() => this.blip(f, 0.4, 'sine', 0.1), i * 130)); },
};
