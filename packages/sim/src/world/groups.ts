// Collision and solver groups (docs/M1-DESIGN.md §2.11). A Rapier InteractionGroups value is (membership << 16) |
// filter; two colliders interact when each one's membership is in the other's filter (MAP rapier §4.1).
//
// Every collider's solver membership is its own bit only: an entity whose solver membership is "all bits" makes a
// falling log stop dead on the player's capsule (C lab e6_kcc, F4). These are bit layouts, not starting values, so
// they are code, not tuning.

/** Group bits (memberships). */
export const GROUP = {
  /** Heightfield tiles. */
  TERRAIN: 0x001,
  /** Every entity (fixed, anchored, free). */
  ENTITY: 0x002,
  /** KCC capsules (kinematic). */
  CHAR: 0x004,
  /** Standing player/ape zones (sensors). */
  ZONE: 0x008,
  /** The standing ruler's bone zones (sensors). */
  RULER_ZONE: 0x010,
  /** The tripped ruler's solid bone colliders. */
  RULER_SOLID: 0x020,
  /** Downed and launched slabs. */
  DOWNED: 0x040,
  /** Rope sensor capsules. */
  ROPE: 0x080,
} as const;

export type GroupName = keyof typeof GROUP;

const { TERRAIN, ENTITY, CHAR, ZONE, RULER_ZONE, RULER_SOLID, DOWNED, ROPE } = GROUP;

/** An InteractionGroups value: membership in the high 16 bits, filter in the low 16 (an unsigned 32-bit number). */
export function G(member: number, filter: number): number {
  return (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** Which groups each group's colliders meet at all (contacts, events, queries). */
export const COLLIDES_WITH: Readonly<Record<GroupName, number>> = {
  TERRAIN: ENTITY | CHAR | RULER_SOLID | DOWNED,
  ENTITY: TERRAIN | ENTITY | CHAR | ZONE | RULER_ZONE | RULER_SOLID | DOWNED | ROPE,
  CHAR: TERRAIN | ENTITY | RULER_SOLID,
  // Not ZONE: player-ape body contacts never score (melee is CombatSim's).
  ZONE: ENTITY | RULER_ZONE | RULER_SOLID | ROPE,
  // Not TERRAIN: the standing ruler's feet stand in the ground (MAP gap-3 §3.1); DOWNED so it can stomp a downed player.
  RULER_ZONE: ENTITY | ZONE | DOWNED | ROPE,
  RULER_SOLID: TERRAIN | ENTITY | CHAR | ZONE | DOWNED | ROPE,
  // Standing KCCs walk through slabs (DS, combat.ts separate()).
  DOWNED: TERRAIN | ENTITY | RULER_ZONE | RULER_SOLID | DOWNED | ROPE,
  ROPE: ENTITY | ZONE | RULER_ZONE | RULER_SOLID | DOWNED,
};

/** Which groups each group's colliders exchange solver forces with (0 for sensors). */
export const SOLVES_WITH: Readonly<Record<GroupName, number>> = {
  TERRAIN: ENTITY | CHAR | RULER_SOLID | DOWNED,
  ENTITY: TERRAIN | ENTITY | RULER_SOLID | DOWNED,
  // A falling log passes through the capsule and reaches the player through the zones (MAP rapier §4.2).
  CHAR: TERRAIN,
  ZONE: 0,
  RULER_ZONE: 0,
  // The KCC stands on the tripped ruler but never pushes 14 t.
  RULER_SOLID: TERRAIN | ENTITY | DOWNED,
  DOWNED: TERRAIN | ENTITY | RULER_SOLID | DOWNED,
  ROPE: 0,
};

/** The collision groups of a collider of group `g`. */
export function collisionGroups(g: GroupName): number {
  return G(GROUP[g], COLLIDES_WITH[g]);
}

/** The solver groups of a collider of group `g` (its own bit only as membership). */
export function solverGroups(g: GroupName): number {
  return G(GROUP[g], SOLVES_WITH[g]);
}

/**
 * A fresh broken piece (§4.10): an ENTITY whose collision filter drops CHAR, ZONE, RULER_ZONE, RULER_SOLID and DOWNED
 * while its grace lasts, so it ignores its breaker and every fighter until it is clear.
 */
export function pieceGraceCollisionGroups(): number {
  return G(ENTITY, COLLIDES_WITH.ENTITY & ~(CHAR | ZONE | RULER_ZONE | RULER_SOLID | DOWNED));
}

/** The filter a KCC sweep passes (§4.2): it meets terrain, entities and the tripped ruler, never sensors. */
export function kccQueryGroups(): number {
  return G(CHAR, TERRAIN | ENTITY | RULER_SOLID);
}
