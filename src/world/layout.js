// Hand-placed shape of the world. Units are metres; +x east, +z north.
// Four countries, each its own island, joined to Britain by bridges.

export const SEA_LEVEL = 0;
export const WORLD_LIMIT = 2700; // invisible fence: the car can't go past this
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
    town: { cx: -290, cz: 0, hx: 190, hz: 70, height: 8, street: { x0: -450, x1: -140, z: 0 }, style: "british" },
    landmarks: [{ type: "clockTower", x: -228, z: 24, base: 18 }],
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
    town: { cx: 1950 - 60, cz: 60, hx: 230, hz: 70, height: 10, street: { x0: 1950 - 250, x1: 1950 + 130, z: 60 }, style: "paris" },
    landmarks: [{ type: "ironTower", x: 1950 + 60, z: -170, base: 76 }],
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
    town: { cx: 0, cz: -1950 + 440, hx: 230, hz: 60, height: 6, street: { x0: -190, x1: 190, z: -1950 + 440 }, style: "desert" },
    landmarks: [
      { type: "pyramid", x: 70, z: -1950 + 10, base: 140, height: 92 },
      { type: "pyramid", x: -95, z: -1950 - 115, base: 110, height: 72 },
      { type: "pyramid", x: -185, z: -1950 - 205, base: 60, height: 40 },
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
      [-330, 260], [-440, 60], [-400, -160], [-260, -320], [-60, -380],
      [150, -350], [330, -230], [430, -100],
    ]),
    town: { cx: -1950, cz: 330, hx: 230, hz: 80, height: 9, street: { x0: -1950 - 180, x1: -1950 + 190, z: 330 }, style: "city" },
    landmarks: [],
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
  // France: an avenue through Paris and past the iron tower, and a road from the west.
  { id: "franceAvenue", island: "france", points: [[2240, 40], [2280, 160], [2150, 280], [1910, 300], [1880, 180], [1910, 60], [1910, -100], [1920, -250], [2000, -370]] },
  { id: "franceWest", island: "france", points: [[1630, -210], [1750, -180], [1860, -160], [1910, -150]] },
  // Egypt: a road out to the pyramids, and a desert road that meets it.
  { id: "egyptPyramids", island: "egypt", points: [[-60, -1510], [-50, -1700], [-10, -1850], [-20, -1980], [60, -2100], [150, -2210], [260, -2250]] },
  { id: "egyptDesert", island: "egypt", points: [[-440, -1980], [-330, -1940], [-200, -1890], [-20, -1862]] },
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
