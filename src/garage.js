import { Color3 } from "@babylonjs/core";

// Vehicles you can pick. The concept car is the detailed one (it has a
// cabin); the rest are the downloaded everyday cars and service vehicles
// (public/assets/vehicles), each with its own handling.
//   power: engine power (W)   maxDrive: pulling force (N)   mass: kg
//   grip: tyre grip           drag: air resistance (bigger for boxy vehicles)
const car = (id, name, trim, spec, extra = {}) => ({ id, model: id, name, trim, kind: "car", spec, ...extra });
const big = (id, name, trim, spec, extra = {}) => ({ id, model: id, name, trim, kind: "service", spec: { gears: [4.2, 2.8, 1.9, 1.4, 1.1, 0.85], redline: 3200, ...spec }, ...extra });

export const GARAGE = [
  {
    id: "gt-red",
    model: null, // the concept car
    name: "Concept GT",
    trim: "Sports tourer",
    kind: "car",
    paint: { colour: [0.666, 0, 0], metallic: 1, roughness: 0.18 },
    spec: { power: 300000, maxDrive: 10500, grip: 1.15, mass: 1350 },
  },
  car("sedan", "Saloon", "Family four-door", { power: 150000, maxDrive: 8200, grip: 1.08, mass: 1500 }),
  car("hatchback", "Hatchback", "Small and nippy", { power: 110000, maxDrive: 7200, grip: 1.08, mass: 1200 }, { electric: true }),
  car("compact", "City car", "Tiny town runabout", { power: 70000, maxDrive: 5600, grip: 1.04, mass: 1000 }, { electric: true }),
  car("coupe", "Coupe", "Two-door sports", { power: 240000, maxDrive: 9800, grip: 1.16, mass: 1380 }),
  car("sport", "Sports car", "Low and very fast", { power: 380000, maxDrive: 12500, grip: 1.3, mass: 1250, drag: 0.36 }),
  car("wagon", "Estate", "Room for the dog", { power: 150000, maxDrive: 8200, grip: 1.07, mass: 1550 }),
  car("minivan", "People carrier", "Seats seven", { power: 150000, maxDrive: 8500, grip: 1.0, mass: 1850, drag: 0.55 }, { electric: true }),
  car("suv", "SUV", "Big and tall", { power: 220000, maxDrive: 10000, grip: 1.02, mass: 2100, drag: 0.6 }),
  car("offroad", "Off-roader", "Goes anywhere", { power: 180000, maxDrive: 10500, grip: 1.08, mass: 2000, drag: 0.65 }),
  car("pickup", "Pickup", "Truck with a flat bed", { power: 260000, maxDrive: 11000, grip: 1.0, mass: 2200, drag: 0.65 }),
  car("taxi", "Taxi", "Yellow cab", { power: 160000, maxDrive: 8500, grip: 1.06, mass: 1650 }, { kind: "service", electric: true }),
  car("police", "Police car", "Fast pursuit car", { power: 300000, maxDrive: 11000, grip: 1.15, mass: 1750 }, { kind: "service" }),
  big("ambulance", "Ambulance", "Emergency van", { power: 220000, maxDrive: 14000, grip: 0.98, mass: 3800, drag: 1.2 }),
  big("postvan", "Post van", "Parcels and letters", { power: 120000, maxDrive: 9000, grip: 0.98, mass: 2600, drag: 0.9 }, { electric: true }),
  big("worktruck", "Work truck", "Road repair crew", { power: 200000, maxDrive: 12000, grip: 1.0, mass: 3200, drag: 1.0 }),
  big("towtruck", "Tow truck", "Flatbed recovery", { power: 250000, maxDrive: 16000, grip: 0.98, mass: 5000, drag: 1.4 }),
  big("citybus", "City bus", "Long, slow, steady", { power: 200000, maxDrive: 30000, grip: 0.95, mass: 12000, drag: 2.6 }, { electric: true }),
  big("schoolbus", "School bus", "Big yellow bus", { power: 190000, maxDrive: 27000, grip: 0.95, mass: 11000, drag: 2.6 }),
  big("firetruck", "Fire engine", "Heavy and loud", { power: 330000, maxDrive: 40000, grip: 0.95, mass: 15000, drag: 3 }),
  big("bintruck", "Bin lorry", "Six wheels, very heavy", { power: 250000, maxDrive: 38000, grip: 0.95, mass: 16000, drag: 3.2 }),
];

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
