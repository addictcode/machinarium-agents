/*
 * animations.js — реестр анимаций и мини-твины.
 *
 * Любой механизм регистрирует функцию update(dt, t) через Anim.add() —
 * главный цикл сцены дёргает их каждый кадр. Твины — для разовых
 * движений (рычаг, дверца): Anim.tween(...) с плавной кривой.
 */

'use strict';

export const Anim = {
  fns: new Set(),
  tweens: [],

  /** Постоянная анимация: fn(dt, t) каждый кадр. Возвращает отписку. */
  add(fn) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  },

  /**
   * Разовый твин: плавно гонит значение 0→1 за dur секунд и зовёт
   * apply(k). ease — 'smooth' (по умолчанию) | 'bounce'.
   */
  tween(dur, apply, { ease = 'smooth', done } = {}) {
    this.tweens.push({ t: 0, dur, apply, ease, done });
  },

  update(dt, t) {
    for (const fn of this.fns) fn(dt, t);
    for (const tw of this.tweens) {
      tw.t += dt;
      let k = Math.min(1, tw.t / tw.dur);
      if (tw.ease === 'smooth') k = k * k * (3 - 2 * k);
      else if (tw.ease === 'bounce') {
        const s = 1.70158;
        k = --k * k * ((s + 1) * k + s) + 1;
      }
      tw.apply(k);
      if (tw.t >= tw.dur && tw.done) tw.done();
    }
    this.tweens = this.tweens.filter(tw => tw.t < tw.dur);
  },
};

/** Глобальное состояние механики (турбо-режим и т.п.). */
export const Machine = {
  gearBoost: 1,          // множитель скорости всех шестерён
  boostUntil: 0,         // performance.now(), до какого момента турбо
  update(now) {
    const target = now < this.boostUntil ? 4 : 1;
    this.gearBoost += (target - this.gearBoost) * 0.06;
  },
};
