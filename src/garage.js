import { Color3 } from "@babylonjs/core";
import REAL_CARS from "./realCars.json";

// Vehicles you can pick. The concept car is the detailed one (it has a
// cabin); the rest are the downloaded everyday cars and service vehicles
// (public/assets/vehicles), each with its own handling.
//   power: engine power (W)   maxDrive: pulling force (N)   mass: kg
//   grip: tyre grip           drag: air resistance (bigger for boxy vehicles)
// `sound` is the engine it makes (audio.js ENGINES): everyday, sports,
// diesel (buses and lorries) or electric (every electric one, the city bus too).
const engine = (extra, fallback) => (extra.electric ? "electric" : fallback);
const car = (id, name, trim, spec, extra = {}) => ({ id, model: id, name, trim, kind: "car", spec, sound: engine(extra, "everyday"), ...extra });
const big = (id, name, trim, spec, extra = {}) => ({ id, model: id, name, trim, kind: "service", spec: { gears: [4.2, 2.8, 1.9, 1.4, 1.1, 0.85], redline: 3200, ...spec }, sound: engine(extra, "diesel"), ...extra });

export const GARAGE = [
  {
    id: "gt-red",
    model: null, // the concept car
    name: "Concept GT",
    trim: "Sports tourer",
    kind: "car",
    paint: { colour: [0.666, 0, 0], metallic: 1, roughness: 0.18 },
    spec: { power: 300000, maxDrive: 10500, grip: 1.15, mass: 1350 },
    sound: "sports",
  },
  car("sedan", "Saloon", "Family four-door", { power: 150000, maxDrive: 8200, grip: 1.08, mass: 1500 }),
  car("hatchback", "Hatchback", "Small and nippy", { power: 110000, maxDrive: 7200, grip: 1.08, mass: 1200 }, { electric: true }),
  car("compact", "City car", "Tiny town runabout", { power: 70000, maxDrive: 5600, grip: 1.04, mass: 1000 }, { electric: true }),
  car("coupe", "Coupe", "Two-door sports", { power: 240000, maxDrive: 9800, grip: 1.16, mass: 1380 }, { sound: "sports" }),
  car("sport", "Sports car", "Low and very fast", { power: 380000, maxDrive: 12500, grip: 1.3, mass: 1250, drag: 0.36 }, { sound: "sports" }),
  car("wagon", "Estate", "Room for the dog", { power: 150000, maxDrive: 8200, grip: 1.07, mass: 1550 }),
  car("minivan", "People carrier", "Seats seven", { power: 150000, maxDrive: 8500, grip: 1.0, mass: 1850, drag: 0.55 }, { electric: true }),
  car("suv", "SUV", "Big and tall", { power: 220000, maxDrive: 10000, grip: 1.02, mass: 2100, drag: 0.6 }),
  car("offroad", "Off-roader", "Goes anywhere", { power: 180000, maxDrive: 10500, grip: 1.08, mass: 2000, drag: 0.65 }),
  car("pickup", "Pickup", "Truck with a flat bed", { power: 260000, maxDrive: 11000, grip: 1.0, mass: 2200, drag: 0.65 }),
  car("taxi", "Taxi", "Yellow cab", { power: 160000, maxDrive: 8500, grip: 1.06, mass: 1650 }, { kind: "service", electric: true }),
  car("police", "Police car", "Fast pursuit car", { power: 300000, maxDrive: 11000, grip: 1.15, mass: 1750 }, { kind: "service", sound: "sports" }),
  big("ambulance", "Ambulance", "Emergency van", { power: 220000, maxDrive: 14000, grip: 0.98, mass: 3800, drag: 1.2 }),
  big("postvan", "Post van", "Parcels and letters", { power: 120000, maxDrive: 9000, grip: 0.98, mass: 2600, drag: 0.9 }, { electric: true }),
  big("worktruck", "Work truck", "Road repair crew", { power: 200000, maxDrive: 12000, grip: 1.0, mass: 3200, drag: 1.0 }),
  big("towtruck", "Tow truck", "Flatbed recovery", { power: 250000, maxDrive: 16000, grip: 0.98, mass: 5000, drag: 1.4 }),
  big("citybus", "City bus", "Long, slow, steady", { power: 200000, maxDrive: 30000, grip: 0.95, mass: 12000, drag: 2.6 }, { electric: true }),
  big("schoolbus", "School bus", "Big yellow bus", { power: 190000, maxDrive: 27000, grip: 0.95, mass: 11000, drag: 2.6 }),
  big("firetruck", "Fire engine", "Heavy and loud", { power: 330000, maxDrive: 40000, grip: 0.95, mass: 15000, drag: 3 }),
  big("bintruck", "Bin lorry", "Six wheels, very heavy", { power: 250000, maxDrive: 38000, grip: 0.95, mass: 16000, drag: 3.2 }),
];

// ---------- The real cars ----------
// Made by tools/prepare-cars.mjs from tools/cars.json (src/realCars.json is
// written by it): real brands and models, each with its real power, weight,
// top speed and 0-100 km/h time. The game's handling is worked out from those
// below, so a hypercar really is much faster than a Mini.

// Same sums as vehicle.js on a flat road at full throttle (and race.js).
const ROLLING = 32;
const accelAt = (spec, v) => (Math.min(spec.maxDrive, spec.power / Math.max(v, 1)) - spec.drag * v * v - ROLLING * v) / spec.mass;
// Seconds from a standstill to `to` m/s (100 km/h unless said).
function zeroTo100(spec, to = 100 / 3.6) {
  let v = 0;
  let t = 0;
  const step = 1 / 60;
  while (v < to && t < 60) {
    v += accelAt(spec, v) * step;
    t += step;
  }
  return t;
}
// Top speed: where the engine's power is all used up by air and rolling resistance.
function topSpeed(spec) {
  let lo = 1;
  let hi = 250;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    if (spec.power / v > spec.drag * v * v + ROLLING * v) lo = v;
    else hi = v;
  }
  return lo;
}

// Air resistance from the real top speed, then the pull off the line that
// gives the real 0-100 km/h time.
function realSpec(c) {
  const v = c.topKmh / 3.6;
  // (A very small engine, say an old Fiat's, couldn't even beat the game's
  // rolling resistance up to its real top speed: it gets just enough to.)
  const power = Math.max(c.kw * 1000, MIN_DRAG * v ** 3 + ROLLING * v * v);
  const drag = Math.max(MIN_DRAG, (power - ROLLING * v * v) / v ** 3);
  const spec = { power, mass: c.kg, drag, maxDrive: 10000, grip: c.grip ?? GRIP[c.class] ?? 1.15, redline: c.redline ?? 7000 };
  // Cars that never reach 100 km/h are given their 0-80 km/h time instead.
  const [to, time] = c.zeroTo80 ? [80 / 3.6, c.zeroTo80] : [100 / 3.6, c.zeroTo100];
  let lo = c.kg * 0.5;
  let hi = c.kg * 20;
  for (let i = 0; i < 30; i++) {
    spec.maxDrive = (lo + hi) / 2;
    if (zeroTo100(spec, to) > time) lo = spec.maxDrive;
    else hi = spec.maxDrive;
  }
  spec.maxDrive = Math.round(hi);
  // (Four-wheel drive puts the power down a little better out of corners.)
  if (c.drive === "AWD") spec.grip += 0.03;
  return spec;
}
const MIN_DRAG = 0.12;
// How well each kind of car holds the road (1.0 an old saloon, 1.4 a hypercar on slicks).
const GRIP = { Hypercar: 1.4, Supercar: 1.32, Sports: 1.25, Muscle: 1.12, JDM: 1.22, "Hot hatch": 1.16, Classic: 1.0, Luxury: 1.14, "SUV/Truck": 1.0, EV: 1.18 };

const real = (c) => ({
  id: c.id,
  model: c.id,
  name: `${c.brand} ${c.model}`,
  brand: c.brand,
  modelName: c.model,
  year: c.year,
  country: c.country,
  class: c.class,
  kind: "car",
  real: true,
  spec: realSpec(c),
  kw: c.kw,
  sound: c.electric ? "electric" : c.sound,
  electric: !!c.electric,
  traffic: !!c.traffic,
  credit: c.credit,
});
export const REAL = REAL_CARS.map(real);
GARAGE.push(...REAL);

// What the garage shows: power, top speed and 0-100 km/h (or 0-60 mph), as the game drives it.
const perf = new Map();
export function figures(entry) {
  if (!perf.has(entry)) {
    const s = { drag: 0.42, maxDrive: 10500, ...entry.spec };
    const tenths = (t) => Math.round(t * 10) / 10;
    // (A real car shows its real power, even where the game gives it a little more.)
    const kw = entry.kw ?? s.power / 1000;
    const top = topSpeed(s) * 3.6;
    // Slow cars: 0-80 km/h (0-50 mph) instead, as they hardly reach 100.
    const slow = top < 110;
    perf.set(entry, { kw: Math.round(kw), hp: Math.round(kw * 1.341), topKmh: Math.round(top), slow, zeroTo100: tenths(zeroTo100(s, (slow ? 80 : 100) / 3.6)), zeroTo60: tenths(zeroTo100(s, (slow ? 50 : 60) / 2.23694)) });
  }
  return perf.get(entry);
}

// Rough 0..1 scores for the bars shown in the garage.
export function stats(entry) {
  const s = entry.spec;
  // Top speed, from where the engine's power is all used up by air resistance.
  const top = Math.cbrt(s.power / (s.drag ?? 0.42));
  return {
    speed: Math.min(1, Math.max(0.08, (top - 30) / 60)),
    acceleration: Math.min(1, Math.max(0.05, s.maxDrive / s.mass / 10)),
    grip: Math.min(1, Math.max(0.05, (s.grip - 0.9) / 0.45)),
  };
}

export function applyPaint(car, paint) {
  if (!paint) return;
  for (const m of car.materials) {
    if (m.name !== "Paint 1 Carmine") continue;
    m.albedoColor = new Color3(...paint.colour);
    m.metallic = paint.metallic;
    m.roughness = paint.roughness;
  }
}
