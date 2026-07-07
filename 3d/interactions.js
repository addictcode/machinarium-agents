/*
 * interactions.js — интерактивность: raycasting, подсветка при наведении,
 * подсказка у курсора, клики. Механизм регистрируется с описанием из
 * scene-config.json; реакция на клик — функция-действие (см. scene.js).
 */

'use strict';

import * as THREE from 'three';
import { Snd } from './sounds.js';

const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();

export const Interact = {
  world: null,
  tooltip: null,
  registry: new Map(),   // root Group -> def {name, hint, onClick}
  hovered: null,

  init(world) {
    this.world = world;
    this.tooltip = document.getElementById('tooltip');
    const el = world.renderer.domElement;
    el.addEventListener('pointermove', e => this.onMove(e));
    el.addEventListener('pointerdown', e => this.onClick(e));
  },

  register(group, def) {
    group.traverse(o => { o.userData.iroot = group; });
    group.userData.iroot = group;
    this.registry.set(group, def);
  },

  /** Пустить луч и найти корневую группу интерактивного механизма. */
  pick(e) {
    const r = this.world.renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, this.world.camera);
    const hits = ray.intersectObjects([...this.registry.keys()], true);
    for (const h of hits) {
      let o = h.object;
      while (o && !this.registry.has(o.userData.iroot) && o.parent) o = o.parent;
      const root = h.object.userData.iroot;
      if (root && this.registry.has(root)) return root;
    }
    return null;
  },

  /** Подсветка: приподнимаем emissive у всех материалов группы. */
  setGlow(group, on) {
    if (group.userData.noGlow) return;   // роботы подсвечиваются своим состоянием
    group.traverse(o => {
      if (!o.isMesh || !o.material || !o.material.emissive) return;
      if (on) {
        if (o.userData.savedEmissive === undefined) {
          o.userData.savedEmissive = o.material.emissiveIntensity ?? 1;
          o.userData.savedColor = o.material.emissive.clone();
          // клонируем материал, чтобы не подсветить соседей с общим материалом
          o.userData.sharedMat = o.material;
          o.material = o.material.clone();
          o.material.emissive.set(0xffb45e);
          o.material.emissiveIntensity = Math.max(0.5, (o.userData.savedEmissive || 0) * 1.4);
        }
      } else if (o.userData.savedEmissive !== undefined) {
        o.material.dispose();
        o.material = o.userData.sharedMat;
        delete o.userData.savedEmissive;
        delete o.userData.savedColor;
        delete o.userData.sharedMat;
      }
    });
  },

  onMove(e) {
    const hit = this.pick(e);
    if (hit !== this.hovered) {
      if (this.hovered) this.setGlow(this.hovered, false);
      this.hovered = hit;
      if (hit) {
        this.setGlow(hit, true);
        Snd.click();
      }
      document.body.style.cursor = hit ? 'pointer' : 'default';
    }
    if (hit) {
      const def = this.registry.get(hit);
      this.tooltip.style.display = 'block';
      this.tooltip.style.left = e.clientX + 'px';
      this.tooltip.style.top = e.clientY + 'px';
      this.tooltip.textContent = def.hint || def.name || 'механизм';
    } else {
      this.tooltip.style.display = 'none';
    }
  },

  onClick(e) {
    const hit = this.pick(e);
    if (!hit) return;
    const def = this.registry.get(hit);
    if (def.onClick) def.onClick(hit, this.world);
  },
};
