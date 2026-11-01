// Hand-placed shape of the test world. Units are metres; +x east, +z north.

export const WORLD_HALF = 800; // terrain covers -800..800 on both axes
export const PLAY_HALF = 735; // invisible fence: the car can't go past this

export const ROAD_HALF_WIDTH = 5; // two 3.5 m lanes plus edge space
export const ROAD_SAMPLE_STEP = 2;

// The town sits on a flat shelf; the main street runs through it along z = 0.
export const TOWN = { cx: -290, cz: 0, hx: 190, hz: 70, height: 8 };
// Stretch of the main street that is dead straight and gets pavements.
export const MAIN_STREET = { x0: -450, x1: -140 };

// One closed loop. The straight run of points at z = 0 is the town's main street.
export const ROAD_POINTS = [
  [-470, 0], [-380, 0], [-290, 0], [-200, 0], [-110, 0],
  [0, 30], [110, 110], [230, 210], [370, 230], [480, 140],
  [520, -10], [470, -170], [360, -280], [200, -330], [60, -290],
  [-30, -200], [-140, -170], [-280, -230], [-430, -270], [-540, -200],
  [-580, -90], [-550, -20],
];

// Where the car starts: west end of the main street, facing east.
export const SPAWN = { x: -430, z: 0, heading: Math.PI / 2 };
