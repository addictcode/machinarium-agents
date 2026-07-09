/*
 * objects.js — фабрики механизмов и постройка бункера.
 *
 * Каждый builder возвращает THREE.Group и сам регистрирует свои
 * анимации в Anim. Новый тип механизма = новая функция в BUILDERS
 * + строчка в scene-config.json. Ядро сцены трогать не нужно.
 */

'use strict';

import * as THREE from 'three';
import { Anim, Machine } from './animations.js';

/* ==================== ПРОЦЕДУРНЫЕ ТЕКСТУРЫ ========================== */

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Ржавый металл: пятна, царапины, потёки. */
function metalTexture(seed, base, opts = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const rand = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  // пятна ржавчины
  for (let i = 0; i < 260; i++) {
    const r = 1 + rand() * 5;
    g.fillStyle = `rgba(${90 + rand() * 70 | 0},${52 + rand() * 40 | 0},${20 + rand() * 26 | 0},${0.05 + rand() * 0.14})`;
    g.beginPath();
    g.arc(rand() * 256, rand() * 256, r, 0, 7);
    g.fill();
  }
  // царапины
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = `rgba(0,0,0,${0.04 + rand() * 0.08})`;
    g.lineWidth = 1;
    g.beginPath();
    const x = rand() * 256, y = rand() * 256;
    g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * 60, y + (rand() - 0.5) * 60);
    g.stroke();
  }
  // стыки листов с заклёпками
  if (opts.plates) {
    for (const p of [64, 128, 192]) {
      g.strokeStyle = 'rgba(0,0,0,.28)';
      g.lineWidth = 2;
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
  return tex;
}

/** Мягкая круглая частица (для пара/пыли). */
function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,250,235,1)');
  gr.addColorStop(0.4, 'rgba(255,250,235,.45)');
  gr.addColorStop(1, 'rgba(255,250,235,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Табличка с текстом (canvas → плоскость). */
function textPlate(text, w = 512, h = 128, font = "64px 'Special Elite', serif") {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#4a4232';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#241f14';
  g.lineWidth = 10;
  g.strokeRect(5, 5, w - 10, h - 10);
  g.fillStyle = '#e2d6ac';
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ======================== МАТЕРИАЛЫ ================================= */

export const MAT = {
  iron: null, ironWall: null, floor: null, copper: null, brass: null,
  dark: null, glass: null,
  init() {
    // Приглушённая серо-ржавая палитра «как в Machinarium» — темнее и глуше.
    this.iron = new THREE.MeshStandardMaterial({
      map: metalTexture(7, '#6e6858'), roughness: 0.8, metalness: 0.48 });
    this.ironWall = new THREE.MeshStandardMaterial({
      map: metalTexture(11, '#5c5545', { plates: true }), roughness: 0.85, metalness: 0.3 });
    this.floor = new THREE.MeshStandardMaterial({
      map: metalTexture(23, '#4a4536', { plates: true }), roughness: 0.9, metalness: 0.26 });
    this.copper = new THREE.MeshStandardMaterial({
      map: metalTexture(31, '#7c5a3e'), roughness: 0.55, metalness: 0.65 });
    this.brass = new THREE.MeshStandardMaterial({
      map: metalTexture(41, '#a5813e'), roughness: 0.45, metalness: 0.78 });
    this.dark = new THREE.MeshStandardMaterial({ color: 0x2e2820, roughness: 0.9, metalness: 0.2 });
    this.glass = new THREE.MeshStandardMaterial({
      color: 0xbfd0c0, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.1,
      side: THREE.DoubleSide });
    this.brassDS = this.brass.clone();          // для абажуров (видны изнутри)
    this.brassDS.side = THREE.DoubleSide;
    for (const k of ['ironWall', 'floor']) this[k].map.repeat.set(3, 3);
  },
};

/* ======================= ГЕОМЕТРИЯ ШЕСТЕРНИ ========================== */

const gearGeoCache = new Map();

function gearGeometry(r, teeth, depth) {
  const key = `${r}|${teeth}|${depth}`;
  if (gearGeoCache.has(key)) return gearGeoCache.get(key);
  const shape = new THREE.Shape();
  const R = r * 1.18;
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = ((i + 0.38) / teeth) * Math.PI * 2;
    const a2 = ((i + 0.5) / teeth) * Math.PI * 2;
    const a3 = ((i + 0.88) / teeth) * Math.PI * 2;
    const pts = [[a0, r], [a0 + 0.03, R], [a1, R], [a1 + 0.03, r], [a2, r], [a3, r]];
    for (const [a, rad] of pts) {
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (i === 0 && a === a0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
  }
  shape.closePath();
  // отверстие под ось
  const hole = new THREE.Path();
  hole.absarc(0, 0, r * 0.16, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: depth * 0.12, bevelSize: r * 0.02, bevelSegments: 1,
  });
  geo.center();
  gearGeoCache.set(key, geo);
  return geo;
}

/* ==================== ПАР (система частиц) =========================== */

const puffTex = { t: null };

export class SteamEmitter {
  constructor(scene, pos, { rate = 3, up = 1.6, spread = 0.25, size = 0.55 } = {}) {
    if (!puffTex.t) puffTex.t = puffTexture();
    this.N = 42;
    this.pos = pos.clone();
    this.rate = rate; this.up = up; this.spread = spread;
    this.active = true;
    this.parts = [];
    for (let i = 0; i < this.N; i++) this.parts.push({ life: -1, p: new THREE.Vector3(), v: new THREE.Vector3() });
    this.geo = new THREE.BufferGeometry();
    this.arr = new Float32Array(this.N * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.arr, 3));
    this.mat = new THREE.PointsMaterial({
      map: puffTex.t, size: size * 1.25, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.NormalBlending, color: 0xf2ead6,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.acc = 0;
    Anim.add((dt) => this.update(dt));
  }
  spawnOne(burst = 0) {
    const p = this.parts.find(x => x.life < 0);
    if (!p) return;
    p.life = 0;
    p.max = 1.6 + Math.random() * 1.2;
    p.p.copy(this.pos);
    p.v.set((Math.random() - 0.5) * this.spread + burst * (Math.random() - 0.5),
      this.up * (0.7 + Math.random() * 0.6),
      (Math.random() - 0.5) * this.spread);
  }
  burst(n = 14) { for (let i = 0; i < n; i++) this.spawnOne(1.4); }
  update(dt) {
    if (this.active) {
      this.acc += dt * this.rate;
      while (this.acc > 1) { this.acc -= 1; this.spawnOne(); }
    }
    let alive = 0;
    for (let i = 0; i < this.N; i++) {
      const p = this.parts[i];
      if (p.life >= 0) {
        p.life += dt;
        if (p.life > p.max) p.life = -1;
        else {
          p.p.addScaledVector(p.v, dt);
          p.v.x += (Math.random() - 0.5) * dt * 0.6;
          alive++;
        }
      }
      // мёртвые прячем далеко вниз
      this.arr[i * 3] = p.life >= 0 ? p.p.x : 0;
      this.arr[i * 3 + 1] = p.life >= 0 ? p.p.y : -999;
      this.arr[i * 3 + 2] = p.life >= 0 ? p.p.z : 0;
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}

/* ========================= ФАБРИКИ МЕХАНИЗМОВ ======================== */
/* Каждая получает (item, world) — запись из scene-config.json и мир.   */

export const BUILDERS = {

  /** Шестерня на оси. params: r, teeth, depth, speed, dir, color */
  gear(item) {
    const { r = 1, teeth = 12, depth = 0.3, speed = 0.6, dir = 1 } = item.params || {};
    const g = new THREE.Group();
    const mat = item.color
      ? new THREE.MeshStandardMaterial({ map: metalTexture(item.seed || 5, item.color), roughness: 0.6, metalness: 0.65 })
      : MAT.iron;
    const wheel = new THREE.Mesh(gearGeometry(r, teeth, depth), mat);
    wheel.castShadow = true;
    g.add(wheel);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.1, r * 0.1, depth * 3, 10), MAT.dark);
    axle.rotation.x = Math.PI / 2;
    g.add(axle);
    g.userData.wheel = wheel;
    g.userData.speedMul = 1;   // разовый буст по клику (ACTIONS.gearKick)
    Anim.add((dt) => {
      wheel.rotation.z += dt * speed * dir * Machine.gearBoost * (g.userData.speedMul ?? 1);
    });
    return g;
  },

  /** Висячая лампа с конусом-абажуром. params: light (0..2), flicker, color */
  lamp(item) {
    const { drop = 1.6, flicker = false, light = 0.9, color = 0xffd98e } = item.params || {};
    const g = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, drop, 6), MAT.dark);
    rod.position.y = -drop / 2;
    g.add(rod);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.5, 24, 1, true), MAT.brassDS);
    shade.position.y = -drop;
    g.add(shade);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff2cc, emissive: new THREE.Color(color), emissiveIntensity: 2.2 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), bulbMat);
    bulb.position.y = -drop - 0.12;
    g.add(bulb);
    let pl = null;
    if (light > 0) {
      // физичный decay в новых three требует интенсивности покрупнее
      pl = new THREE.PointLight(color, light * 4.2, 15, 1.5);
      pl.position.y = -drop - 0.3;
      g.add(pl);
    }
    if (flicker) {
      const base = light * 4.2;
      Anim.add((dt, t) => {
        const k = 0.72 + Math.sin(t * 19) * 0.12 + Math.sin(t * 7.3) * 0.1 + (Math.random() < 0.008 ? -0.55 : 0);
        bulbMat.emissiveIntensity = 2.2 * k;
        if (pl) pl.intensity = base * k;
      });
    }
    g.userData.bulbMat = bulbMat;
    g.userData.light = pl;
    return g;
  },

  /** Вентиль на трубе. Клик — пшик пара. params: r */
  valve(item, world) {
    const { r = 0.4 } = item.params || {};
    const g = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.14, 10, 24), MAT.brass);
    g.add(rim);
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.07, r * 0.07, r * 2, 8), MAT.brass);
      sp.rotation.z = (i / 4) * Math.PI;
      g.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(r * 0.2, 10, 8), MAT.dark);
    g.add(hub);
    g.userData.spin = (fast) => {
      Anim.tween(0.9, k => { g.rotation.z = k * Math.PI * (fast ? 2 : 1); });
    };
    return g;
  },

  /** Рычаг на постаменте. Клик — переключение + цепная реакция. */
  lever(item) {
    const { size = 1 } = item.params || {};
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5 * size, 0.22 * size, 0.34 * size), MAT.iron);
    base.castShadow = true;
    g.add(base);
    const arm = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * size, 0.05 * size, 0.85 * size, 8), MAT.dark);
    stick.position.y = 0.42 * size;
    arm.add(stick);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.11 * size, 12, 10),
      new THREE.MeshStandardMaterial({ color: item.color ? new THREE.Color(item.color) : 0xa03428, roughness: 0.4, metalness: 0.3, emissive: 0x230a06, emissiveIntensity: 0.6 }));
    knob.position.y = 0.86 * size;
    arm.add(knob);
    arm.position.y = 0.1 * size;
    arm.rotation.z = -0.55;
    g.add(arm);
    g.userData.arm = arm;
    g.userData.on = false;
    g.userData.flip = () => {
      const from = g.userData.on ? 0.55 : -0.55, to = -from;
      g.userData.on = !g.userData.on;
      Anim.tween(0.45, k => { arm.rotation.z = from + (to - from) * k; }, { ease: 'bounce' });
    };
    // иногда рычаг дёргается сам — сцена живёт
    Anim.add((dt, t) => {
      if (Math.random() < dt * 0.02) {
        Anim.tween(0.3, k => { arm.rotation.x = Math.sin(k * Math.PI) * 0.08; });
      }
    });
    return g;
  },

  /** Стеклянный бак с булькающей жидкостью. Клик — шторм пузырей. */
  tank(item) {
    const { r = 0.8, h = 2.6, liquid = 0x4f8f5e } = item.params || {};
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.2, r * 1.3, 0.3, 20), MAT.iron);
    base.position.y = 0.15;
    base.castShadow = true;
    g.add(base);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20, 1, true), MAT.glass);
    glass.position.y = h / 2 + 0.3;
    g.add(glass);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.15, 0.24, 20), MAT.brass);
    cap.position.y = h + 0.42;
    g.add(cap);
    // жидкость
    const liqMat = new THREE.MeshStandardMaterial({
      color: liquid, transparent: true, opacity: 0.72, roughness: 0.3,
      emissive: new THREE.Color(liquid), emissiveIntensity: 0.35 });
    const liq = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.93, r * 0.93, h * 0.62, 18), liqMat);
    liq.position.y = h * 0.31 + 0.3;
    g.add(liq);
    // пузыри
    const bubGeo = new THREE.SphereGeometry(0.055, 8, 6);
    const bubMat = new THREE.MeshStandardMaterial({
      color: 0xd8f0dc, transparent: true, opacity: 0.7, roughness: 0.2 });
    const bubbles = [];
    for (let i = 0; i < 14; i++) {
      const b = new THREE.Mesh(bubGeo, bubMat);
      b.userData.a = Math.random() * Math.PI * 2;
      b.userData.rr = Math.random() * r * 0.7;
      b.userData.y = Math.random();
      b.userData.sp = 0.25 + Math.random() * 0.5;
      g.add(b);
      bubbles.push(b);
    }
    let storm = 0;
    Anim.add((dt, t) => {
      // колыхание поверхности
      liq.scale.y = 1 + Math.sin(t * 2.1 + (item.seed || 0)) * 0.018;
      storm = Math.max(0, storm - dt);
      for (const b of bubbles) {
        b.userData.y += dt * b.userData.sp * (storm > 0 ? 3.4 : 1);
        if (b.userData.y > 1) { b.userData.y = 0; b.userData.a = Math.random() * Math.PI * 2; }
        const yy = 0.45 + b.userData.y * (h * 0.58);
        b.position.set(
          Math.cos(b.userData.a + t * 0.4) * b.userData.rr,
          yy,
          Math.sin(b.userData.a + t * 0.4) * b.userData.rr);
        b.scale.setScalar(0.6 + b.userData.y * 0.9);
      }
    });
    g.userData.storm = () => { storm = 2.4; };
    g.userData.liqMat = liqMat;
    return g;
  },

  /** Шкаф с дверцей: клик — открыть/закрыть, внутри светящееся ядро. */
  cabinet(item) {
    const { w = 1.8, h = 2.6, d = 0.9 } = item.params || {};
    const g = new THREE.Group();
    // корпус без передней стенки: 5 панелей
    const wallT = 0.07;
    const mk = (sx, sy, sz, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), MAT.ironWall);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    mk(w, h, wallT, 0, h / 2, -d / 2);          // зад
    mk(wallT, h, d, -w / 2, h / 2, 0);          // лево
    mk(wallT, h, d, w / 2, h / 2, 0);           // право
    mk(w, wallT, d, 0, h, 0);                   // верх
    mk(w, wallT, d, 0, wallT / 2, 0);           // низ
    // начинка: ядро + шестерёнка
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0xffb050, emissive: 0xff8a30, emissiveIntensity: 1.6 });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), coreMat);
    core.position.set(0, h * 0.55, 0);
    g.add(core);
    const innerGear = new THREE.Mesh(gearGeometry(0.34, 9, 0.1), MAT.brass);
    innerGear.position.set(-w * 0.22, h * 0.28, 0);
    g.add(innerGear);
    Anim.add((dt, t) => {
      core.rotation.y += dt * 0.8;
      core.rotation.x += dt * 0.3;
      coreMat.emissiveIntensity = 1.3 + Math.sin(t * 3.1) * 0.5;
      innerGear.rotation.z -= dt * 1.2 * Machine.gearBoost;
    });
    // дверца на петле (pivot у левого края)
    const door = new THREE.Group();
    door.position.set(-w / 2, 0, d / 2);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, h, wallT), MAT.iron);
    leaf.position.set(w / 2, h / 2, 0);
    leaf.castShadow = true;
    door.add(leaf);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), MAT.brass);
    handle.position.set(w * 0.86, h / 2, wallT);
    door.add(handle);
    g.add(door);
    g.userData.open = false;
    g.userData.toggleDoor = () => {
      const from = g.userData.open ? -1.9 : 0, to = g.userData.open ? 0 : -1.9;
      g.userData.open = !g.userData.open;
      Anim.tween(0.8, k => { door.rotation.y = from + (to - from) * k; }, { ease: 'smooth' });
    };
    g.userData.core = core;
    g.userData.coreMat = coreMat;
    return g;
  },

  /** Дымящая труба-вентиляция (пар постоянный). */
  vent(item, world) {
    const { h = 1.2, r = 0.22, rate = 2.5 } = item.params || {};
    const g = new THREE.Group();
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, h, 12), MAT.copper);
    pipe.position.y = h / 2;
    pipe.castShadow = true;
    g.add(pipe);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, r * 0.14, 8, 16), MAT.brass);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = h;
    g.add(rim);
    // эмиттер создаётся после добавления в сцену (нужна мировая позиция)
    g.userData.initSteam = (scene) => {
      const p = new THREE.Vector3();
      g.getWorldPosition(p);
      p.y += h;
      g.userData.steam = new SteamEmitter(scene, p, { rate, up: 1.4, size: 0.7 });
      return g.userData.steam;
    };
    return g;
  },
};

/* ===================== ПОСТРОЙКА БУНКЕРА ============================= */

/** Стены, пол, котёл, трубы, стол, бочки, кабели, пыль, вывеска. */
export function buildRoom(world) {
  const S = world.scene;
  const R = { steamers: [] };

  /* --- пол и стены --- */
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(34, 22), MAT.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  S.add(floor);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(34, 12), MAT.ironWall);
  back.position.set(0, 6, -7);
  back.receiveShadow = true;
  S.add(back);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(22, 12), MAT.ironWall);
    side.rotation.y = s * Math.PI / 2;
    side.position.set(-s * 16, 6, 2);
    S.add(side);
  }
  // потолочные балки
  for (let x = -12; x <= 12; x += 6) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 20), MAT.dark);
    beam.position.set(x, 10.6, 2);
    S.add(beam);
  }

  /* --- котёл справа --- */
  const boiler = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.2, 5.2, 24), MAT.copper);
  body.position.y = 2.6;
  body.castShadow = true;
  boiler.add(body);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT.copper);
  dome.position.y = 5.2;
  boiler.add(dome);
  // обручи
  for (const y of [1.1, 2.6, 4.1]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(2.16, 0.09, 8, 28), MAT.brass);
    hoop.rotation.x = Math.PI / 2;
    hoop.position.y = y;
    boiler.add(hoop);
  }
  // топка: светящееся окно + мерцающий свет
  const fireMat = new THREE.MeshStandardMaterial({
    color: 0xff9540, emissive: 0xff6a1e, emissiveIntensity: 2.4 });
  const fire = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), fireMat);
  fire.position.set(0, 1.05, 2.21);
  boiler.add(fire);
  const grate = new THREE.Group();
  for (let i = -2; i <= 2; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.8, 0.04), MAT.dark);
    bar.position.set(i * 0.24, 1.05, 2.23);
    grate.add(bar);
  }
  boiler.add(grate);
  const fireLight = new THREE.PointLight(0xff7a28, 4.5, 10, 1.6);
  fireLight.position.set(0, 1.2, 3.2);
  boiler.add(fireLight);
  Anim.add((dt, t) => {
    const k = 0.75 + Math.sin(t * 11) * 0.14 + Math.sin(t * 23.7) * 0.1;
    fireMat.emissiveIntensity = 2.4 * k;
    fireLight.intensity = 4.5 * k;
  });
  boiler.position.set(9.5, 0, -4.2);
  S.add(boiler);
  R.boiler = boiler;

  /* --- трубы: магистраль по стене + отводы --- */
  const pipeMatY = 8.6;
  const main = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 26, 14), MAT.copper);
  main.rotation.z = Math.PI / 2;
  main.position.set(-1, pipeMatY, -6.6);
  S.add(main);
  for (const x of [-11, -5.5, 2, 9.5]) {
    const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.4, 12), MAT.copper);
    drop.position.set(x, pipeMatY - 1.7, -6.6);
    S.add(drop);
    const elbow = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.22, 10, 12, Math.PI / 2), MAT.copper);
    elbow.position.set(x + 0.32, pipeMatY, -6.6);
    elbow.rotation.z = Math.PI / 2;
    S.add(elbow);
  }
  // фланцы
  for (const x of [-8, 0, 6]) {
    const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 14), MAT.brass);
    fl.rotation.z = Math.PI / 2;
    fl.position.set(x, pipeMatY, -6.6);
    S.add(fl);
  }

  /* --- пульт-верстак в центре --- */
  const desk = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.24, 1.8), MAT.iron);
  top.position.y = 1.15;
  top.castShadow = true;
  desk.add(top);
  for (const [sx, sz] of [[-2.4, -0.6], [2.4, -0.6], [-2.4, 0.6], [2.4, 0.6]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.1, 0.18), MAT.dark);
    leg.position.set(sx, 0.55, sz);
    desk.add(leg);
  }
  // маленькие манометры на пульте
  for (const x of [-1.7, -0.9]) {
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 16), MAT.brass);
    dial.rotation.x = Math.PI / 2 - 0.5;
    dial.position.set(x, 1.42, 0.4);
    desk.add(dial);
  }
  desk.position.set(0.3, 0, 2.6);
  S.add(desk);
  R.desk = desk;

  /* --- бочки и ящики по углам --- */
  const rand = rng(99);
  for (const [x, z] of [[-13.5, -3], [-12.6, -5.2], [13.2, 1.5], [12.4, 3.4], [-13, 3.8]]) {
    if (rand() < 0.55) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 1.6, 14), MAT.iron);
      b.position.set(x, 0.8, z);
      b.rotation.y = rand() * 3;
      b.castShadow = true;
      S.add(b);
    } else {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 1.2), MAT.ironWall);
      b.position.set(x, 0.6, z);
      b.rotation.y = rand();
      b.castShadow = true;
      S.add(b);
    }
  }

  /* --- провисающие кабели под потолком --- */
  for (const [x1, x2, y, sag] of [[-14, -2, 10.2, 1.6], [-4, 8, 10.4, 1.2], [3, 14, 10, 1.8]]) {
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(new THREE.Vector3(
        x1 + (x2 - x1) * t,
        y - Math.sin(t * Math.PI) * sag,
        -6.2 + Math.sin(t * 7) * 0.1));
    }
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.045, 6), MAT.dark);
    S.add(tube);
  }

  /* --- пыль в воздухе --- */
  const dustGeo = new THREE.BufferGeometry();
  const dustN = 240, dustArr = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    dustArr[i * 3] = (rand() - 0.5) * 28;
    dustArr[i * 3 + 1] = 0.5 + rand() * 9.5;
    dustArr[i * 3 + 2] = -6 + rand() * 14;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustArr, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: puffTex.t || (puffTex.t = puffTexture()), size: 0.09, transparent: true,
    opacity: 0.35, depthWrite: false, color: 0xf0e6c8 }));
  dust.frustumCulled = false;
  S.add(dust);
  Anim.add((dt, t) => {
    dust.rotation.y = Math.sin(t * 0.05) * 0.04;
    dust.position.y = Math.sin(t * 0.2) * 0.15;
  });

  /* --- вывеска на задней стене --- */
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 1.5),
    new THREE.MeshStandardMaterial({ map: textPlate('МАШИНАРИУМ'), roughness: 0.85 }));
  sign.position.set(0, 9.8, -6.93);
  S.add(sign);

  /* --- пар из котла --- */
  const boilerSteam = new SteamEmitter(S, new THREE.Vector3(9.5, 7.6, -4.2), { rate: 2, up: 1.7, size: 0.9 });
  R.boilerSteam = boilerSteam;
  R.steamers.push(boilerSteam);

  return R;
}
