// Navmesh input geometry (docs/M1-DESIGN.md §7): per tile, the terrain triangles of the tile's grown rect with the
// heightfield's own diagonal split, and every fixed, anchored or resting entity overlapping it (triangulated from its
// shape, in id order), with the ruler layer's blocker extrusion.
//
// PLACEHOLDER (P05; P12 fills it): §1 gives this module no public signature; its API is internal to the navigation
// package (nav.ts is its only caller), so P12 defines it with the module.
export {};
