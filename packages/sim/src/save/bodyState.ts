// The AC-7 body bytes (docs/M1-DESIGN.md §8.2): every Rapier body's raw f32 state in owner order, the rope sensors'
// poses, then the f64 bits of every fighter's core state and rig, then combat.rng.state. Two worlds built from one seed
// and fed one command log must give identical bytes every 60 ticks (AC-7, §11.7); the save (serializeWorld) is compared
// alongside, so this is the check of what a save holds as numbers rounded through Rapier.
//
// Layout (little-endian; each block is tagged with its owner, so a body one world has and the other hasn't shows as a
// difference at its own place rather than shifting everything after it):
// 1. entities with a body, by id: u8 1, u32 id, then the body (below);
// 2. fighters' bodies, by fighter id, then part (kcc, zone, slab, ruler): u8 2, u32 fighter id, u8 part (0-3), then the
//    body; a part made of several bodies writes each, by handle; a parentless fighter collider writes its collider pose
//    (u8 3, u32 fighter id, u8 part, its translation and rotation as f32), by bone;
// 3. rope sensors, by joint id: u8 4, u32 joint id, the collider's translation (3 f32) and rotation (4 f32) only (a
//    parentless collider has no body and no velocity, RF-22);
// 4. every fighter of the sim, by id: u8 5, u32 id, then f64 pos (3), vel (3), walkVel (3), yaw, hp, stamina,
//    stateFrame, its Rng's state, and its 12 rig joints in BONES order (position 3, quaternion 4);
// 5. u8 6, f64 combat.rng.state.
// A body: f32 translation (3), rotation (4), linvel (3), angvel (3), the values Rapier returns (exact f32s).
//
// Fighters' bodies are found through the physics world's collider → owner map (every collider is registered with its
// owner, §4.3), so this file needs nothing from the systems that own them.
import type RAPIER from '@dimforge/rapier3d-compat';
import { BONES } from '../body/skeleton';
import type { World } from '../world/world';

const TAG_ENTITY = 1;
const TAG_FIGHTER_BODY = 2;
const TAG_FIGHTER_COLLIDER = 3;
const TAG_ROPE = 4;
const TAG_FIGHTER = 5;
const TAG_COMBAT_RNG = 6;
const PARTS = ['kcc', 'zone', 'slab', 'ruler'] as const;

export function bodyStateBytes(w: World): Uint8Array {
  if (w.isDisposed) throw new Error('bodyStateBytes: the world was disposed');
  const out = new ByteWriter();

  // 1. Entities by id.
  for (const e of w.entities.all()) {
    if (!e.body) continue;
    out.u8(TAG_ENTITY);
    out.u32(e.id);
    writeBody(out, e.body);
  }

  // 2-3. Fighters' bodies and rope sensors, from the collider → owner map.
  const fighterBodies = new Map<string, Map<number, RAPIER.RigidBody>>();
  const fighterColliders = new Map<string, { bone: string; c: RAPIER.Collider }[]>();
  const fighterIds = new Set<number>();
  const ropes: { joint: number; c: RAPIER.Collider }[] = [];
  w.physics.rapier.forEachCollider((c) => {
    const o = w.physics.ownerOf(c.handle);
    if (!o) return;
    if (o.kind === 'rope') {
      ropes.push({ joint: o.joint, c });
      return;
    }
    if (o.kind !== 'fighter') return;
    fighterIds.add(o.id);
    const key = `${o.id}:${o.part}`;
    const b = c.parent();
    if (b) {
      let m = fighterBodies.get(key);
      if (!m) fighterBodies.set(key, (m = new Map()));
      m.set(b.handle, b);
    } else {
      let l = fighterColliders.get(key);
      if (!l) fighterColliders.set(key, (l = []));
      l.push({ bone: o.bone ?? '', c });
    }
  });
  for (const id of [...fighterIds].sort((a, b) => a - b)) {
    PARTS.forEach((part, pi) => {
      const key = `${id}:${part}`;
      const bodies = fighterBodies.get(key);
      if (bodies) {
        for (const h of [...bodies.keys()].sort((a, b) => a - b)) {
          out.u8(TAG_FIGHTER_BODY);
          out.u32(id);
          out.u8(pi);
          writeBody(out, bodies.get(h)!);
        }
      }
      const cols = fighterColliders.get(key);
      if (cols) {
        cols.sort((a, b) => (a.bone < b.bone ? -1 : a.bone > b.bone ? 1 : a.c.handle - b.c.handle));
        for (const { c } of cols) {
          out.u8(TAG_FIGHTER_COLLIDER);
          out.u32(id);
          out.u8(pi);
          writeColliderPose(out, c);
        }
      }
    });
  }
  ropes.sort((a, b) => a.joint - b.joint || a.c.handle - b.c.handle);
  for (const r of ropes) {
    out.u8(TAG_ROPE);
    out.u32(r.joint);
    writeColliderPose(out, r.c);
  }

  // 4. Every fighter's core state and rig, by id.
  for (const f of [...w.combat.fighters].sort((a, b) => a.id - b.id)) {
    out.u8(TAG_FIGHTER);
    out.u32(f.id);
    out.f64(f.pos.x);
    out.f64(f.pos.y);
    out.f64(f.pos.z);
    out.f64(f.vel.x);
    out.f64(f.vel.y);
    out.f64(f.vel.z);
    out.f64(f.walkVel.x);
    out.f64(f.walkVel.y);
    out.f64(f.walkVel.z);
    out.f64(f.yaw);
    out.f64(f.hp);
    out.f64(f.stamina);
    out.f64(f.stateFrame);
    out.f64(f.rngState);
    for (const b of BONES) {
      const j = f.rig[b];
      out.f64(j.pos.x);
      out.f64(j.pos.y);
      out.f64(j.pos.z);
      out.f64(j.rot.x);
      out.f64(j.rot.y);
      out.f64(j.rot.z);
      out.f64(j.rot.w);
    }
  }

  // 5. The sim's own Rng.
  out.u8(TAG_COMBAT_RNG);
  out.f64(w.combat.rng.state);
  return out.bytes();
}

function writeBody(out: ByteWriter, b: RAPIER.RigidBody): void {
  const t = b.translation();
  const r = b.rotation();
  const v = b.linvel();
  const a = b.angvel();
  out.f32(t.x);
  out.f32(t.y);
  out.f32(t.z);
  out.f32(r.x);
  out.f32(r.y);
  out.f32(r.z);
  out.f32(r.w);
  out.f32(v.x);
  out.f32(v.y);
  out.f32(v.z);
  out.f32(a.x);
  out.f32(a.y);
  out.f32(a.z);
}

function writeColliderPose(out: ByteWriter, c: RAPIER.Collider): void {
  const t = c.translation();
  const r = c.rotation();
  out.f32(t.x);
  out.f32(t.y);
  out.f32(t.z);
  out.f32(r.x);
  out.f32(r.y);
  out.f32(r.z);
  out.f32(r.w);
}

/** A growable little-endian byte buffer. */
class ByteWriter {
  private buf = new ArrayBuffer(4096);
  private view = new DataView(this.buf);
  private n = 0;

  u8(v: number): void {
    this.room(1);
    this.view.setUint8(this.n, v);
    this.n += 1;
  }

  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.n, v >>> 0, true);
    this.n += 4;
  }

  f32(v: number): void {
    this.room(4);
    this.view.setFloat32(this.n, v, true);
    this.n += 4;
  }

  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.n, v, true);
    this.n += 8;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.n).slice();
  }

  private room(k: number): void {
    if (this.n + k <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.n + k));
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.n));
    this.buf = next;
    this.view = new DataView(next);
  }
}
