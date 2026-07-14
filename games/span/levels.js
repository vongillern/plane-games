// Span — level definitions. Pure data, no DOM.
// y grows downward; the deck baseline is y = 0 (left cliff top).
// gap: width of the void; right cliff starts at x = gap.
// floorY: canyon floor (visual ground + build depth limit).
// extraAnchors: additional fixed points (tower tops, high cliff-face anchors).
// pillars: mid-gap piers; each contributes a fixed anchor at its top.

function lvl(o) {
  return Object.assign({
    leftTop: 0, rightTop: 0,
    extraAnchors: [], pillars: [],
    vehicle: 'car', vehicles: 1, vehicleGap: 3.2,
    floorY: 5,
  }, o);
}

export const LEVELS = [
  lvl({
    name: 'First Span', intro: 'Drag from one anchor to the other to lay road.',
    gap: 2, budget: 40, floorY: 3.5,
  }),
  lvl({
    name: 'The Sag', intro: 'A flat deck sags. Brace it with wood from below.',
    gap: 6, budget: 300, floorY: 4.5,
  }),
  lvl({
    name: 'Truss Me', intro: 'Triangles never wobble.',
    gap: 7, budget: 390, floorY: 5,
  }),
  lvl({
    name: 'Heavy Haul', intro: 'Steel carries three times the load of wood.',
    gap: 6, budget: 560, floorY: 4.5,
    vehicle: 'truck',
  }),
  lvl({
    name: 'Uphill', intro: 'Roads can slope. Climb as you cross.',
    gap: 6, budget: 330, floorY: 4.5,
    rightTop: -1,
  }),
  lvl({
    name: 'The Pier', intro: 'Two short spans beat one long one.',
    gap: 12, budget: 640, floorY: 5,
    pillars: [{ x: 6 }],
  }),
  lvl({
    name: 'High Wire', intro: 'Cables only pull — hang the deck from above.',
    gap: 7, budget: 300, floorY: 1,
    extraAnchors: [{ x: 0, y: -2.5, mast: true }, { x: 7, y: -2.5, mast: true }],
  }),
  lvl({
    name: 'Harp Strings', intro: 'Fan cables from the towers. Steel is too dear today.',
    gap: 10, budget: 430, floorY: 3.5,
    extraAnchors: [{ x: 0, y: -3.5, mast: true }, { x: 10, y: -3.5, mast: true }],
  }),
  lvl({
    name: 'Convoy', intro: 'Two cars, one bridge. It has to keep holding.',
    gap: 8, budget: 460, floorY: 5,
    vehicles: 2,
  }),
  lvl({
    name: 'The Span', intro: 'Everything you know: truss it, hang it, hold.',
    gap: 12, budget: 1130, floorY: 5.5,
    vehicle: 'truck',
    extraAnchors: [{ x: 0, y: -3, mast: true }, { x: 12, y: -3, mast: true }],
  }),
];

// Fixed anchor points for a level: the two cliff-edge deck anchors,
// pillar tops, then any extra anchors. Order matters (stable node ids).
export function levelAnchors(level) {
  const a = [
    { x: 0, y: level.leftTop },
    { x: level.gap, y: level.rightTop },
  ];
  for (const p of level.pillars) a.push({ x: p.x, y: 0 });
  for (const e of level.extraAnchors) a.push({ x: e.x, y: e.y });
  return a;
}
