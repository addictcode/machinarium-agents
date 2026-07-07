/*
 * robots.js — роботы-агенты в духе Machinarium (Йозеф): округлое
 * телескопическое тело-бочонок, круглая голова с двумя большими глазами,
 * состаренный приглушённый металл и латунные болты. Роли различаются
 * пропорциями, «шляпой»/аксессуаром на голове, инструментом и приглушённым
 * акцентным цветом (шарф-кольцо + фонарик на груди).
 *
 * Машина состояний RobotUnit: idle/thinking/working/tool_call/success/error.
 * Плюс «занятость»: внешний код (main.js) задаёт unit.moving и unit.action
 * ('crank' | 'pull' | null), а робот проигрывает соответствующую пантомиму —
 * чтобы все всегда были чем-то заняты в котельной.
 */

'use strict';

import * as THREE from 'three';
import { metalTexture, makeNameplate, puffTexture, col } from './lib.js';

/* --------------------- материалы --------------------- */
// приглушённый ржаво-серый металл корпуса
function bodyMat(tint, seed) {
  return new THREE.MeshStandardMaterial({
    map: metalTexture(seed, tint), roughness: 0.74, metalness: 0.48 });
}
const IRON = new THREE.MeshStandardMaterial({ map: metalTexture(71, '#6b6352'), roughness: 0.78, metalness: 0.45 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x211d16, roughness: 0.9, metalness: 0.3 });
function brass() { return new THREE.MeshStandardMaterial({ map: metalTexture(72, '#7a6234'), roughness: 0.5, metalness: 0.75 }); }
function glow(hex, i = 1.2) {
  return new THREE.MeshStandardMaterial({ color: 0x2a241a, emissive: new THREE.Color(hex), emissiveIntensity: i });
}

const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const cyl = (rt, rb, h, m, s = 20) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
const sph = (r, m, s = 18) => new THREE.Mesh(new THREE.SphereGeometry(r, s, Math.round(s * 0.7)), m);
const tor = (r, t, m, s = 18) => new THREE.Mesh(new THREE.TorusGeometry(r, t, 10, s), m);

/* ---------------------------------------------------------------------------
 * Базовый корпус Йозефа. cfg:
 *   tint, accent (muted), seed, scaleBody, headShape, hat, tool, thin
 * Возвращает { root, parts }.
 * ------------------------------------------------------------------------- */
function buildJosef(agent, cfg) {
  const tint = cfg.tint, accent = cfg.accent, seed = cfg.seed;
  const BM = bodyMat(tint, seed);
  const B = brass();
  const root = new THREE.Group();
  const bob = new THREE.Group(); root.add(bob);      // качается/дышит
  const stateLight = new THREE.PointLight(col(accent), 0, 6, 1.7);
  stateLight.position.set(0, 2.4, 0.5); root.add(stateLight);

  const rW = cfg.thin ? 0.44 : 0.56;                 // радиус корпуса

  // ноги-ботинки
  const legs = new THREE.Group(); bob.add(legs);
  for (const s of [-1, 1]) {
    const boot = new THREE.Group(); boot.position.set(s * 0.26, 0, 0.02); legs.add(boot);
    const shin = cyl(0.11, 0.13, 0.34, IRON, 10); shin.position.y = 0.34; boot.add(shin);
    const foot = sph(0.17, DARK, 12); foot.scale.set(1, 0.6, 1.35); foot.position.set(0, 0.09, 0.06); boot.add(foot);
    boot.userData.rest = boot.position.clone();
  }
  const feetRef = legs.children;

  // телескопическое тело: 2 кольца + бочонок
  const belly = new THREE.Group(); belly.position.y = 0.5; bob.add(belly);
  for (let i = 0; i < 2; i++) {
    const ring = cyl(rW * (0.8 + i * 0.06), rW * (0.74 + i * 0.06), 0.16, IRON, 22);
    ring.position.y = 0.02 + i * 0.17; belly.add(ring);
    belly.add(tor(rW * (0.82 + i * 0.06), 0.03, B, 22)).children.at(-1).position.y = ring.position.y + 0.08;
  }
  // бочонок-корпус
  const torso = new THREE.Group(); torso.position.y = 0.86; bob.add(torso);
  const barrel = cyl(rW, rW * 1.04, 0.92, BM, 24); barrel.position.y = 0.46; barrel.castShadow = true; torso.add(barrel);
  const capTop = sph(rW, BM, 24); capTop.scale.y = 0.55; capTop.position.y = 0.92; torso.add(capTop);
  // обручи и заклёпки
  for (const y of [0.14, 0.5, 0.82]) { const h = tor(rW * 1.01, 0.035, B, 24); h.rotation.x = Math.PI / 2; h.position.y = y; torso.add(h); }
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const rv = sph(0.028, B, 6); rv.position.set(Math.cos(a) * rW * 1.0, 0.32, Math.sin(a) * rW * 1.0); torso.add(rv); }
  // заплатка (потёртость)
  const patch = box(0.26, 0.2, 0.02, bodyMat(tint, seed + 5)); patch.position.set(rW * 0.5, 0.6, rW * 0.82); patch.rotation.y = -0.5; torso.add(patch);

  // фонарик-акцент на груди (в нём «настроение» цвета роли)
  const chestMat = glow(accent, 0.5);
  const chestRim = tor(0.13, 0.04, B, 18); chestRim.position.set(0, 0.52, rW * 0.92); torso.add(chestRim);
  const chest = new THREE.Mesh(new THREE.CircleGeometry(0.11, 18), chestMat); chest.position.set(0, 0.52, rW * 0.93); torso.add(chest);
  const chestGlow = sph(0.2, glow(accent, 0.4)); chestGlow.position.copy(chest.position); chestGlow.scale.setScalar(1); chestGlow.material.transparent = true; chestGlow.material.opacity = 0.0; torso.add(chestGlow);

  // шея
  const neck = cyl(0.12, 0.14, 0.16, IRON, 12); neck.position.y = 1.44; bob.add(neck);

  // голова с двумя большими глазами
  const head = new THREE.Group(); head.position.y = 1.62; bob.add(head);
  let skull;
  if (cfg.headShape === 'oval') { skull = sph(0.42, BM, 22); skull.scale.set(0.92, 1.08, 0.92); }
  else if (cfg.headShape === 'box') { skull = box(0.66, 0.62, 0.6, BM); }
  else { skull = sph(0.44, BM, 22); }                // round (Josef)
  skull.castShadow = true; head.add(skull);
  const headR = 0.44;
  // «ржавые» брови-козырёк
  const brow = tor(headR * 0.9, 0.05, B, 20); brow.rotation.x = 1.15; brow.position.set(0, 0.12, headR * 0.5); head.add(brow);

  // глаза — два больших круга рядом (латунная оправа, тёмная линза, светящийся зрачок)
  const eyeMat = glow(cfg.eyeColor || '#e9dfb8', 1.0);
  const eyes = [];
  for (const s of [-1, 1]) {
    const ex = s * 0.19, ey = -0.02, ez = headR * 0.82;
    const rim = tor(0.155, 0.045, B, 20); rim.position.set(ex, ey, ez); head.add(rim);
    const socket = new THREE.Mesh(new THREE.CircleGeometry(0.135, 22), DARK); socket.position.set(ex, ey, ez + 0.005); head.add(socket);
    const iris = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), eyeMat); iris.position.set(ex, ey, ez + 0.012); head.add(iris);
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.032, 14), new THREE.MeshStandardMaterial({ color: 0x0a0906 })); pupil.position.set(ex, ey, ez + 0.02); head.add(pupil);
    eyes.push({ iris, pupil, ex, ey, ez });
  }
  // ротик-щель
  const mouth = box(0.14, 0.02, 0.02, DARK); mouth.position.set(0, -0.2, headR * 0.86); head.add(mouth);

  // «шляпа»/аксессуар по роли
  const hatBits = [];
  if (cfg.hat === 'antenna') {
    const a = cyl(0.02, 0.02, 0.32, DARK, 6); a.position.y = headR + 0.14; head.add(a);
    const tip = sph(0.06, glow(accent, 1.4)); tip.position.y = headR + 0.32; head.add(tip); hatBits.push(tip);
  } else if (cfg.hat === 'bulb') {
    const base = cyl(0.06, 0.08, 0.08, B, 10); base.position.y = headR + 0.05; head.add(base);
    const bulb = sph(0.12, glow('#fff0b0', 0.5)); bulb.position.y = headR + 0.18; head.add(bulb); hatBits.push(bulb);
  } else if (cfg.hat === 'cap') {
    const cap = sph(headR * 1.02, brass(), 20); cap.scale.y = 0.5; cap.position.y = headR * 0.32; head.add(cap);
    const visor = new THREE.Mesh(new THREE.CylinderGeometry(headR * 1.05, headR * 1.05, 0.05, 20, 1, false, 0, Math.PI), brass()); visor.rotation.x = Math.PI / 2; visor.position.set(0, headR * 0.28, headR * 0.5); head.add(visor);
  } else if (cfg.hat === 'lens') {
    // большая лупа сбоку у глаза
    const lr = tor(0.2, 0.05, brass(), 22); lr.position.set(0.16, 0, headR * 0.9); head.add(lr);
    const lg = new THREE.Mesh(new THREE.CircleGeometry(0.17, 22), new THREE.MeshStandardMaterial({ color: 0x9fb0be, transparent: true, opacity: 0.4, roughness: 0.1, emissive: 0x2a3640, emissiveIntensity: 0.4 })); lg.position.set(0.16, 0, headR * 0.88); head.add(lg);
    const handle = cyl(0.028, 0.028, 0.26, brass(), 8); handle.position.set(0.34, -0.2, headR * 0.9); handle.rotation.z = 0.7; head.add(handle);
  }

  // руки: плечо-шар → согнутая трубка → простая кисть
  function arm(side) {
    const sh = new THREE.Group(); sh.position.set(side * (rW + 0.06), 1.18, 0.06); bob.add(sh);
    sh.add(sph(0.11, B, 12));
    const upper = cyl(0.075, 0.075, 0.42, IRON, 10); upper.position.set(side * 0.06, -0.2, 0); upper.rotation.z = side * 0.25; sh.add(upper);
    const elbow = new THREE.Group(); elbow.position.set(side * 0.14, -0.4, 0); sh.add(elbow);
    elbow.add(sph(0.07, B, 10));
    const fore = cyl(0.06, 0.06, 0.36, IRON, 10); fore.position.set(0, -0.18, 0.02); elbow.add(fore);
    const hand = sph(0.09, B, 10); hand.position.set(0, -0.36, 0.02); elbow.add(hand);
    // инструмент в правой руке
    const toolBits = [];
    if (side > 0 && cfg.tool) {
      if (cfg.tool === 'wrench') { const w = box(0.05, 0.28, 0.05, brass()); w.position.set(0, -0.52, 0.02); elbow.add(w); const j = tor(0.07, 0.03, brass(), 10, Math.PI); j.position.set(0, -0.66, 0.02); elbow.add(j); toolBits.push(w); }
      else if (cfg.tool === 'tablet') { const t = box(0.26, 0.32, 0.03, glow(accent, 0.7)); t.position.set(0, -0.5, 0.08); elbow.add(t); toolBits.push(t); }
      else if (cfg.tool === 'pen') { const p = cyl(0.02, 0.02, 0.22, brass(), 6); p.position.set(0, -0.5, 0.02); p.rotation.z = 0.3; elbow.add(p); toolBits.push(p); }
      else if (cfg.tool === 'note') { const n = box(0.2, 0.26, 0.02, new THREE.MeshStandardMaterial({ color: 0xcabf9f, roughness: .9 })); n.position.set(0, -0.5, 0.02); elbow.add(n); toolBits.push(n); }
    }
    return { sh, elbow, toolBits };
  }
  const aL = arm(-1), aR = arm(1);

  // масштаб роли
  root.scale.setScalar(cfg.scaleBody || 1);

  return {
    root, parts: {
      bob, torso, head, neck, legs, feet: feetRef,
      armL: aL.sh, armR: aR.sh, elbowL: aL.elbow, elbowR: aR.elbow,
      brainMat: chestMat, chestGlow, eyeMat, eyes, stateLight,
      hatBits, toolBits: aR.toolBits, headR,
    },
  };
}

/* --------------- конфиги ролей (приглушённые цвета) --------------- */
const CFG = {
  manager:   { tint: '#5b6a80', accent: '#8fa6c4', eyeColor: '#f2e8c0', seed: 11, headShape: 'round', hat: 'antenna', tool: 'tablet', scaleBody: 1.06 },
  analyst:   { tint: '#5c6a4c', accent: '#96b46a', eyeColor: '#e6efc6', seed: 22, headShape: 'oval',  hat: 'bulb',    tool: 'note',   thin: true, scaleBody: 1.0 },
  developer: { tint: '#8a5340', accent: '#c8823f', eyeColor: '#f6d79f', seed: 33, headShape: 'round', hat: 'cap',     tool: 'wrench', scaleBody: 0.96 },
  reviewer:  { tint: '#665c74', accent: '#a894c0', eyeColor: '#ece2f6', seed: 44, headShape: 'box',   hat: 'lens',    tool: 'pen',    thin: true, scaleBody: 1.02 },
};
const BUILDERS = {
  manager: a => buildJosef(a, CFG.manager),
  analyst: a => buildJosef(a, CFG.analyst),
  developer: a => buildJosef(a, CFG.developer),
  reviewer: a => buildJosef(a, CFG.reviewer),
};

/* ========================= МАШИНА СОСТОЯНИЙ ========================= */

let sharedPuff = null;

export class RobotUnit {
  constructor(scene, agent, station) {
    this.agent = agent;
    this.station = station;
    const build = (BUILDERS[agent.builder] || BUILDERS.manager)(agent);
    this.root = build.root;
    this.parts = build.parts;
    this.root.position.copy(station.robotPos);
    this.root.rotation.y = station.robotFacing || 0;
    scene.add(this.root);

    this.plate = makeNameplate();
    this.plate.sprite.position.set(0, 2.9, 0);
    this.root.add(this.plate.sprite);

    this.state = 'idle';
    this.level = 0;
    this.phase = Math.random() * 10;
    this.stateColor = col(agent.accent || '#9a8a5a');
    this.flash = 0;
    // «занятость» — управляется поведением из main.js
    this.moving = false;
    this.action = null;         // 'crank' | 'pull' | null
    this.actionPhase = Math.random() * 6;
    this.blinkCycle = 3 + Math.random() * 3;

    if (!sharedPuff) sharedPuff = puffTexture();
    this._makeSparks(scene);
    this.setState('idle');
  }

  _makeSparks(scene) {
    this.sparkN = 22;
    const geo = new THREE.BufferGeometry();
    this.sparkArr = new Float32Array(this.sparkN * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.sparkArr, 3));
    this.sparkMat = new THREE.PointsMaterial({ map: sharedPuff, size: 0.3, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffbf60 });
    this.sparkPts = new THREE.Points(geo, this.sparkMat); this.sparkPts.frustumCulled = false;
    this.root.add(this.sparkPts);
    this.sparks = [];
    for (let i = 0; i < this.sparkN; i++) this.sparks.push({ life: -1, p: new THREE.Vector3(), v: new THREE.Vector3() });
  }
  emitSparks(n, c) {
    this.sparkMat.color.set(c || 0xffbf60);
    let k = 0;
    for (const s of this.sparks) if (s.life < 0) {
      s.life = 0; s.max = 0.5 + Math.random() * 0.4;
      s.p.set((Math.random() - 0.5) * 0.5, 1.5 + Math.random() * 0.6, 0.45);
      s.v.set((Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5));
      if (++k >= n) break;
    }
  }

  setLevel(n) { this.level = n; this._plate(); }
  _plate() {
    const lbl = { idle: 'ожидание', thinking: 'думает…', working: 'работает', tool_call: 'инструмент', success: 'готово ✓', error: 'сбой !' };
    const bar = this.state === 'error' ? '#c65b3a' : this.state === 'success' ? '#8fae5c' : '#a6863f';
    this.plate.set(this.agent.title, lbl[this.state] || this.state, this.level, this.agent.accent || '#a6863f', bar);
  }
  setState(s) {
    this.state = s;
    if (s === 'success') { this.flash = 1; this.emitSparks(6, 0x8fae5c); }
    if (s === 'error') { this.flash = 1; this.emitSparks(14, 0xc65b3a); }
    if (s === 'tool_call') this.emitSparks(6, 0xd99a3a);
    this.stateColor = col(
      s === 'error' ? '#c65b3a' : s === 'success' ? '#8fae5c' :
      s === 'thinking' ? '#d9c060' : s === 'working' ? '#d99a3a' :
      s === 'tool_call' ? '#6fb0d0' : (this.agent.accent || '#9a8a5a'));
    this._plate();
    if (this.station.setActive) this.station.setActive(s !== 'idle', this.stateColor);
  }

  update(dt, t) {
    // контроллер занятости (ходит/крутит/дёргает) — задаётся из main.js
    if (this.behavior) this.behavior.update(dt, t);
    const P = this.parts, tt = t + this.phase;
    const working = this.state === 'working' || this.state === 'tool_call';
    const thinking = this.state === 'thinking';
    const err = this.state === 'error';
    const busy = working || this.action || this.moving;

    // дыхание / тряска корпуса
    let bobY = Math.sin(tt * 1.5) * 0.02;
    if (busy) bobY = Math.sin(tt * 5) * 0.05;
    if (err) P.bob.rotation.z = Math.sin(t * 40) * 0.05; else P.bob.rotation.z += (0 - P.bob.rotation.z) * 0.2;
    P.bob.position.y = bobY;

    // шаг ногами при ходьбе
    if (P.feet) for (let i = 0; i < P.feet.length; i++) {
      const boot = P.feet[i];
      const stepping = this.moving ? Math.sin(t * 9 + i * Math.PI) : 0;
      boot.position.z = boot.userData.rest.z + Math.max(0, stepping) * 0.12;
      boot.position.y = boot.userData.rest.y + Math.max(0, stepping) * 0.06;
    }

    // голова: крутит в раздумье, смотрит по сторонам
    const hy = thinking ? Math.sin(tt * 2.1) * 0.5 : this.moving ? 0 : Math.sin(tt * 0.5) * 0.22;
    P.head.rotation.y = hy;
    P.head.rotation.x = thinking ? Math.sin(tt * 1.6) * 0.12 : 0.02;

    // глаза: зрачки бегают, моргание сжатием радужки
    const lookX = thinking ? Math.sin(tt * 3) * 0.03 : Math.sin(tt * 0.7) * 0.035;
    const blink = ((t + this.phase) % this.blinkCycle) < 0.13 ? 0.15 : 1;
    for (const e of P.eyes) {
      e.pupil.position.x = e.ex + lookX;
      e.iris.scale.y = blink; e.pupil.scale.y = blink;
    }

    // РУКИ: пантомима действия
    const aL = P.armL, aR = P.armR, eR = P.elbowR;
    if (this.action === 'crank') {          // крутит воображаемую рукоятку
      const a = t * 6 + this.actionPhase;
      aR.rotation.x = -0.5 + Math.sin(a) * 0.5;
      eR.rotation.x = -0.6 + Math.cos(a) * 0.5;
      aL.rotation.x = Math.sin(tt * 1.5) * 0.1;
    } else if (this.action === 'pull') {    // дёргает рычаг вверх-вниз
      const a = Math.sin(t * 3 + this.actionPhase);
      aR.rotation.x = -0.9 - a * 0.5;
      eR.rotation.x = -0.3 - a * 0.3;
      aL.rotation.x = Math.sin(tt * 1.5) * 0.1;
    } else if (this.state === 'success') {  // радость — руки вверх
      aL.rotation.x += (-2.2 - aL.rotation.x) * 0.15;
      aR.rotation.x += (-2.2 - aR.rotation.x) * 0.15;
      eR.rotation.x += (0 - eR.rotation.x) * 0.15;
    } else {                                // покой/работа — лёгкий мах
      const sw = working ? Math.sin(tt * 5) * 0.35 : Math.sin(tt * 1.5) * 0.08;
      aL.rotation.x += (-sw - aL.rotation.x) * 0.2;
      aR.rotation.x += (sw - aR.rotation.x) * 0.2;
      eR.rotation.x += (0 - eR.rotation.x) * 0.2;
    }

    // свет/эмиссия
    const bi = thinking ? 1.4 + Math.sin(t * 9) * 0.7 : working ? 1.1 : err ? (Math.sin(t * 30) > 0 ? 1.8 : 0.2) : 0.5;
    P.brainMat.emissiveIntensity = bi;
    if (P.chestGlow) P.chestGlow.material.opacity = busy ? 0.3 + Math.sin(t * 6) * 0.15 : 0.05;
    P.eyeMat.emissiveIntensity = err ? (Math.sin(t * 30) > 0 ? 1.8 : 0.3) : (busy || thinking ? 1.4 : 0.9);
    for (const h of P.hatBits) if (h.material.emissive) h.material.emissiveIntensity = 1.0 + Math.sin(t * 6 + this.phase) * 0.4;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.5);
    P.stateLight.color.copy(this.stateColor);
    P.stateLight.intensity = (busy || thinking ? 1.8 : this.state === 'idle' ? 0.35 : 2.6) + this.flash * 4;

    // инструмент крутится при работе/действии
    for (const b of P.toolBits) if (busy) b.rotation.z += dt * 5;

    // искры при tool_call/error
    if ((this.state === 'tool_call' && Math.random() < dt * 5) || (err && Math.random() < dt * 10))
      this.emitSparks(2, err ? 0xc65b3a : 0xd99a3a);
    let any = false;
    for (let i = 0; i < this.sparkN; i++) {
      const s = this.sparks[i];
      if (s.life >= 0) { s.life += dt; if (s.life > s.max) s.life = -1; else { s.p.addScaledVector(s.v, dt); s.v.y -= dt * 4; any = true; } }
      this.sparkArr[i * 3] = s.life >= 0 ? s.p.x : 0;
      this.sparkArr[i * 3 + 1] = s.life >= 0 ? s.p.y : -999;
      this.sparkArr[i * 3 + 2] = s.life >= 0 ? s.p.z : 0;
    }
    if (any || this._had) { this.sparkPts.geometry.attributes.position.needsUpdate = true; this._had = any; }
  }
}
