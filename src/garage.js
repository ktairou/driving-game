import { Color3 } from "@babylonjs/core";

// Cars you can pick. For now they are all the concept car, in different
// paint and tuned differently. Realistic downloaded cars get added here
// later, each with its own model file.
export const GARAGE = [
  {
    id: "gt-red",
    name: "Concept GT",
    trim: "Candy red · Sport",
    paint: { colour: [0.666, 0, 0], metallic: 1, roughness: 0.18 },
    spec: { power: 300000, maxDrive: 10500, grip: 1.15, mass: 1350 },
  },
  {
    id: "gt-pearl",
    name: "Concept GT",
    trim: "Pearl white · Touring",
    electric: true,
    paint: { colour: [0.86, 0.86, 0.84], metallic: 0.25, roughness: 0.22 },
    spec: { power: 240000, maxDrive: 9000, grip: 1.08, mass: 1450 },
  },
  {
    id: "gt-graphite",
    name: "Concept GT",
    trim: "Graphite · Grand tourer",
    paint: { colour: [0.06, 0.06, 0.07], metallic: 0.9, roughness: 0.3 },
    spec: { power: 330000, maxDrive: 10000, grip: 1.1, mass: 1500 },
  },
  {
    id: "gt-blue",
    name: "Concept GT",
    trim: "Rally blue · Grip",
    electric: true,
    paint: { colour: [0.05, 0.16, 0.5], metallic: 0.8, roughness: 0.2 },
    spec: { power: 280000, maxDrive: 11500, grip: 1.3, mass: 1300 },
  },
  {
    id: "gt-yellow",
    name: "Concept GT",
    trim: "Track yellow · Track",
    paint: { colour: [0.9, 0.62, 0.02], metallic: 0.6, roughness: 0.16 },
    spec: { power: 390000, maxDrive: 12500, grip: 1.25, mass: 1250 },
  },
  {
    id: "gt-green",
    name: "Concept GT",
    trim: "Racing green · Classic",
    paint: { colour: [0.02, 0.2, 0.09], metallic: 0.85, roughness: 0.22 },
    spec: { power: 260000, maxDrive: 9800, grip: 1.12, mass: 1400 },
  },
];

// Rough 0..1 scores for the bars shown in the garage.
export function stats(entry) {
  const s = entry.spec;
  return {
    speed: Math.min(1, (s.power / 400000) * 0.9 + 0.1),
    acceleration: Math.min(1, s.maxDrive / s.mass / 10),
    grip: Math.min(1, (s.grip - 0.9) / 0.45),
  };
}

export function applyPaint(car, paint) {
  for (const m of car.materials) {
    if (m.name !== "Paint 1 Carmine") continue;
    m.albedoColor = new Color3(...paint.colour);
    m.metallic = paint.metallic;
    m.roughness = paint.roughness;
  }
}
