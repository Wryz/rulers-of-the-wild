// Dig (docs/M1-DESIGN.md §5.10, §4.13): strike-digs with a digging tool and hand-digs, the dirt policy (merge into a
// pile within pileMergeR, a new pile while fewer than maxPilesNear lie near, else the masked, set-back berm through
// terrain.raise), nav and cover updates, stakes un-anchored when their driven end is exposed.
//
// PLACEHOLDER (P05; P15 fills it): §1 gives this module no public signature; its API is internal to the verb package
// (strike.ts and index.ts are its callers), so P15 defines it with the module.
export {};
