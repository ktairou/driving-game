// Brake tests on the drag strips (run by race.js, beside its drag races):
// line up with five cars, go on green, then stop with your front bumper as
// close to the finish line as you can. Your go ends the first time you stop,
// and must end before the clock runs out (so creeping up to the line slowly
// doesn't work). Closest wins; stopping past the line counts double.

// How far from the line (in metres, as scored) the other five stop, per
// level; shared out at random every test, and give or take a fifth.
export const BRAKE_LEVELS = {
  easy: [1.5, 2.5, 4, 6, 9],
  medium: [0.6, 1.1, 1.8, 2.8, 4.5],
  hard: [0.2, 0.4, 0.7, 1.1, 1.7],
};
export const OVER = 2; // stopping past the line counts this many times over
const STEP = 1 / 120; // the same physics step as vehicle.js
const BRAKING = 15000 / 1350; // vehicle.js: full brakes slow every vehicle this hard (m/s²)
const OVER_SHARE = 0.3; // about this many of the others stop past the line

// The score for stopping `short` metres before the line (less than 0: past it).
export const score = (short) => (short >= 0 ? short : -short * OVER);

// A distance as the chip shows it: whole metres far off, then finer.
export function metres(d) {
  const a = Math.abs(d);
  return a >= 10 ? `${Math.round(a)} m` : a >= 1 ? `${a.toFixed(1)} m` : `${a.toFixed(2)} m`;
}

// Where you stopped, in words.
export function stopText(short) {
  if (Math.abs(short) < 0.005) return "On the line!";
  return `${Math.abs(short).toFixed(2)} m ${short > 0 ? "short" : "over"}`;
}

// The time allowed (whole seconds from green): how long your car takes going
// flat out and braking at the very last moment to stop on the line, with
// plenty to spare. `accel(v)` is its pull at full throttle (race.js).
export function timeAllowed(run, accel) {
  let x = 0;
  let v = 0;
  let t = 0;
  while (t < 120 && x + (v * v) / (2 * BRAKING) < run) {
    v += accel(v) * STEP;
    x += v * STEP;
    t += STEP;
  }
  return Math.ceil((t + v / BRAKING) * 1.3 + 4);
}

// Sets up one of the others for a test: how far from the line it'll stop
// (`gap`, as scored), whether short or over, and how hard it brakes.
// `run` is how far its front has to come to reach the line.
export function planRival(ai, gap, run) {
  const e = gap * (0.8 + Math.random() * 0.4);
  const over = Math.random() < OVER_SHARE;
  ai.short = over ? -e / OVER : e;
  ai.score = e;
  ai.target = run - ai.short;
  ai.decel = 8.5 + Math.random() * 2; // (people don't stand on the brakes as hard as they could)
  ai.braking = false;
  ai.stopped = false;
}

// Moves one of the others on to time `until` (seconds since it set off):
// flat out, then braking steadily to stop at its target. `accel(v)` is its
// pull at full throttle.
export function stepRival(ai, until, accel) {
  while (!ai.stopped && ai.t + STEP <= until) {
    const left = ai.target - ai.x;
    if (!ai.braking && (ai.v * ai.v) / (2 * ai.decel) >= left) ai.braking = true;
    const a = ai.braking ? -(ai.v * ai.v) / (2 * Math.max(left, 0.01)) : accel(ai.v);
    ai.v = Math.max(0, ai.v + a * STEP);
    ai.x += ai.v * STEP;
    ai.t += STEP;
    if (ai.braking && (ai.v < 0.05 || ai.x >= ai.target)) {
      ai.x = ai.target;
      ai.v = 0;
      ai.stopped = true;
    }
  }
}
