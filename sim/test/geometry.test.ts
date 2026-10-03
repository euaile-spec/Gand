import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { exitLegFor, movementConflict, yieldsTo } from '../src/network/geometry.js';
import type { Movement } from '../src/model/types.js';

function mv(entry: 0 | 1 | 2 | 3, turn: 'L' | 'T' | 'R' | 'U'): Movement {
  return { key: `${entry}:${turn}`, fromLink: `in${entry}`, toLink: `out`, turn, entryLeg: entry, exitLeg: exitLegFor(entry, turn), length: 10, speed: 5 };
}

describe('exit legs', () => {
  it('maps turns to legs (right-hand traffic, clockwise legs)', () => {
    expect(exitLegFor(0, 'T')).toBe(2);
    expect(exitLegFor(0, 'L')).toBe(1);
    expect(exitLegFor(0, 'R')).toBe(3);
    expect(exitLegFor(0, 'U')).toBe(0);
  });
});

describe('conflicts', () => {
  it('through vs opposite through: none', () => expect(movementConflict(mv(0, 'T'), mv(2, 'T'))).toBe('none'));
  it('through vs cross through: cross', () => expect(movementConflict(mv(0, 'T'), mv(1, 'T'))).toBe('cross'));
  it('left vs opposite through: cross', () => expect(movementConflict(mv(0, 'L'), mv(2, 'T'))).toBe('cross'));
  it('left vs opposite left: none (they pass)', () => expect(movementConflict(mv(0, 'L'), mv(2, 'L'))).toBe('none'));
  it('right vs opposite left: merge (same exit)', () => expect(movementConflict(mv(0, 'R'), mv(2, 'L'))).toBe('merge'));
  it('right vs cross through from the left: merge', () => expect(movementConflict(mv(0, 'R'), mv(1, 'T'))).toBe('merge'));
  it('right vs cross through from the right: none', () => expect(movementConflict(mv(0, 'R'), mv(3, 'T'))).toBe('none'));
  it('u-turn vs opposite through: cross', () => expect(movementConflict(mv(0, 'U'), mv(2, 'T'))).toBe('cross'));
  it('same approach: none', () => expect(movementConflict(mv(0, 'L'), mv(0, 'T'))).toBe('none'));
});

describe('yield rules', () => {
  it('left yields to opposite through', () => {
    expect(yieldsTo(mv(0, 'L'), mv(2, 'T'), 'cross')).toBe(true);
    expect(yieldsTo(mv(2, 'T'), mv(0, 'L'), 'cross')).toBe(false);
  });
  it('priority to the right among throughs', () => {
    // approach 0 yields to approach 3 (on its right)
    expect(yieldsTo(mv(0, 'T'), mv(3, 'T'), 'cross')).toBe(true);
    expect(yieldsTo(mv(3, 'T'), mv(0, 'T'), 'cross')).toBe(false);
  });
});

describe('world build', () => {
  it('builds the tutorial map with movements at every node', () => {
    const w = buildWorld(tutorialMap(), 7);
    const centre = w.nodes['n11'];
    expect(centre.legs.length).toBe(4);
    // 4 approaches × 4 turns
    expect(Object.keys(centre.movements).length).toBe(16);
    expect(Object.keys(centre.peds).length).toBe(4);
    const arterialIn = centre.legs.find((l) => l.leg === 3)!.inLink!; // west leg inbound
    expect(w.links[arterialIn].lanes.filter((l) => l.type === 'general').length).toBe(2);
    // Lane ids are indexed
    for (const lane of Object.values(w.lanes)) expect(w.links[lane.linkId]).toBeDefined();
    // Every generator has a driveway
    for (const g of Object.values(w.generators)) {
      const link = w.links[g.drivewayLink];
      expect(link.driveways.some((d) => d.generatorId === g.id)).toBe(true);
    }
    expect(w.busRoutes['bus1'].links.length).toBe(6);
  });
  it('ped crossing on a leg hard-conflicts with that leg’s inbound movements only', () => {
    const w = buildWorld(tutorialMap(), 7);
    const n = w.nodes['n11'];
    const north = n.legs.find((l) => l.leg === 0)!.inLink!;
    expect(n.conflicts[`${north}:T`]['ped:0']).toBe('ped-hard');
    expect(n.conflicts[`${north}:T`]['ped:2']).toBe('ped-soft');
    expect(n.conflicts[`${north}:T`]['ped:1']).toBe('none');
  });
});
