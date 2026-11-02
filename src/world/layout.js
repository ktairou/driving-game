// Hand-placed shape of the world. Units are metres; +x east, +z north.
// Four countries, each its own island, joined to Britain by bridges.

export const SEA_LEVEL = 0;
// Everything below is laid out at a smaller size and then stretched by this
// much (positions and distances only; heights and building sizes stay).
export const WORLD_SCALE = 1.4;
export const WORLD_LIMIT = 2700 * WORLD_SCALE; // invisible fence: the car can't go past this
export const ROAD_HALF_WIDTH = 5; // two 3.5 m lanes plus edge space
export const ROAD_SAMPLE_STEP = 2;
export const LANE_OFFSET = 1.9; // distance from the centre line to a lane's middle

// Helper: shift a list of points relative to an island centre.
const at = (cx, cz, pts) => pts.map(([x, z]) => [x + cx, z + cz]);

export const ISLANDS = [
  {
    id: "britain",
    name: "Britain",
    cx: 0,
    cz: 0,
    half: 860, // height grid covers centre ± half
    coast: 770, // rough distance from centre to the shore
    seed: 7,
    climate: "green",
    relief: 1,
    drive: "left",
    trees: { share: 0.4, firAbove: 30 },
    // One closed loop. The straight run of points at z = 0 is the main street.
    road: [
      [-470, 0], [-380, 0], [-290, 0], [-200, 0], [-110, 0],
      [0, 30], [110, 110], [230, 210], [370, 230], [480, 140],
      [520, -10], [470, -170], [360, -280], [200, -330], [60, -290],
      [-30, -200], [-140, -170], [-280, -230], [-430, -270], [-540, -200],
      [-580, -90], [-550, -20],
    ],
    towns: [
      { name: "Kingsford", cx: -290, cz: 0, hx: 190, hz: 70, street: { x0: -450, x1: -140, z: 0 }, style: "british" },
      { name: "Ashby", cx: 245, cz: -212, hx: 150, hz: 60, street: { x0: 110, x1: 385, z: -212 }, style: "british" },
    ],
    // Downloaded models ("model"): `size` is the height to stand them at (or
    // the width, with `fit: "width"`), `yaw` turns them, `plateau: false`
    // stops the ground being levelled under them (things standing in the sea).
    landmarks: [
      { type: "model", model: "bigben", name: "Big Ben", x: -228, z: 24, base: 18, size: 72, yaw: Math.PI },
      { type: "model", model: "stonehenge", name: "Stonehenge", x: -130, z: 200, base: 34, size: 34, fit: "width" },
      { type: "model", model: "towerbridge", name: "Tower Bridge", x: 60, z: 690, base: 70, size: 240, fit: "length", plateau: false, sea: true },
    ],
  },
  {
    id: "france",
    name: "France",
    cx: 1950,
    cz: 0,
    half: 720,
    coast: 640,
    seed: 21,
    climate: "green",
    relief: 0.6,
    drive: "right",
    trees: { share: 0.22, firAbove: 60 },
    road: at(1950, 0, [
      [-450, 0], [-360, 60], [-260, 60], [-160, 60], [-60, 60], [40, 60], [140, 60],
      [290, 40], [420, -60], [400, -220], [250, -330], [50, -370],
      [-150, -310], [-320, -210], [-440, -100],
    ]),
    towns: [
      { name: "Paris", cx: 1950 - 60, cz: 60, hx: 230, hz: 70, street: { x0: 1950 - 250, x1: 1950 + 130, z: 60 }, style: "paris" },
      { name: "Belleville", cx: 2075, cz: 300, hx: 140, hz: 55, street: { x0: 1960, x1: 2190, z: 300 }, style: "paris" },
    ],
    landmarks: [
      { type: "model", model: "eiffel", name: "Eiffel Tower", x: 1950 + 60, z: -170, base: 76, size: 190 },
      { type: "model", model: "arc", name: "Arc de Triomphe", x: 2150, z: 130, base: 34, size: 40 },
      { type: "model", model: "notredame", name: "Notre-Dame", x: 1780, z: -60, base: 60, size: 55, fit: "length" },
      { type: "model", model: "montstmichel", name: "Mont-Saint-Michel", x: 1600, z: 632, base: 120, size: 190, fit: "length", plateau: false, sea: true },
    ],
  },
  {
    id: "egypt",
    name: "Egypt",
    cx: 0,
    cz: -1950,
    half: 720,
    coast: 640,
    seed: 33,
    climate: "desert",
    relief: 0.35,
    drive: "right",
    trees: { share: 0.03, firAbove: 999 },
    road: at(0, -1950, [
      [-200, 440], [-100, 440], [0, 440], [100, 440], [200, 440],
      [360, 350], [450, 140], [410, -110], [260, -300], [50, -390],
      [-160, -350], [-340, -230], [-440, -30], [-390, 210], [-300, 380],
    ]),
    towns: [
      { name: "Al Nahr", cx: 0, cz: -1950 + 440, hx: 230, hz: 60, street: { x0: -190, x1: 190, z: -1950 + 440 }, style: "desert" },
      { name: "Al Wadi", cx: -285, cz: -1925, hx: 125, hz: 55, street: { x0: -390, x1: -180, z: -1925 }, style: "desert" },
    ],
    landmarks: [
      { type: "pyramid", name: "Pyramids", x: 70, z: -1950 + 10, base: 140, height: 92 },
      { type: "pyramid", x: -95, z: -1950 - 115, base: 110, height: 72 },
      { type: "pyramid", x: -185, z: -1950 - 205, base: 60, height: 40 },
      { type: "model", model: "abusimbel", name: "Abu Simbel", x: 250, z: -1700, base: 50, size: 45, fit: "width" },
    ],
  },
  {
    id: "usa",
    name: "USA",
    cx: -1950,
    cz: 0,
    half: 720,
    coast: 640,
    seed: 45,
    climate: "green",
    relief: 0.8,
    drive: "right",
    trees: { share: 0.35, firAbove: 20 },
    road: at(-1950, 0, [
      [450, 0], [430, 160], [340, 300], [200, 330], [70, 330], [-60, 330], [-190, 330],
      [-330, 260], [-440, 60], [-400, -160], [-260, -330], [-200, -370], [-100, -370], [0, -370], [100, -370],
      [170, -345], [330, -230], [430, -100],
    ]),
    towns: [
      { name: "Downtown", cx: -1950, cz: 330, hx: 230, hz: 80, street: { x0: -1950 - 180, x1: -1950 + 190, z: 330 }, style: "city" },
      { name: "Springfield", cx: -2000, cz: -370, hx: 150, hz: 55, street: { x0: -2130, x1: -1870, z: -370 }, style: "city" },
    ],
    landmarks: [
      { type: "model", model: "liberty", name: "Statue of Liberty", x: -1440, z: 330, base: 40, size: 70 },
      { type: "model", model: "empirestate", name: "Empire State Building", x: -2050, z: 278, base: 44, size: 190 },
      { type: "model", model: "rushmore", name: "Mount Rushmore", x: -2250, z: 100, base: 80, size: 150, fit: "width", hill: { h: 45, r: 150, dz: -100 } },
      // High on the north face of a hill south of Springfield (the hill is raised for it).
      { type: "hollywood", name: "Hollywood sign", x: -2850 / 1.4, z: -300 / 1.4, base: 110, plateau: false, hill: { h: 55, r: 170, dz: 45 } },
    ],
  },
];

// More roads inside each country. Each end joins an existing road (the
// nearest one built before it); a road may also cross a town's main street.
export const EXTRA_ROADS = [
  // Britain: a long northern road that runs through town, a road down the
  // middle, and one from the east that meets it.
  { id: "britainNorth", island: "britain", points: [[-280, -230], [-285, -150], [-290, -60], [-290, 0], [-290, 60], [-280, 140], [-230, 250], [-120, 340], [40, 380], [200, 350], [320, 290], [370, 230]] },
  { id: "britainMiddle", island: "britain", points: [[0, 30], [20, -60], [50, -160], [60, -290]] },
  { id: "britainEast", island: "britain", points: [[480, 140], [380, 60], [260, -20], [150, -90], [52, -125]] },
  { id: "britainSouth", island: "britain", points: [[56, -205], [90, -212], [160, -212], [240, -212], [320, -212], [390, -212], [428, -212]] },
  // France: an avenue through Paris and past the iron tower, and a road from the west.
  { id: "franceAvenue", island: "france", points: [[2240, 40], [2290, 160], [2240, 280], [2180, 300], [2100, 300], [2020, 300], [1940, 300], [1890, 250], [1880, 180], [1910, 60], [1910, -100], [1920, -250], [2000, -370]] },
  { id: "franceWest", island: "france", points: [[1630, -210], [1750, -180], [1860, -160], [1910, -150]] },
  // Egypt: a road out to the pyramids, and a desert road that meets it.
  { id: "egyptPyramids", island: "egypt", points: [[-60, -1510], [-50, -1700], [-10, -1850], [-20, -1980], [60, -2100], [150, -2210], [260, -2250]] },
  { id: "egyptDesert", island: "egypt", points: [[-440, -1980], [-400, -1928], [-330, -1925], [-250, -1925], [-170, -1925], [-90, -1900], [-20, -1862]] },
  // USA: two streets south from downtown, and a coast road to the north.
  { id: "usaSouth", island: "usa", points: [[-2010, 330], [-2010, 150], [-1950, 0], [-1850, -150], [-1800, -350]] },
  { id: "usaEast", island: "usa", points: [[-1830, 330], [-1800, 180], [-1650, 60], [-1520, -100]] },
  { id: "usaCoast", island: "usa", points: [[-1610, 300], [-1700, 450], [-1950, 500], [-2200, 450], [-2280, 260]] },
];

// Roads that join Britain to the other countries. Where they cross water
// they become bridges. The USA one is a big red suspension bridge.
export const CONNECTORS = [
  // Each starts and ends on a loop road's centre line (a T-junction).
  { id: "toFrance", from: "britain", to: "france", bridge: "beam", points: [[520, -10], [640, -6], [780, 0], [1050, 0], [1320, 0], [1440, 0], [1500, 0]] },
  { id: "toEgypt", from: "britain", to: "egypt", bridge: "beam", points: [[200, -330], [204, -450], [196, -640], [150, -900], [70, -1180], [30, -1400], [10, -1470], [0, -1510]] },
  { id: "toUSA", from: "britain", to: "usa", bridge: "suspension", points: [[-580, -90], [-690, -82], [-820, -60], [-1100, -30], [-1380, -8], [-1460, 0], [-1500, 0]] },
];

export const BRIDGE_DECK = { beam: 14, suspension: 22 };

// Where the car starts: west end of Britain's main street, facing east,
// in the left-hand lane (Britain drives on the left).
export const SPAWN = { x: -430, z: LANE_OFFSET, heading: Math.PI / 2 };

// --- Make the countries bigger ------------------------------------------------------
{
  const S = WORLD_SCALE;
  const stretch = (pts) => pts.forEach((p) => {
    p[0] *= S;
    p[1] *= S;
  });
  for (const isl of ISLANDS) {
    isl.cx *= S;
    isl.cz *= S;
    isl.half = Math.round(isl.half * S);
    isl.coast *= S;
    stretch(isl.road);
    for (const t of isl.towns) {
      t.cx *= S;
      t.cz *= S;
      t.hx *= S;
      t.hz *= S;
      t.street.x0 *= S;
      t.street.x1 *= S;
      t.street.z *= S;
      t.island = isl.id;
    }
    // (Still there for code that only needs a country's main town.)
    isl.town = isl.towns[0];
    for (const lm of isl.landmarks) {
      lm.x *= S;
      lm.z *= S;
    }
  }
  for (const r of EXTRA_ROADS) stretch(r.points);
  for (const c of CONNECTORS) stretch(c.points);
  SPAWN.x *= S; // (its z is the lane offset from the main street, which stays at 0)
}

// Every town in every country.
export const TOWNS = ISLANDS.flatMap((isl) => isl.towns);
