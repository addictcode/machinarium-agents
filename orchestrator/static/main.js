/*
 * main.js — MACHINARIUM: цельная 3D-котельная-мастерская + IDE.
 *
 * Мрачная ржаво-серая сцена в духе игры (ink-wash: зерно, виньетка,
 * десатурация), четыре робота-агента (Josef-стиль), которые постоянно
 * заняты — ходят по котельной, крутят шестерни, дёргают рычаги, а на
 * реальную задачу отыгрывают весь конвейер. Плюс встроенный чат с командой
 * (задачи без Telegram) и панель файлов, что создают агенты.
 *
 * Одна событийная схема (common/events.py) — фронт подписан на ту же шину.
 */

'use strict';

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { MAT, BUILDERS, buildRoom, SteamEmitter } from './3d/objects.js';
import { Anim, Machine } from './3d/animations.js';
import { Interact } from './3d/interactions.js';
import { Snd } from './3d/sounds.js';
import { RobotUnit } from './robots.js';
import { metalTexture, puffTexture, col } from './lib.js';

/* ========================= РЕНДЕР / СЦЕНА ========================== */

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.75;   // мрачно, но читаемо

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b160d);
scene.fog = new THREE.Fog(0x1b160d, 24, 58);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120);
const CAM = { base: new THREE.Vector3(0, 6.0, 17.5), look: new THREE.Vector3(0, 3.3, -1),
  dist: 17.5, tdist: 17.5, mx: 0, my: 0, focus: null, lookX: 0 };
camera.position.copy(CAM.base);

// тусклый холодный «подвальный» свет + тёплые лужицы от ламп/котла (в objects)
scene.add(new THREE.HemisphereLight(0x9a8d68, 0x161009, 0.85));
const sun = new THREE.DirectionalLight(0xffdca8, 1.5);
// тёплая заполняющая подсветка спереди-сверху, чтобы роботы читались из темноты
const fill = new THREE.DirectionalLight(0xcaac78, 0.95); fill.position.set(2, 9, 15); scene.add(fill);
sun.position.set(7, 15, 11); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 18, bottom: -6, near: 1, far: 60 });
scene.add(sun);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.6, 0.82);
composer.addPass(bloom);

// зерно + виньетка + лёгкая десатурация к серо-коричневому (ink-wash mood)
const GrainVignette = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, amount: { value: 0.075 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float amount; varying vec2 vUv;
    float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float g = dot(c.rgb, vec3(0.299,0.587,0.114));
      c.rgb = mix(c.rgb, vec3(g)*vec3(1.07,1.0,0.86), 0.26);      // приглушить цвет
      float n = rand(vUv*vec2(1280.0,720.0)+time)-0.5;
      c.rgb += n*amount;                                          // зерно плёнки
      vec2 d = vUv-0.5; float v = smoothstep(0.95, 0.15, dot(d,d)*1.9);
      c.rgb *= mix(0.72, 1.0, v);                                 // виньетка (мягче)
      gl_FragColor = c;
    }`,
};
const grainPass = new ShaderPass(GrainVignette);
composer.addPass(grainPass);

const world = { scene, camera, renderer, composer,
  mechanisms: new THREE.Group(), agents: new THREE.Group(), steamBurst: null, room: null };
scene.add(world.mechanisms); scene.add(world.agents);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h); composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

/* ============================== ЧАТ =============================== */

const chatLog = document.getElementById('chat-log');
function chatMsg(kind, who, text, html = false) {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  if (who) { const w = document.createElement('span'); w.className = 'who'; w.textContent = who; div.appendChild(w); }
  const body = document.createElement('span');
  if (html) body.innerHTML = text; else body.textContent = text;
  div.appendChild(body);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}
function linkify(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" class="filelink">$1</a>')
            .replace(/\*(.+?)\*/g, '<b>$1</b>');
}

async function sendTask(text) {
  chatMsg('user', 'ты', text);
  try {
    const r = await fetch('/api/task', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text }) });
    const { task_id } = await r.json();
    currentTask = task_id;
    chatMsg('sys', '', '🏭 команда взялась за задачу…');
  } catch (e) { chatMsg('sys', '', '⚠️ оркестратор недоступен: ' + e); }
}

const chatInput = document.getElementById('chat-input');
document.getElementById('chat-send').addEventListener('click', () => {
  const v = chatInput.value.trim(); if (v) { sendTask(v); chatInput.value = ''; chatInput.style.height = 'auto'; }
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('chat-send').click(); }
});
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(120, chatInput.scrollHeight) + 'px'; });

// сворачивание панелей
for (const btn of document.querySelectorAll('.fold')) btn.addEventListener('click', () => {
  const p = document.getElementById(btn.dataset.panel);
  p.classList.toggle('folded');
  btn.textContent = p.classList.contains('folded') ? '▸' : '▾';
});

/* ========================= ПАНЕЛЬ ФАЙЛОВ ========================== */

const fileList = document.getElementById('file-list');
const fileTask = document.getElementById('file-task');
const viewer = document.getElementById('viewer');
const ICONS = { html: '🌐', css: '🎨', js: '📜', py: '🐍', md: '📄', json: '🗂', txt: '📃' };

async function refreshFiles() {
  if (!currentTask) return;
  try {
    const data = await (await fetch('/api/files/' + currentTask)).json();
    if (!data.files.length) return;
    fileTask.textContent = 'задача ' + currentTask.slice(0, 8);
    fileList.innerHTML = '';
    for (const f of data.files) {
      const ext = f.name.split('.').pop();
      const li = document.createElement('li');
      li.innerHTML = `<span><span class="ic">${ICONS[ext] || '📄'}</span>${f.name}</span><span class="sz">${f.size} б</span>`;
      li.addEventListener('click', () => openFile(f.name));
      fileList.appendChild(li);
    }
  } catch { /* файлов пока нет */ }
}
async function openFile(name) {
  const url = '/files/' + currentTask + '/' + name;
  document.getElementById('viewer-name').textContent = name;
  const openBtn = document.getElementById('viewer-open');
  openBtn.href = url;
  openBtn.style.display = name.endsWith('.html') ? 'inline-block' : 'none';
  try { document.getElementById('viewer-body').textContent = await (await fetch(url)).text(); }
  catch { document.getElementById('viewer-body').textContent = '(не удалось загрузить)'; }
  viewer.classList.remove('hidden');
}
document.getElementById('viewer-close').addEventListener('click', () => viewer.classList.add('hidden'));

/* ======================= ПУЛЬТ + РЫЧАГ АГЕНТА ===================== */

const puffTex = puffTexture();
let currentTask = null;

function buildAgentPost(agent, x, z) {
  const g = new THREE.Group(); g.position.set(x, 0, z); world.scene.add(g);
  const c = col(agent.color || agent.accent || '#9a8a5a');
  const ac = col(agent.accent || '#a6863f');
  const bmat = new THREE.MeshStandardMaterial({ map: metalTexture(60 + Math.round(x * 3), agent.color || '#4a453b'), roughness: 0.85, metalness: 0.4 });
  const amat = new THREE.MeshStandardMaterial({ color: ac, roughness: 0.5, metalness: 0.75 });

  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.0, 0.8), bmat); desk.position.set(0, 0.5, -1.4); desk.castShadow = true; g.add(desk);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.14, 0.95), amat); top.position.set(0, 1.05, -1.4); g.add(top);
  // стойка-монитор
  const monMat = new THREE.MeshStandardMaterial({ color: 0x0c0f11, emissive: c, emissiveIntensity: 0.22 });
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.75, 0.08), monMat); monitor.position.set(0.55, 2.0, -1.6); monitor.rotation.x = -0.1; g.add(monitor);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0x000, emissive: ac, emissiveIntensity: 0.6 });
  const lines = [];
  for (let i = 0; i < 4; i++) { const ln = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.06), lineMat.clone()); ln.position.set(0.3, 2.22 - i * 0.12, -1.55); ln.rotation.x = -0.1; g.add(ln); lines.push(ln); }
  // шестерня-рукоятка на фронте тумбы (робот её «крутит»)
  const gearMesh = new THREE.Mesh(gearGeo(0.34, 10), amat); gearMesh.position.set(-0.62, 1.15, -1.0); g.add(gearMesh);
  gearMesh.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0x201a10 }))).position.set(0.24, 0, 0.1);
  // лампа-индикатор
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: c, emissiveIntensity: 0.3 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), lampMat); lamp.position.set(-0.72, 1.95, -1.5); g.add(lamp);
  const light = new THREE.PointLight(c, 0.45, 6.5, 1.9); light.position.set(0, 2.3, 0.2); g.add(light);

  // напольный рычаг сбоку — робот к нему ходит и дёргает
  const leverX = x + 1.55;
  const leverG = new THREE.Group(); leverG.position.set(1.55, 0, 0.2); g.add(leverG);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.28), bmat); base.position.y = 0.1; leverG.add(base);
  const arm = new THREE.Group(); arm.position.y = 0.14; leverG.add(arm);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.045, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x201a10 })); stick.position.y = 0.35; arm.add(stick);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), amat); knob.position.y = 0.72; arm.add(knob);
  arm.rotation.z = -0.5;

  const post = {
    group: g, robotPos: new THREE.Vector3(x, 0, z), robotFacing: 0,
    cableAnchor: new THREE.Vector3(x, 3.3, z - 0.7), active: false,
    leverX, gearMesh, leverArm: arm,
    setActive(on, cc) {
      post.active = on;
      monMat.emissiveIntensity = on ? 0.9 : 0.22;
      lampMat.emissiveIntensity = on ? 1.4 : 0.3;
      light.intensity = on ? 1.4 : 0.45;
      if (cc) { lampMat.emissive.copy(cc); light.color.copy(cc); monMat.emissive.copy(cc); }
    },
    update(dt, t, robot) {
      // шестерня крутится, когда робот «крутит» её или идёт задача
      const cranking = robot && robot.action === 'crank';
      gearMesh.rotation.z += dt * (cranking || post.active ? 4.5 : 0.5);
      // рычаг наклоняется, когда робот его «дёргает»
      const pulling = robot && robot.action === 'pull';
      const target = pulling ? -0.5 + Math.sin(t * 3 + x) * 0.5 : -0.5;
      arm.rotation.z += (target - arm.rotation.z) * 0.15;
      if (post.active) for (let i = 0; i < lines.length; i++) {
        lines[i].scale.x = 0.4 + Math.abs(Math.sin(t * 3 + i)) * 0.9;
        lines[i].material.emissiveIntensity = 0.4 + Math.abs(Math.sin(t * 4 + i * 1.3)) * 0.8;
      }
    },
  };
  return post;
}

function gearGeo(r, teeth) {
  const shape = new THREE.Shape(); const R = r * 1.18;
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2, a1 = ((i + 0.4) / teeth) * Math.PI * 2, a2 = ((i + 0.5) / teeth) * Math.PI * 2, a3 = ((i + 0.9) / teeth) * Math.PI * 2;
    for (const [a, rad] of [[a0, r], [a0 + 0.03, R], [a1, R], [a1 + 0.03, r], [a2, r], [a3, r]]) { const px = Math.cos(a) * rad, py = Math.sin(a) * rad; (i === 0 && a === a0) ? shape.moveTo(px, py) : shape.lineTo(px, py); }
  }
  shape.holes.push(new THREE.Path().absarc(0, 0, r * 0.22, 0, Math.PI * 2, true));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: r * 0.3, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
  geo.center(); return geo;
}

/* ==================== ПОВЕДЕНИЕ РОБОТА (занятость) ================ */
/* Робот бесконечно живёт: стоит и крутит рукоятку, иногда идёт к рычагу
   и дёргает его, потом возвращается. На реальной задаче — у пульта. */

class Behavior {
  constructor(unit, post) {
    this.u = unit; this.post = post;
    this.homeX = post.robotPos.x; this.leverX = post.leverX;
    this.mode = 'crank'; this.timer = 3 + Math.random() * 4;
  }
  _walk(x, dt) {
    const u = this.u, d = x - u.root.position.x, dir = Math.sign(d);
    if (Math.abs(d) > 0.06) {
      u.moving = true; u.action = null;
      u.root.position.x += dir * Math.min(Math.abs(d), dt * 1.3);
      u.root.rotation.y += ((dir > 0 ? -0.5 : 0.5) - u.root.rotation.y) * 0.12;
      return false;
    }
    u.moving = false; u.root.rotation.y += (0 - u.root.rotation.y) * 0.12;
    return true;
  }
  update(dt, t) {
    const u = this.u;
    if (u.state !== 'idle') {                 // реальная задача — у пульта
      if (this._walk(this.homeX, dt)) u.action = (u.state === 'thinking') ? null : 'crank';
      return;
    }
    this.timer -= dt;
    switch (this.mode) {
      case 'crank': u.action = 'crank'; if (this.timer <= 0) { this.mode = 'toLever'; } break;
      case 'toLever': if (this._walk(this.leverX, dt)) { this.mode = 'lever'; this.timer = 2.5 + Math.random() * 2; } break;
      case 'lever': u.action = 'pull'; if (this.timer <= 0) { this.mode = 'toHome'; } break;
      case 'toHome': if (this._walk(this.homeX, dt)) { this.mode = 'crank'; this.timer = 3 + Math.random() * 4; } break;
    }
  }
}

/* ===================== СБОРКА РОБОТОВ В СЦЕНЕ ===================== */

let robots = {}, posts = {}, robotList = [], behaviors = [], packets = [];
const META = {};
const emoji = a => (META[a] || {}).emoji || '⚙️';
const title = a => (META[a] || {}).title || a;

function buildAgents(agents, levels) {
  for (const r of robotList) world.scene.remove(r.root);
  for (const a in posts) world.scene.remove(posts[a].group);
  robots = {}; posts = {}; robotList = []; behaviors = [];
  const n = agents.length, step = Math.min(4.8, 16 / n);
  agents.forEach((agent, i) => {
    META[agent.name] = agent;
    const x = (i - (n - 1) / 2) * step, z = 4.4;
    const post = buildAgentPost(agent, x, z);
    const r = new RobotUnit(world.scene, agent, post);
    r.setLevel(levels[agent.name] || 0);
    posts[agent.name] = post; robots[agent.name] = r; robotList.push(r);
    r.behavior = new Behavior(r, post);   // поведение живёт внутри робота
    behaviors.push(r.behavior);
    r.root.userData.noGlow = true;
    Interact.register(r.root, { name: agent.title, hint: `${agent.title}: ожидание`,
      onClick: () => { CAM.focus = post.robotPos; Snd.click(); } });
  });
  document.getElementById('loader').classList.add('done');
}

/* ===================== ПОСЫЛКА МЕЖДУ ПОСТАМИ ===================== */

function sendPacket(from, to) {
  const a = posts[from], b = posts[to]; if (!a || !b) return;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45),
    new THREE.MeshStandardMaterial({ color: 0xd9a850, emissive: 0xd98a30, emissiveIntensity: 1.5 }));
  const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0xd9a850, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
  gl.scale.set(1.6, 1.6, 1); mesh.add(gl); world.scene.add(mesh);
  packets.push({ mesh, from: a.cableAnchor.clone(), to: b.cableAnchor.clone(), t: 0 });
  Snd.whoosh();
}

/* ==================== СОБЫТИЯ → СЦЕНА + ЧАТ ====================== */

function robotHint(aid, s) { const r = robots[aid]; if (r) { const d = Interact.registry.get(r.root); if (d) d.hint = `${title(aid)}: ${s}`; } }

function handleEvent(ev) {
  if (ev.type === 'hello') { buildAgents(ev.agents, ev.levels); return; }
  const aid = ev.agent_id, r = aid ? robots[aid] : null, P = ev.payload || ev;
  if (ev.task_id) currentTask = ev.task_id;
  switch (ev.status) {
    case 'task_received':
      robotList.forEach(x => x.setState('idle')); CAM.focus = null; Snd.clank();
      if (!currentTaskShown) chatMsg('sys', '', '📋 принято: ' + (ev.output_preview || ''));
      break;
    case 'started':
      if (r) { r.setState('working'); CAM.focus = posts[aid].robotPos; robotHint(aid, 'работает'); }
      chatMsg('agent', `${emoji(aid)} ${title(aid)}`, ev.action || 'начал работу'); Snd.clank();
      break;
    case 'thinking': if (r) { r.setState('thinking'); robotHint(aid, 'думает'); } break;
    case 'tool_calling': {
      if (r) { r.setState('tool_call'); robotHint(aid, 'инструмент'); }
      if (ev.tool_name === 'file_write' && ev.tool_status === 'completed') {
        chatMsg('agent', `${emoji(aid)} ${title(aid)}`, '📄 ' + ev.action); refreshFiles();
      } else if (ev.tool_status === 'in_progress') {
        chatMsg('sys', '', `${emoji(aid)} ${title(aid)}: ⏳ ${ev.action || ev.tool_name}`);
      }
      Snd.tick(); break;
    }
    case 'working': if (r) { r.setState('working'); robotHint(aid, 'работает'); } break;
    case 'completed':
      if (r) { r.setState('success'); r.setLevel((ev.extra && ev.extra.level) || r.level + 1); robotHint(aid, 'готово'); }
      chatMsg('agent', `${emoji(aid)} ${title(aid)}`, '✓ ' + (ev.action || 'готово')); Snd.ding(); break;
    case 'error':
      if (r) { r.setState('error'); robotHint(aid, 'сбой'); }
      chatMsg('sys', '', `⚡ ${title(aid)}: ${ev.error_message || ev.action}`); Snd.buzz(); break;
    case 'handoff':
      if (ev.extra) sendPacket(ev.extra.from, ev.extra.to);
      chatMsg('sys', '', '📦 ' + ev.action); break;
    case 'task_done':
      robotList.forEach(x => x.setState('success'));
      setTimeout(() => robotList.forEach(x => x.setState('idle')), 3500);
      CAM.focus = null; Snd.fanfare();
      chatMsg('final', '📋 отчёт команды', linkify(ev.full_output || 'готово'), true);
      refreshFiles(); currentTaskShown = false; break;
    case 'task_error':
      robotList.forEach(x => x.setState('idle'));
      chatMsg('sys', '', '💥 ' + (ev.error_message || 'задача упала')); currentTaskShown = false; break;
  }
}
let currentTaskShown = false;

/* ======================= КОТЕЛЬНАЯ (клик) ======================= */

const ACTIONS = {
  gearKick(g) { g.userData.speedMul = 7; Anim.tween(1.6, k => { g.userData.speedMul = 7 - 6 * k; }); Snd.clank(); },
  lampToggle(g) { const pal = [0xffd98e, 0xff8a5a, 0x9fdc8a, 0x8ab8ff]; const i = g.userData.pi = ((g.userData.pi ?? 0) + 1) % pal.length; const c = new THREE.Color(pal[i]); g.userData.bulbMat.emissive.set(c); if (g.userData.light) g.userData.light.color.set(c); Snd.ding(); },
  valveBurst(g) { g.userData.spin(true); const p = new THREE.Vector3(); g.getWorldPosition(p); world.steamBurst(p, 16); Snd.hiss(); },
  turbo(g) { g.userData.flip(); const on = g.userData.on; Machine.boostUntil = on ? performance.now() + 7000 : 0; Snd.clank(); if (on) Snd.hiss(); Anim.tween(0.6, k => { bloom.strength = on ? 0.38 + k * 0.34 : 0.72 - k * 0.34; }); },
  ventKick(g) { g.userData.flip(); for (const s of world.room.steamers) s.burst(10); Snd.hiss(); },
  tankStorm(g) { g.userData.storm(); Snd.bubble(); },
  cabinetToggle(g) { g.userData.toggleDoor(); Snd.creak(); },
  ventBurst(g) { if (g.userData.steam) g.userData.steam.burst(20); Snd.hiss(); },
};

async function buildEnvironment() {
  MAT.init();
  world.room = buildRoom(world);
  const burster = new SteamEmitter(scene, new THREE.Vector3(0, -999, 0), { rate: 0 });
  burster.active = false;
  world.steamBurst = (pos, n) => { burster.pos.copy(pos); burster.burst(n); };
  world.room.steamers.push(burster);
  try {
    const cfg = await (await fetch('3d/scene-config.json')).json();
    for (const item of cfg.mechanisms) {
      const b = BUILDERS[item.type]; if (!b) continue;
      const g = b(item, world);
      if (item.pos) g.position.set(...item.pos);
      if (item.rot) g.rotation.set(...item.rot);
      g.userData.speedMul = g.userData.speedMul ?? 1;
      world.mechanisms.add(g);
      if (item.type === 'vent') world.room.steamers.push(g.userData.initSteam(scene));
      if (item.action && ACTIONS[item.action]) Interact.register(g, { name: item.name, hint: item.hint, onClick: (grp, w) => ACTIONS[item.action](grp, w) });
    }
  } catch (e) { console.warn('механизмы не загрузились:', e); }
  Interact.init(world);
}

/* ==================== КАМЕРА / ЗУМ / ЦИКЛ ======================= */

addEventListener('pointermove', e => { CAM.mx = (e.clientX / innerWidth) * 2 - 1; CAM.my = (e.clientY / innerHeight) * 2 - 1; });
addEventListener('wheel', e => { CAM.tdist = Math.max(10, Math.min(30, CAM.tdist + e.deltaY * 0.01)); }, { passive: true });
document.getElementById('sound').addEventListener('click', e => { Snd.toggle(e.target); e.target.textContent = Snd.on ? '🔊' : '🔇'; });

function updateCamera(dt, now) {
  CAM.dist += (CAM.tdist - CAM.dist) * dt * 4;
  const fx = CAM.focus ? CAM.focus.x : 0, wob = Math.sin(now / 8000) * 0.35;
  camera.position.x += ((fx * 0.5 + CAM.mx * 3.2 + wob) - camera.position.x) * dt * 2.2;
  camera.position.y += ((CAM.base.y - CAM.my * 1.5) - camera.position.y) * dt * 2.2;
  camera.position.z += (CAM.dist - camera.position.z) * dt * 3;
  CAM.lookX += ((CAM.focus ? CAM.focus.x : 0) - CAM.lookX) * dt * 2;
  CAM.look.x = CAM.lookX; camera.lookAt(CAM.look);
}

const fpsEl = document.getElementById('fps');
let lastT = performance.now(), fpsAcc = 0, fpsN = 0, fpsAt = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const t = now / 1000;
  Machine.update(now); Anim.update(dt, t);
  for (const r of robotList) r.update(dt, t);   // поведение вызывается внутри update
  for (const a in posts) posts[a].update(dt, t, robots[a]);
  for (const p of packets) {
    p.t += dt / 1.5; const k = Math.min(1, p.t);
    p.mesh.position.lerpVectors(p.from, p.to, k); p.mesh.position.y += Math.sin(k * Math.PI) * 2.6;
    p.mesh.rotation.x += dt * 4; p.mesh.rotation.y += dt * 5;
    if (p.t >= 1) { world.scene.remove(p.mesh); Snd.clank(); }
  }
  packets = packets.filter(p => p.t < 1);
  grainPass.uniforms.time.value = (now % 10000) / 1000;
  updateCamera(dt, now);
  composer.render();
  fpsAcc += dt; fpsN++;
  if (now - fpsAt > 500) { fpsEl.textContent = Math.round(fpsN / Math.max(0.001, fpsAcc)) + ' fps'; fpsAcc = 0; fpsN = 0; fpsAt = now; }
}

/* ===================== ДЕМО / WEBSOCKET ========================= */

const DEMO_AGENTS = [
  { name: 'manager', title: 'Менеджер', emoji: '🔵', color: '#3f4a57', accent: '#7d93b0', builder: 'manager' },
  { name: 'analyst', title: 'Аналитик', emoji: '🟢', color: '#414b3c', accent: '#7f9a5f', builder: 'analyst' },
  { name: 'developer', title: 'Разработчик', emoji: '🔴', color: '#5a3d33', accent: '#b06a3a', builder: 'developer' },
  { name: 'reviewer', title: 'Ревьюер', emoji: '🟣', color: '#48414f', accent: '#9a86b0', builder: 'reviewer' },
];
let demoTimer = null;
function startDemo() {
  if (demoTimer) return;
  buildAgents(DEMO_AGENTS, {});
  chatMsg('sys', '', '🎬 демо-режим: показываю сценарий (можешь писать задачи — подключусь к живой команде)');
  const E = (status, agent_id, x = {}) => ({ status, agent_id, ...x });
  const S = [
    E('task_received', null, { output_preview: 'Сделай лендинг для кофейни' }),
    E('started', 'manager', { action: 'координирует команду' }), E('thinking', 'manager'),
    E('tool_calling', 'manager', { tool_name: 'file_write', tool_status: 'completed', action: 'сохранил 00_plan.md' }),
    E('completed', 'manager', { action: 'план готов', extra: { level: 1 } }),
    E('handoff', null, { action: 'manager → analyst: задание', extra: { from: 'manager', to: 'analyst' } }),
    E('started', 'analyst', { action: 'начал анализ' }),
    E('tool_calling', 'analyst', { tool_name: 'web_search', tool_status: 'in_progress', action: 'ищет конкурентов' }),
    E('completed', 'analyst', { action: 'анализ готов', extra: { level: 1 } }),
    E('handoff', null, { action: 'analyst → developer: данные', extra: { from: 'analyst', to: 'developer' } }),
    E('started', 'developer', { action: 'пишет код' }),
    E('tool_calling', 'developer', { tool_name: 'file_write', tool_status: 'completed', action: 'сохранил index.html (1926 б)' }),
    E('tool_calling', 'developer', { tool_name: 'file_write', tool_status: 'completed', action: 'сохранил styles.css (3609 б)' }),
    E('error', 'developer', { error_message: 'перегрев (демо)' }),
    E('completed', 'developer', { action: 'создано файлов: 2', extra: { level: 1 } }),
    E('handoff', null, { action: 'developer → reviewer: артефакт', extra: { from: 'developer', to: 'reviewer' } }),
    E('started', 'reviewer', { action: 'проверяет' }), E('working', 'reviewer'),
    E('completed', 'reviewer', { action: 'ревью готово', extra: { level: 1 } }),
    E('task_done', null, { full_output: '📋 демо-отчёт: лендинг готов. Открой панель FILES слева.' }),
  ];
  let i = 0; demoTimer = setInterval(() => { handleEvent(S[i]); i = (i + 1) % S.length; }, 2400);
}

let gotHello = false, demoStarted = false;
function connect() {
  let ws; try { ws = new WebSocket(`ws://${location.host}/ws`); } catch { if (!demoStarted) { demoStarted = true; startDemo(); } return; }
  ws.onopen = () => { const c = document.getElementById('conn'); c.textContent = 'на связи'; c.className = 'ok'; };
  ws.onmessage = m => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'hello') { gotHello = true; for (const a of ev.agents) META[a.name] = a; if (demoTimer) { clearInterval(demoTimer); demoTimer = null; chatLog.innerHTML = ''; chatMsg('sys', '', '⚙️ команда на связи. Опиши задачу ниже.'); } }
    handleEvent(ev);
  };
  ws.onclose = () => { const c = document.getElementById('conn'); c.textContent = 'переподключение…'; c.className = 'err'; if (!gotHello && !demoStarted) { demoStarted = true; startDemo(); } setTimeout(connect, 2000); };
}

/* ============================ СТАРТ ============================= */

(async () => {
  try { await Promise.race([Promise.all([document.fonts.load("30px 'Rye'"), document.fonts.load("30px 'Neucha'")]), new Promise(r => setTimeout(r, 1500))]); } catch {}
  await buildEnvironment();
  if (new URLSearchParams(location.search).has('demo')) startDemo(); else connect();
  requestAnimationFrame(loop);
})();

window.M = { world, handleEvent, CAM, Snd,
  getRobots: () => robotList, getRobot: n => robots[n],
  getBehaviors: () => behaviors,
  stopDemo: () => { if (demoTimer) { clearInterval(demoTimer); demoTimer = null; } } };
