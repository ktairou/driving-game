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
    fields: true, // patchwork farmland drawn on the flat ground (terrain.js)
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
      // Built in code (towerBridge.js): it carries the road to France across
      // the whole sea, from the British shore to the French one, with `pairs`
      // pairs of towers along it. x, z put the map label at its middle (the
      // game also moves them onto the road there).
      { type: "towerBridge", name: "Tower Bridge", road: "toFrance", pairs: 3, x: 1047, z: 0, base: 70, plateau: false, sea: true },
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
    fields: true,
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
// they become bridges. The USA one is a big red suspension bridge; the road to
// France crosses the sea on Tower Bridge (see the landmark above), from shore
// to shore.
export const CONNECTORS = [
  // Each starts and ends on a loop road's centre line (a T-junction).
  { id: "toFrance", from: "britain", to: "france", bridge: "beam", points: [[520, -10], [640, -6], [780, 0], [1050, 0], [1320, 0], [1440, 0], [1500, 0]] },
  { id: "toEgypt", from: "britain", to: "egypt", bridge: "beam", points: [[200, -330], [204, -450], [196, -640], [150, -900], [70, -1180], [30, -1400], [10, -1470], [0, -1510]] },
  { id: "toUSA", from: "britain", to: "usa", bridge: "suspension", points: [[-580, -90], [-690, -82], [-820, -60], [-1100, -30], [-1380, -8], [-1460, 0], [-1500, 0]] },
];

// Country roads: two-lane roads that wind between the towns, up into the hills
// and along the coasts. Unlike the roads above they are in world coordinates
// (not stretched by WORLD_SCALE), and they are built after the bridges, so
// each end can join any road above (a T-junction on its centre line; two
// ending at the same point make a crossroads). Their points were checked by
// tools/plan-roads.mjs for grades, bends and clearances.
export const COUNTRY_ROADS = [
  // Britain: over the southern hills from Kingsford's crossroads to the road to
  // Egypt, on round the south-east coast to the east of the loop; a west coast
  // road; and a road over the northern hills.
  { id: "britainHills", island: "britain", points: [[-392.45, -322.16], [-380.92, -355.2], [-373, -412], [-354, -466], [-325, -508], [-285, -539], [-232, -563], [-177, -579], [-122, -590], [-61, -597], [-6, -600], [45, -606], [94, -623], [135, -652], [173, -689], [214, -732], [247.93, -778.38], [282.9, -779.85]] },
  { id: "britainSouthEast", island: "britain", points: [[282.9, -779.85], [317.87, -781.33], [370, -754], [420, -728], [469, -697], [516, -666], [561, -638], [609, -609], [657, -577], [699, -541], [735, -499], [760, -450], [773, -397], [775, -342], [770, -291], [758, -237], [744, -186], [743.26, -130.61], [709.75, -120.52]] },
  { id: "britainWest", island: "britain", points: [[-368.89, 264.6], [-401.36, 277.69], [-447, 315], [-494, 345], [-543, 366], [-589, 374], [-642, 369], [-695, 352], [-745, 326], [-789, 294], [-822, 255], [-838, 209], [-839, 164], [-825, 112], [-803, 60], [-776.77, 9.68], [-759.6, -20.82]] },
  { id: "britainNorthHills", island: "britain", points: [[-245.6, 426.34], [-267.26, 453.83], [-310, 486], [-341, 523], [-353, 563], [-343, 603], [-317, 636], [-274, 666], [-223, 688], [-167, 703], [-110, 710], [-52, 711], [5, 706], [61, 693], [116, 674], [164, 652], [212, 624], [252, 590], [281, 552], [310.96, 516.23], [298.96, 483.35]] },
  // France: a long road round the north and east coasts, a lane from it to
  // Belleville, and a road through the south-west fields.
  { id: "franceNorthCoast", island: "france", points: [[2240.65, 87.46], [2234.6, 121.93], [2253, 177], [2264, 231], [2267, 283], [2263, 329], [2252, 376], [2243, 422], [2248, 467], [2269, 509], [2305, 547], [2346, 579], [2396, 609], [2449, 636], [2503, 659], [2559, 676], [2616, 687], [2675, 693], [2729, 695], [2789, 696], [2848, 694], [2906, 689], [2962, 679], [3018, 661], [3067, 641], [3120, 614], [3172, 585], [3221, 552], [3267, 516], [3309, 474], [3346, 429], [3375, 385], [3398, 333], [3410, 280], [3411, 226], [3401, 171], [3386, 117], [3373, 69], [3361, 19], [3350, -27], [3350.69, -71.48], [3318.31, -84.75]] },
  { id: "franceBelleville", island: "france", points: [[3190.9, 298.52], [3223.84, 310.34], [3277, 300], [3324, 296], [3373.88, 287.77], [3408.31, 294.07]] },
  { id: "franceSouthWest", island: "france", points: [[2149.64, -188.01], [2124.43, -212.29], [2072, -305], [2068, -420], [2125, -515], [2245, -560], [2365, -535], [2456.85, -443.06], [2472.49, -411.75]] },
  // Egypt: desert roads east from the pyramid road, one south from it, and
  // one west past the small pyramids.
  { id: "egyptEast", island: "egypt", points: [[-46.45, -2468.26], [-13.27, -2457.12], [43, -2460], [102, -2459], [157, -2458], [217, -2458], [271, -2459], [331, -2463], [384, -2469], [441, -2481], [492, -2496], [548, -2514], [595.29, -2538.51], [630.03, -2534.23]] },
  { id: "egyptSouthEast", island: "egypt", points: [[251.46, -2458.77], [250.79, -2493.77], [262, -2556], [275, -2612], [296, -2672], [319, -2726], [347, -2784], [374, -2838], [404, -2896], [431, -2948], [457.1, -3008.53], [484.51, -3030.29]] },
  { id: "egyptWest", island: "egypt", points: [[138.43, -3017.33], [110.12, -3037.91], [54, -3057], [-2, -3075], [-59, -3087], [-122, -3095], [-180, -3099], [-238, -3103], [-295, -3111], [-354.09, -3111.45], [-373.8, -3140.38]] },
  // USA: a pass between Mount Rushmore and the Hollywood hill, a cross street
  // north of downtown and a short ridge road south-east.
  { id: "usaPass", island: "usa", points: [[-2624.85, -148.8], [-2653.77, -168.52], [-2760, -100], [-2880, -72], [-3000, -85], [-3120, -122], [-3230, -122], [-3296.41, -104.21], [-3330.21, -113.31]] },
  { id: "usaMidtown", island: "usa", points: [[-2791, 129.9], [-2758.23, 142.18], [-2708, 145], [-2659, 149], [-2606, 153], [-2558, 156], [-2513, 159], [-2466.62, 153.11], [-2446.71, 181.9]] },
  { id: "usaRidge", island: "usa", points: [[-2573.85, -252.49], [-2540.58, -241.62], [-2505, -292], [-2450, -340], [-2404.76, -387.43], [-2384.65, -416.08]] },
];

// Fuel stations: the road (by id) and the sample along it each one stands
// beside. They were picked by searching the roads (stations.js
// searchStations) and are frozen here, so new roads never move them.
export const FUEL_STATIONS = [
  { name: "Kingsford", road: "britain", index: 1696 },
  { name: "Ashby", road: "britainEast", index: 171 },
  { name: "Paris", road: "franceAvenue", index: 851 },
  { name: "Belleville", road: "franceAvenue", index: 496 },
  { name: "Al Nahr", road: "egypt", index: 381 },
  { name: "Al Wadi", road: "egypt", index: 1836 },
  { name: "Downtown", road: "usaSouth", index: 271 },
  { name: "Springfield", road: "usa", index: 1066 },
  { name: "Britain north", road: "britainNorth", index: 526 },
  { name: "Britain west", road: "britainNorth", index: 236 },
  { name: "Britain south", road: "britain", index: 1271 },
  { name: "France west", road: "france", index: 1471 },
  { name: "France south-east", road: "france", index: 806 },
  { name: "France east", road: "france", index: 481 },
  { name: "Egypt south", road: "egypt", index: 1101 },
  { name: "Egypt west", road: "egypt", index: 1481 },
  { name: "Egypt east", road: "egypt", index: 746 },
  { name: "USA north-west", road: "usaCoast", index: 461 },
  { name: "USA north-east", road: "usaCoast", index: 131 },
  { name: "USA east", road: "usa", index: 101 },
];

// Drag strips: { x, z, heading, length } for each strip's start (the back of
// its staging box), its heading (radians, like the car's) and its full length
// in metres, in world coordinates (not stretched by WORLD_SCALE). Where the
// land is tight the run-off is shorter, so `length` varies. `link` is the
// link road's control points, from a point on the public road to where it
// meets the strip: the back of the staging box (`entry: "back"`) or the
// middle of one side of it ("left" / "right", seen driving down the strip).
// Picked by tools/plan-dragstrips.mjs and frozen here, so they never move.
// The ground shaping in islands.js keeps its crags and cliffs well away from
// them, the same as from roads.
export const DRAG_STRIPS = [
  { id: "britain-north-half", name: "Drag strip · Britain north", island: "britain", x: -229.2, z: 956.92, heading: 1.8151, length: 1135, entry: "right", link: [[-201.28, 694.83], [-217.77, 920.06], [-211.73, 944.32]] },
  { id: "france-south-half", name: "Drag strip · France south", island: "france", x: 2159.85, z: -627.67, heading: 1.6057, length: 1165, entry: "left", link: [[2185.67, -547.31], [2180.99, -595.39], [2180.12, -620.37]] },
  { id: "egypt-south-half", name: "Drag strip · Egypt south", island: "egypt", x: -450.15, z: -3398.33, heading: 1.5359, length: 1135, entry: "left", link: [[-430.88, -3096.55], [-431.31, -3364.65], [-430.44, -3389.64]] },
  { id: "usa-south-half", name: "Drag strip · USA south", island: "usa", x: -3200.15, z: -668.33, heading: 1.5359, length: 1165, entry: "left", link: [[-3079.13, -475.35], [-3102.33, -501.56], [-3181.31, -634.65], [-3180.44, -659.64]] },
];

// Every strip's shape (metres): a staging box, the timed half mile and a
// run-off to stop in, four lanes wide. `apron` is how far each side of the
// middle the ground is levelled and kept free of trees (barriers, grandstand,
// flags and lights stand on it). Where the land is tight the run-off may be
// down to 290 m, which the fastest car was tested to stop in.
export const DRAG_STRIP = { stage: 40, run: 805, runoff: 320, lanes: 4, lane: 4, apron: 22 };

// Speed traps: a camera pole beside a long straight road and a white line
// across it. { x, z } is a road sample (world coordinates, not stretched),
// `heading` the road's direction there and `side` which side of it the pole
// stands (1 = right of that direction). Picked by tools/plan-extras.mjs and
// frozen here, so they never move.
export const SPEED_TRAPS = [
  { id: "trap-britain-east", name: "East speed trap", island: "britain", x: 553.85, z: 100.38, heading: -2.2248, side: -1 },
  { id: "trap-britain-north", name: "North speed trap", island: "britain", x: 168.35, z: 520.83, heading: 1.7721, side: -1 },
  { id: "trap-britain-south-east", name: "South-east speed trap", island: "britain", x: 173.18, z: -141.75, heading: -1.9305, side: -1 },
  { id: "trap-britain-east-2", name: "East speed trap 2", island: "britain", x: 654.16, z: -244.21, heading: -2.5799, side: -1 },
  { id: "trap-france-south", name: "South speed trap", island: "france", x: 2591.41, z: -464.21, heading: -1.1888, side: 1 },
  { id: "trap-france-south-east", name: "South-east speed trap", island: "france", x: 3046.35, z: -475.69, heading: -1.9291, side: 1 },
  { id: "trap-egypt-south-west", name: "South-west speed trap", island: "egypt", x: -264.26, z: -3202.36, heading: -1.1327, side: 1 },
  { id: "trap-egypt-north-east", name: "North-east speed trap", island: "egypt", x: 554.11, z: -2310.24, heading: 2.6169, side: 1 },
  { id: "trap-egypt-north-west", name: "North-west speed trap", island: "egypt", x: -509.37, z: -2344.1, heading: 0.4191, side: 1 },
  { id: "trap-egypt-east", name: "East speed trap", island: "egypt", x: 617.41, z: -2746.91, heading: -2.9316, side: 1 },
  { id: "trap-usa-east", name: "East speed trap", island: "usa", x: -2181.16, z: -225.43, heading: 0.6531, side: 1 },
  { id: "trap-usa-north", name: "North speed trap", island: "usa", x: -2908.38, z: 690.26, heading: -1.7061, side: 1 },
  { id: "trap-usa-south-west", name: "South-west speed trap", island: "usa", x: -3180.74, z: -376.25, heading: 2.3981, side: 1 },
  { id: "trap-usa-north-2", name: "North speed trap 2", island: "usa", x: -2517.88, z: 682, heading: -1.3738, side: 1 },
];

// Speed cameras on the towns' main streets (70 km/h): the same camera on a
// pole as the speed traps, standing at the pavement's edge, clear of parked
// cars, lamps, flags, bins, bus stops and side streets. They only take
// pictures (no bests or credits). { x, z } is a main-street road sample
// (world coordinates, already stretched), `heading` the road's direction
// there and `side` which side of it the pole stands (1 = right). Picked from
// the kerb spots the street furniture leaves free (streetFurniture.js) and
// frozen here, so they never move.
export const TOWN_CAMERAS = [
  { id: "cam-kingsford-1", town: "Kingsford", island: "britain", x: -496.12, z: 0, heading: 1.5708, side: -1 },
  { id: "cam-kingsford-2", town: "Kingsford", island: "britain", x: -276.12, z: 0, heading: 1.5708, side: 1 },
  { id: "cam-ashby-1", town: "Ashby", island: "britain", x: 287.31, z: -296.8, heading: 1.5708, side: 1 },
  { id: "cam-ashby-2", town: "Ashby", island: "britain", x: 443.31, z: -296.8, heading: 1.5708, side: -1 },
  { id: "cam-paris-1", town: "Paris", island: "france", x: 2558.3, z: 84, heading: 1.5708, side: 1 },
  { id: "cam-paris-2", town: "Paris", island: "france", x: 2756.3, z: 84, heading: 1.5708, side: -1 },
  { id: "cam-belleville-1", town: "Belleville", island: "france", x: 2855.52, z: 420, heading: -1.5708, side: 1 },
  { id: "cam-belleville-2", town: "Belleville", island: "france", x: 2925.52, z: 420, heading: -1.5708, side: -1 },
  { id: "cam-al-nahr-1", town: "Al Nahr", island: "egypt", x: -132.67, z: -2114, heading: 1.5708, side: 1 },
  { id: "cam-al-nahr-2", town: "Al Nahr", island: "egypt", x: 111.33, z: -2114, heading: 1.5708, side: -1 },
  { id: "cam-al-wadi-1", town: "Al Wadi", island: "egypt", x: -431.96, z: -2694.67, heading: 1.568, side: -1 },
  { id: "cam-al-wadi-2", town: "Al Wadi", island: "egypt", x: -365.96, z: -2694.96, heading: 1.5754, side: 1 },
  { id: "cam-downtown-1", town: "Downtown", island: "usa", x: -2759.88, z: 462, heading: -1.5708, side: -1 },
  { id: "cam-downtown-2", town: "Downtown", island: "usa", x: -2625.88, z: 462.02, heading: -1.5777, side: 1 },
  { id: "cam-springfield-1", town: "Springfield", island: "usa", x: -2848.61, z: -518, heading: 1.5708, side: -1 },
  { id: "cam-springfield-2", town: "Springfield", island: "usa", x: -2738.61, z: -518, heading: 1.5708, side: 1 },
];

// Street races, from a start gate near one landmark to a finish near another.
// { x, z, heading } is the gate (a road sample, facing the way the race goes);
// the route runs from `start` (behind the gate, past the start grid) by way
// of `via` to `finish`, and the other cars carry on to `runout` so they cross
// the line at speed. `length` is the race in metres. Picked by
// tools/plan-extras.mjs and frozen here. (The Navigator finds the route when
// a race starts, so two of them now take the country roads, and are shorter;
// the Statue of Liberty race now comes to its finish from the south, so its
// run-out was moved on past the finish that way.)
export const STREET_RACES = [
  { id: "street-big-ben", name: "Big Ben to Stonehenge", island: "britain", x: -403.46, z: -138.36, heading: 3.0827, start: [-405.07, -108.4], via: [[721.29, -73.95]], finish: [-310.5, 364.2], runout: [-401.61, 145.39], length: 3042 },
  { id: "street-stonehenge", name: "Stonehenge to Tower Bridge", island: "britain", x: -99.1, z: 9.42, heading: -1.782, start: [-69.94, 16.47], via: [[-727.81, -310.12]], finish: [724.93, 41.47], runout: [624.44, 254.28], length: 2902 },
  { id: "street-eiffel-tower", name: "Eiffel Tower to Notre-Dame", island: "france", x: 2673.73, z: -128.8, heading: -0.0158, start: [2674.37, -158.8], via: [[3328.9, -179.3]], finish: [2515.62, -239.42], runout: [2282, -294], length: 2242 },
  { id: "street-pyramids", name: "Pyramids to Abu Simbel", island: "egypt", x: -25.55, z: -2688.65, heading: -2.9505, start: [-19.7, -2659.23], via: [[-231.35, -3216.96]], finish: [494.67, -2230.15], runout: [286.38, -2115.73], length: 2796 },
  { id: "street-statue-of-liberty", name: "Statue of Liberty to Mount Rushmore", island: "usa", x: -2189.8, z: 350.36, heading: -0.5859, start: [-2174.08, 324.82], via: [[-2614.96, -163.84]], finish: [-3305.57, 203.53], runout: [-3159.38, 391.17], length: 2334 },
  { id: "street-empire-state-building", name: "Empire State Building to Hollywood sign", island: "usa", x: -2820.52, z: 310.16, heading: 0.0233, start: [-2820.64, 280.16], via: [[-2640.84, 697.27]], finish: [-2834.61, -518], runout: [-2594.79, -518.76], length: 3250 },
];

// Deck heights above the sea. Tower Bridge sits lower, like the real one, so
// the road can climb up to it from the beach within the grade limit.
export const BRIDGE_DECK = { beam: 14, suspension: 22, tower: 9 };

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
