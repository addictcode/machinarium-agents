/*
 * scene.js — ядро 3D-сцены «Машинариум, котельная №7».
 *
 * Инициализация Three.js, камера с параллаксом от мыши и зумом колесом,
 * тёплый свет + bloom, загрузка механизмов из scene-config.json,
 * действия кликов (ACTIONS), журнал, FPS, опциональная привязка к шине
 * событий агентов (ws://…/ws — если доступна).
 *
 * Задел под роботов-агентов: world.agents — отдельная группа; добавляй
 * туда свои меши и двигай их, механизмы им не мешают.
 */

'use strict';

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { MAT, BUILDERS, buildRoom, SteamEmitter } from './objects.js';
import { Anim, Machine } from './animations.js';
import { Interact } from './interactions.js';
import { Snd } from './sounds.js';

/* ========================= ИНИЦИАЛИЗАЦИЯ ============================= */

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // киношная тёплая картинка
renderer.toneMappingExposure = 1.32;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x241c12);
scene.fog = new THREE.Fog(0x241c12, 20, 46);

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
const CAM = { base: new THREE.Vector3(0, 5.4, 13.5), look: new THREE.Vector3(0, 4.2, -2), dist: 13.5, tdist: 13.5, mx: 0, my: 0 };
camera.position.copy(CAM.base);

/* Свет: тёплое небо бункера + «солнце» из люка + мерцающая топка (в objects). */
scene.add(new THREE.HemisphereLight(0xffe2b0, 0x1d1610, 0.7));
const sun = new THREE.DirectionalLight(0xffd9a0, 1.35);
sun.position.set(7, 13, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
sun.shadow.camera.top = 16; sun.shadow.camera.bottom = -6;
scene.add(sun);

/* Bloom — свечение ламп, топки, ядра в шкафу. */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, 0.6);
composer.addPass(bloom);

const world = {
  scene, camera, renderer, composer,
  mechanisms: new THREE.Group(),
  agents: new THREE.Group(),          // сюда потом заедут роботы-агенты
  steamBurst: null,                   // world.steamBurst(pos, n) — пшик пара где угодно
};
scene.add(world.mechanisms);
scene.add(world.agents);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ====================== ЖУРНАЛ И СЧЁТЧИКИ ============================ */

const logEl = document.getElementById('log');
function log(text, cls = '') {
  const div = document.createElement('div');
  div.textContent = text;
  div.className = cls;
  logEl.prepend(div);
  while (logEl.children.length > 6) logEl.lastChild.remove();
}

/* ================= ДЕЙСТВИЯ МЕХАНИЗМОВ (по клику) ==================== */
/* Имя действия указывается в scene-config.json → "action". */

const ACTIONS = {
  gearKick(g) {
    g.userData.speedMul = 7;
    Anim.tween(1.6, k => { g.userData.speedMul = 7 - 6 * k; });
    Snd.clank();
    log('Шестерня раскручена вручную', 'hot');
  },
  lampToggle(g) {
    const palette = [0xffd98e, 0xff8a5a, 0x9fdc8a, 0x8ab8ff];
    const cur = g.userData.paletteIdx = ((g.userData.paletteIdx ?? 0) + 1) % palette.length;
    const c = new THREE.Color(palette[cur]);
    g.userData.bulbMat.emissive.set(c);
    if (g.userData.light) g.userData.light.color.set(c);
    Snd.click(); Snd.ding();
    log('Лампа сменила настроение', 'ok');
  },
  valveBurst(g, world) {
    g.userData.spin(true);
    const p = new THREE.Vector3();
    g.getWorldPosition(p);
    world.steamBurst(p, 16);
    Snd.hiss();
    log('Пар стравлен из вентиля', 'hot');
  },
  turbo(g) {
    g.userData.flip();
    const on = g.userData.on;
    Machine.boostUntil = on ? performance.now() + 7000 : 0;
    Snd.clank();
    if (on) { Snd.hiss(); bloom.strength = 0.85; log('ТУРБО-РЕЖИМ! Все механизмы на пределе', 'err'); }
    else { bloom.strength = 0.5; log('Турбо выключено, машины выдыхают', 'ok'); }
    Anim.tween(0.6, k => { bloom.strength = on ? 0.5 + k * 0.35 : 0.85 - k * 0.35; });
  },
  ventKick(g, world) {
    g.userData.flip();
    for (const s of world.room.steamers) s.burst(10);
    Snd.hiss();
    log('Система продута', 'ok');
  },
  tankStorm(g) {
    g.userData.storm();
    Snd.bubble();
    log('Зелье разбушевалось', 'hot');
  },
  cabinetToggle(g) {
    g.userData.toggleDoor();
    Snd.creak();
    log(g.userData.open ? 'Шкаф открыт — внутри что-то светится…' : 'Шкаф закрыт', 'hot');
  },
  ventBurst(g) {
    if (g.userData.steam) g.userData.steam.burst(20);
    Snd.hiss();
    log('Дымоход чихнул', 'hot');
  },
};

/* ==================== СБОРКА СЦЕНЫ ИЗ КОНФИГА ======================== */

async function build() {
  MAT.init();
  world.room = buildRoom(world);

  // общий эмиттер для разовых «пшиков» в произвольной точке
  const burster = new SteamEmitter(scene, new THREE.Vector3(0, -999, 0), { rate: 0 });
  burster.active = false;
  world.steamBurst = (pos, n) => { burster.pos.copy(pos); burster.burst(n); };
  world.room.steamers.push(burster);

  const cfg = await (await fetch('scene-config.json')).json();
  for (const item of cfg.mechanisms) {
    const builder = BUILDERS[item.type];
    if (!builder) { console.warn('нет фабрики', item.type); continue; }
    const g = builder(item, world);
    if (item.pos) g.position.set(...item.pos);
    if (item.rot) g.rotation.set(...item.rot);
    if (item.scale) g.scale.setScalar(item.scale);
    g.userData.speedMul = g.userData.speedMul ?? 1;
    world.mechanisms.add(g);
    if (item.type === 'vent') world.room.steamers.push(g.userData.initSteam(scene));
    if (item.action && ACTIONS[item.action]) {
      Interact.register(g, {
        name: item.name, hint: item.hint,
        onClick: (grp, w) => ACTIONS[item.action](grp, w),
      });
    }
  }

  Interact.init(world);
  document.getElementById('loader').classList.add('done');
  log('Котельная №7 запущена. Кликай на механизмы!', 'ok');
}

/* ================== КАМЕРА: ПАРАЛЛАКС + ЗУМ ========================= */

addEventListener('pointermove', e => {
  CAM.mx = (e.clientX / innerWidth) * 2 - 1;
  CAM.my = (e.clientY / innerHeight) * 2 - 1;
});
addEventListener('wheel', e => {
  CAM.tdist = Math.max(8.5, Math.min(17, CAM.tdist + e.deltaY * 0.008));
}, { passive: true });

/* ==================== ПРИВЯЗКА К ШИНЕ АГЕНТОВ ======================== */
/* Если сцена открыта с оркестратора (порт 8080) — события команды
   агентов побегут в журнал. Иначе молча пропускаем. */

try {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = m => {
    const ev = JSON.parse(m.data);
    const p = ev.payload || {};
    if (ev.type === 'task_received') log(`Задача агентам: ${p.prompt}`, 'hot');
    if (ev.type === 'agent_started') log(`${ev.agent} приступил к работе`);
    if (ev.type === 'tool_call') log(`${ev.agent}: ${p.label || p.tool}`);
    if (ev.type === 'task_done') { log('Агенты закончили — отчёт в Telegram', 'ok'); Snd.ding(); }
    if (ev.type === 'agent_error') { log(`${ev.agent}: сбой!`, 'err'); Snd.buzz && Snd.buzz(); }
  };
  ws.onerror = () => {};
} catch { /* без шины — просто интерактивная сцена */ }

/* ========================= ГЛАВНЫЙ ЦИКЛ ============================== */

document.getElementById('sound').addEventListener('click', e => Snd.toggle(e.target));

const fpsEl = document.getElementById('fps');
const objEl = document.getElementById('objcount');
let lastT = performance.now(), fpsAcc = 0, fpsN = 0, fpsAt = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  Machine.update(now);
  Anim.update(dt, now / 1000);

  // камера: мягкий параллакс за мышью + докат зума
  CAM.dist += (CAM.tdist - CAM.dist) * dt * 4;
  const wob = Math.sin(now / 6000) * 0.25;
  camera.position.x += ((CAM.mx * 2.6 + wob) - camera.position.x) * dt * 3;
  camera.position.y += ((CAM.base.y - CAM.my * 1.3) - camera.position.y) * dt * 3;
  camera.position.z += (CAM.dist - camera.position.z) * dt * 4;
  camera.lookAt(CAM.look);

  composer.render();

  // FPS-метр (по dt кадра)
  fpsAcc += dt; fpsN++;
  if (now - fpsAt > 500) {
    fpsEl.textContent = `${Math.round(fpsN / Math.max(0.001, fpsAcc))} fps`;
    objEl.textContent = `механизмов: ${world.mechanisms.children.length}`;
    fpsAcc = 0; fpsN = 0; fpsAt = now;
  }
}

// отладочный хук (и задел под роботов): window.M.world.agents и т.д.
window.M = { world, ACTIONS, Interact, Anim, Machine };

build()
  .then(() => requestAnimationFrame(loop))
  .catch(e => {
    console.error(e);
    document.querySelector('#loader div').textContent = 'авария в котельной: ' + e.message;
  });
