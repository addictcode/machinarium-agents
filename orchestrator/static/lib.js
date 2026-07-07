/*
 * lib.js — общие помощники: процедурные текстуры (ржавый металл, свечение),
 * табличка-спрайт с текстом, детерминированный рандом.
 * Используется room.js и robots.js.
 */

'use strict';

import * as THREE from 'three';

/** Детерминированный ГПСЧ — чтобы сцена не «прыгала» между загрузками. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Процедурная текстура ржавого металла с пятнами, царапинами, заклёпками. */
export function metalTexture(seed, base, { plates = false, rep = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const rand = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 240; i++) {                 // пятна ржавчины
    g.fillStyle = `rgba(${90 + rand() * 70 | 0},${52 + rand() * 40 | 0},${20 + rand() * 26 | 0},${0.05 + rand() * 0.13})`;
    g.beginPath();
    g.arc(rand() * 256, rand() * 256, 1 + rand() * 5, 0, 7);
    g.fill();
  }
  for (let i = 0; i < 34; i++) {                  // царапины
    g.strokeStyle = `rgba(0,0,0,${0.04 + rand() * 0.08})`;
    g.lineWidth = 1;
    const x = rand() * 256, y = rand() * 256;
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * 60, y + (rand() - 0.5) * 60);
    g.stroke();
  }
  if (plates) {                                   // стыки листов + заклёпки
    for (const p of [64, 128, 192]) {
      g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
      for (let q = 12; q < 256; q += 32) {
        g.fillStyle = 'rgba(0,0,0,.4)';
        g.beginPath(); g.arc(p + 5, q, 2.4, 0, 7); g.fill();
        g.fillStyle = 'rgba(255,240,200,.25)';
        g.beginPath(); g.arc(p + 4, q - 1, 1, 0, 7); g.fill();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (rep !== 1) tex.repeat.set(rep, rep);
  return tex;
}

/** Мягкая круглая частица (пар/пыль/искры). */
export function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,250,235,1)');
  gr.addColorStop(0.4, 'rgba(255,250,235,.45)');
  gr.addColorStop(1, 'rgba(255,250,235,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * Спрайт-плашка над роботом: имя, статус и шкала уровня.
 * Возвращает { sprite, set(name, status, level, color) } — перерисовка на лету.
 */
export function makeNameplate() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.6, 0.81, 1);
  sprite.renderOrder = 999;

  function set(name, status, level, color, barColor) {
    g.clearRect(0, 0, 512, 160);
    // фон-табличка
    g.fillStyle = 'rgba(30,24,16,.82)';
    roundRect(g, 8, 8, 496, 144, 20); g.fill();
    g.strokeStyle = color || '#c9a24a'; g.lineWidth = 5;
    roundRect(g, 8, 8, 496, 144, 20); g.stroke();
    // имя
    g.fillStyle = '#f0e6c8';
    g.font = "bold 44px 'Special Elite', serif";
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(name, 30, 44);
    // статус
    g.fillStyle = '#c9bfa0';
    g.font = "30px 'Neucha', cursive";
    g.fillText(status, 30, 88);
    // уровень + шкала
    g.fillStyle = '#f0c04a';
    g.font = "bold 30px 'Special Elite', serif";
    g.textAlign = 'right';
    g.fillText('LV ' + level, 484, 44);
    // прогресс-бар (по 10 делений)
    const bw = 452, bx = 30, by = 118, filled = Math.min(level % 10 || (level ? 10 : 0), 10) / 10;
    g.fillStyle = 'rgba(0,0,0,.5)';
    roundRect(g, bx, by, bw, 20, 10); g.fill();
    g.fillStyle = barColor || '#7fc35a';
    roundRect(g, bx, by, Math.max(20, bw * filled), 20, 10); g.fill();
    tex.needsUpdate = true;
  }
  return { sprite, set };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Числовой цвет из hex-строки. */
export function col(hex) { return new THREE.Color(hex); }
