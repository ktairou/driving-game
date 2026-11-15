import { price } from "./garage.js";

// Credits: won in drag races, street races and with new bests at speed traps,
// and spent on vehicles in the garage. Kept in the settings (quality.js):
// `credits`, `unlocked` (ids you own) and `unlockAll` (the Settings switch).

// What each place pays, before the level's share (Easy x1, Medium x1.5, Hard x2.5).
const PLACE_PAY = { drag: [100, 50, 25, 10], street: [300, 150, 75, 25] };
const LEVEL_PAY = { easy: 1, medium: 1.5, hard: 2.5 };

// Credits for finishing a race in `place` (0 = first) at `level`.
export function raceReward(kind, place, level) {
  return Math.round((PLACE_PAY[kind][place] ?? 0) * (LEVEL_PAY[level] ?? 1));
}

// Credits for a new best at a speed trap: one for every 2 km/h better than
// your old best there (so creeping up a little at a time earns very little).
export function trapReward(oldBest, newBest) {
  return Math.max(1, Math.round(((newBest - oldBest) * 3.6) / 2));
}

export class Credits {
  constructor(settings, save) {
    this.settings = settings;
    this.save = save;
  }

  get balance() {
    return this.settings.credits;
  }

  // Adds credits (and saves); returns how many, for the "+N credits" notes.
  earn(n) {
    if (!(n > 0)) return 0;
    this.settings.credits += n;
    this.save(this.settings);
    return n;
  }

  // May you drive this one? (Free, bought, or everything unlocked in Settings.)
  owns(entry) {
    return this.settings.unlockAll || price(entry) === 0 || this.settings.unlocked.includes(entry.id);
  }

  // Pays for a vehicle and keeps it; false if there aren't enough credits.
  buy(entry) {
    const cost = price(entry);
    if (this.settings.credits < cost) return false;
    this.settings.credits -= cost;
    if (!this.settings.unlocked.includes(entry.id)) this.settings.unlocked.push(entry.id);
    this.save(this.settings);
    return true;
  }
}

// "1,250" (the same everywhere, whatever the iPad's language).
export const credits = (n) => n.toLocaleString("en-GB");
