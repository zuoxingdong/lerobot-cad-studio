/* The recorded run on one clock: poses the movers from the rps/run@1 tracks, evaluates the edit's
   camera path (MuJoCo free-camera convention, +Z up) and the robot cameras, and answers the edit's
   captions, insets and chapters at a time t. */
import * as THREE from 'three';
import { Looks } from './showcase-looks.js';

const FADE = 0.35;
const smooth = (x) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _sh = new THREE.Matrix4(), _e = new THREE.Euler();
// per-frame scratch rows
const NO_SHEAR = [0, 0], _sz = [0, 0, 0, 0], _shr = [0, 0, 0, 0], _col = [0, 0, 0, 0], _cam = new Array(10), _r0 = new Array(7), _r1 = new Array(7);

/** size -> unit-mesh scale, per MuJoCo primitive */
function primScale(type, s, out) {
  if (type === 'cylinder') return out.set(s[0], s[0], s[1]);
  if (type === 'sphere') return out.set(s[0], s[0], s[0]);
  return out.set(s[0], s[1], s[2]);
}

export class Player {
  /** run: the manifest's run block; tracks: decodeRun(); movers: [{obj, info}] */
  constructor(run, tracks, movers, tint) {
    this.run = run;
    this.T = tracks;
    this.fps = run.fps;
    this.frames = run.frames;
    this.duration = (run.frames - 1) / run.fps;
    this.edit = run.edit;
    this.tint = tint;
    this.cuts = this.edit.shots.map((s) => s.t).filter((t) => t > 0);
    this.inv0 = [];
    for (let k = 0; k < tracks.pose.n; k++) this.inv0.push(this.pose(k, 0, 0, new THREE.Matrix4()).invert());
    this.movers = movers.map(({ obj, info }) => this.bind(obj, info));
  }

  bind(obj, info) {
    const g = this.run.geoms[String(info.g)] || {};
    obj.updateMatrix();
    const D = obj.matrix.clone();
    obj.matrixAutoUpdate = false;
    const b = { obj, info, g, D, A: null };
    if (!info.prim && g.pose !== undefined) b.A = this.inv0[g.pose].clone().multiply(D);
    if (info.prim) { b.row0 = this.run.frame0[String(info.g)]; b.size0 = b.row0.slice(9, 12); }
    if (g.color !== undefined && (info.tint || obj.material.userData.objectColor)) b.paint = true;
    return b;
  }

  /** frame index and blend at t */
  at(t) {
    const f = Math.min(Math.max(t * this.fps, 0), this.frames - 1);
    const i = Math.min(Math.floor(f), this.frames - 2);
    return [i, f - i];
  }

  row(block, k, i, a, out) {
    const { F, C, data } = block, o = (k * F + i) * C;
    for (let c = 0; c < C; c++) out[c] = data[o + c] + (data[o + C + c] - data[o + c]) * a;
    return out;
  }

  /** pose track k at frame i + a as a Matrix4 (quaternions nlerped; the writer keeps them continuous) */
  pose(k, i, a, out) {
    const { F, data } = this.T.pose, o = (k * F + i) * 7;
    const b = a > 0 ? o + 7 : o;
    _p.set(data[o] + (data[b] - data[o]) * a, data[o + 1] + (data[b + 1] - data[o + 1]) * a, data[o + 2] + (data[b + 2] - data[o + 2]) * a);
    _q.set(data[o + 4], data[o + 5], data[o + 6], data[o + 3]);
    if (a > 0) { _q2.set(data[b + 4], data[b + 5], data[b + 6], data[b + 3]); _q.slerp(_q2, a); }
    return out.compose(_p, _q.normalize(), _s.set(1, 1, 1));
  }

  apply(t) {
    const [i, a] = this.at(t);
    for (const b of this.movers) {
      const { obj, info, g } = b;
      if (info.prim) {
        this.pose(g.pose, i, a, obj.matrix);
        const sz = g.size !== undefined ? this.row(this.T.size, g.size, i, a, _sz) : b.size0;
        const sh = g.shear !== undefined ? this.row(this.T.shear, g.shear, i, a, _shr) : NO_SHEAR;
        _sh.set(1, 0, 0, 0, 0, 1, 0, 0, sh[0], sh[1], 1, 0, 0, 0, 0, 1);
        primScale(info.prim, sz, _s);
        obj.matrix.multiply(_sh).multiply(_m.makeScale(_s.x, _s.y, _s.z)).multiply(b.D);
      } else if (b.A) {
        this.pose(g.pose, i, a, obj.matrix).multiply(b.A);
      }
      if (b.paint) {
        const c = this.row(this.T.color, g.color, i, 0, _col);
        Looks.paint(obj.material, c, c[3], info.tint ? (obj.material.userData.tint || this.tint) : null);
      }
      obj.matrixWorldNeedsUpdate = true;
    }
  }

  /** the edit's camera at t onto a PerspectiveCamera; fovy widens below 16:9 to keep the width */
  camera(t, cam) {
    let [i, a] = this.at(t);
    const t0 = i / this.fps, t1 = (i + 1) / this.fps;
    const cut = this.cuts.find((c) => c > t0 && c <= t1);
    if (cut !== undefined) { if (t >= cut) { i += 1; } a = 0; }
    const r = this.row(this.T.camera, 0, Math.min(i, this.frames - 2), a, _cam);
    if (i >= this.frames - 1) this.row(this.T.camera, 0, this.frames - 2, 1, r);
    const az = r[3] * Math.PI / 180, el = r[4] * Math.PI / 180, d = r[5];
    const f = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
    cam.up.set(0, 0, 1);
    cam.position.set(r[0] - d * f[0], r[1] - d * f[1], r[2] - d * f[2]);
    cam.lookAt(r[0], r[1], r[2]);
    const base = this.run.camera_aspect || 16 / 9;
    const tanv = Math.tan(r[6] * Math.PI / 360) * Math.max(1, base / cam.aspect);
    cam.fov = 2 * Math.atan(tanv) * 180 / Math.PI;
    cam.updateProjectionMatrix();
    return { target: new THREE.Vector3(r[0], r[1], r[2]), focus: r[7], fstop: r[8], lens: r[9] };
  }

  /** robot camera n (MuJoCo frame: -Z forward, +Y up, like three's) at t */
  robotCamera(n, t, cam) {
    const [i, a] = this.at(t);
    const r = this.row(this.T.rcams, n, i, 0, _r0), r1 = this.row(this.T.rcams, n, i + 1, 0, _r1);
    cam.position.set(r[0] + (r1[0] - r[0]) * a, r[1] + (r1[1] - r[1]) * a, r[2] + (r1[2] - r[2]) * a);
    _q.set(r[4], r[5], r[6], r[3]);
    _q2.set(r1[4], r1[5], r1[6], r1[3]);
    cam.quaternion.copy(_q.slerp(_q2, a).normalize());
    const c = this.run.cameras[n];
    cam.fov = c.fovy;
    cam.near = c.near;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  /** out = body `name`'s motion from frame 0 at t (frame-0 world -> world), or false */
  ride(name, t, out) {
    const k = (this.run.bodies || {})[name];
    if (k === undefined) return false;
    const [i, a] = this.at(t);
    this.pose(k, i, a, out).multiply(this.inv0[k]);
    return true;
  }

  /** the base's pose at t: {x, y, yaw} for the contact shadow */
  base(t) {
    const k = (this.run.bodies || {}).base;
    if (k === undefined) return null;
    const [i, a] = this.at(t);
    this.pose(k, i, a, _m);
    const e = _e.setFromRotationMatrix(_m, 'ZYX');
    _p.setFromMatrixPosition(_m);
    return { x: _p.x, y: _p.y, yaw: e.z };
  }

  captions(t) {
    const out = [];
    for (const c of this.edit.captions) {
      const [a, b] = c.t;
      if (t < a || t >= b) continue;
      let line2 = '';
      if (c.clock === 'incubation' && this.edit.incubation.t0 !== null) {
        const inc = this.edit.incubation, m = inc.modelled_s;
        const s = m * Math.min(1, Math.max(0, (t - inc.t0) / inc.run));
        const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(Math.floor(s % 60)).padStart(2, '0');
        line2 = `modelled time ${mm}:${ss} / ${String(Math.floor(m / 60)).padStart(2, '0')}:00`;
      }
      out.push({ kicker: c.kicker, text: c.text, line2, alpha: smooth(Math.min(t - a, b - t) / FADE) });
    }
    return out;
  }

  /** the edit's inset at t: {cam index, name, alpha} or null */
  pip(t) {
    for (const p of this.edit.pips) {
      if (t >= p.t[0] && t < p.t[1]) {
        const n = this.run.cameras.findIndex((c) => c.name === p.cam);
        return n < 0 ? null : { n, name: p.cam, alpha: smooth(Math.min(t - p.t[0], p.t[1] - t) / FADE) };
      }
    }
    return null;
  }

  chapter(t) {
    let k = 0;
    this.edit.shots.forEach((s, j) => { if (s.t <= t + 1e-6) k = j; });
    return k;
  }

  /** the run's fade: 0 black .. 1 clear */
  fade(t) {
    const f = this.edit.fade;
    return Math.min(smooth(t / f.fade_in), smooth((f.fade_out_at - t) / f.fade_out));
  }
}
