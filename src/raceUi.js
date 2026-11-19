import "./race.css";

// The on-screen parts every kind of race shares (race.js drag races,
// streetRace.js street races): the Race button, the lights-and-stopwatch chip,
// the start panel with its level picker, and the result card with its medal.

export const LEVEL_NAMES = { easy: "Easy", medium: "Medium", hard: "Hard" };
export const PLACES = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
export const TITLES = ["You won!", "Second place", "Third place", "Fourth place", "Fifth place", "Sixth place"];
export const MEDALS = ["gold", "silver", "bronze"];

export const el = (tag, cls, html = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
};

// Keeps the better of two medals (gold beats silver beats bronze).
export const betterMedal = (a, b) => (!a ? b : !b ? a : MEDALS.indexOf(a) <= MEDALS.indexOf(b) ? a : b);

// The Race button, where the Fill up button goes (they never both show).
export function raceButton(onClick) {
  const b = el("button", "action race-action", "Race");
  b.hidden = true;
  b.addEventListener("click", onClick);
  document.getElementById("hud").appendChild(b);
  return b;
}

// Lights, stopwatch and place under the top of the screen (and, with
// `gates`, which gate is next).
export function raceChip({ gates = false } = {}) {
  const chip = el("div", "race-hud", `<span class="race-lights"><i></i><i></i><i></i><i></i></span><span class="race-clock">0.00</span><span class="race-place"></span>${gates ? `<span class="race-gates"></span>` : ""}`);
  chip.hidden = true;
  document.getElementById("hud").appendChild(chip);
  return {
    el: chip,
    dots: [...chip.querySelectorAll(".race-lights i")],
    clock: chip.querySelector(".race-clock"),
    place: chip.querySelector(".race-place"),
    gates: chip.querySelector(".race-gates"),
    // 0 = off, 1-3 = that amber, 4 = green; red after a false start.
    lights(n, falseStart) {
      const amber = n >= 1 && n <= 3 ? n : 0;
      this.dots.forEach((d, i) => {
        d.className = i < 3 ? (amber === i + 1 ? "amber" : "") : n === 4 ? "green" : falseStart ? "red" : "";
      });
    },
  };
}

// The start panel: what the race is, how hard, your best, Not now / Start.
export function startPanel({ title, note, onLevel, onStart }) {
  const panel = el(
    "div",
    "panel",
    `<div class="panel-card race-card">
      <h2>${title}</h2>
      <p class="note race-what">${note}</p>
      <div class="row"><div class="label">How hard</div><div class="seg race-levels">${Object.entries(LEVEL_NAMES).map(([id, name]) => `<button data-v="${id}">${name}</button>`).join("")}</div></div>
      <p class="note race-best"></p>
      <div class="race-buttons"><button class="secondary race-cancel">Not now</button><button class="primary race-start">Start</button></div>
    </div>`,
  );
  panel.hidden = true;
  document.body.appendChild(panel);
  panel.querySelector(".race-levels").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (v) onLevel(v);
  });
  panel.querySelector(".race-cancel").addEventListener("click", () => (panel.hidden = true));
  panel.querySelector(".race-start").addEventListener("click", () => onStart());
  return {
    el: panel,
    markLevel(level) {
      for (const b of panel.querySelectorAll(".race-levels button")) b.classList.toggle("on", b.dataset.v === level);
    },
    // `what` replaces the note under the title (when it changes per race).
    show({ best, what }) {
      if (what !== undefined) panel.querySelector(".race-what").textContent = what;
      panel.querySelector(".race-best").textContent = best;
      panel.hidden = false;
    },
  };
}

// "1st", "2nd", "3rd", "4th"... for any place (1 = first).
export function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

// The result card: the finish photo (when there is one), medal (or place),
// title, a line under it, three numbers, everyone's places, times and gaps,
// notes, credits won, and Leave / Race again.
export function resultCard({ onAgain, onLeave }) {
  const panel = el("div", "panel", `<div class="panel-card race-card race-result"></div>`);
  panel.hidden = true;
  document.body.appendChild(panel);
  const card = panel.firstElementChild;
  // The finish photo (finishShow.js): none, on its way, or ready.
  const shot = { want: false, url: null, onTap: null };
  card.addEventListener("click", (e) => {
    if (e.target.closest(".race-again")) onAgain();
    else if (e.target.closest(".race-leave")) onLeave();
    else if (e.target.closest(".race-shot") && shot.url) shot.onTap?.();
  });
  const drawShot = () => {
    const box = card.querySelector(".race-shot");
    if (!box) return;
    card.classList.toggle("with-photo", shot.want);
    box.hidden = !shot.want;
    const img = box.querySelector("img");
    if (shot.url) img.src = shot.url;
    else img.removeAttribute("src");
    box.classList.toggle("ready", !!shot.url);
  };
  return {
    el: panel,
    // place: 0 on, or -1 if you didn't finish. stats: [[label, value] x3].
    // rows: [{ name, time (text), gap (text, optional), you }] in finishing
    // order. credits: won this time (optional).
    fill({ place, title, sub, stats, notes, rows, credits = 0 }) {
      const medal = MEDALS[place] ?? "";
      card.innerHTML = `
      <div class="race-head">
        <button class="race-shot" hidden aria-label="Open the finish photo"><img alt="Your car crossing the finish line"><span class="race-shot-wait">Photo on its way…</span></button>
        <div class="race-head-main">
          <div class="race-top">
            <div class="race-medal ${medal}">${place < 0 ? "–" : (PLACES[place] ?? ordinal(place + 1))}</div>
            <div><h2>${title}</h2><p class="note">${sub}</p></div>
          </div>
          ${notes.length || credits ? `<div class="race-foot">${credits ? `<span class="race-credits">+${credits} credits</span>` : ""}${notes.length ? `<p class="race-note">${notes.join(" ")}</p>` : ""}</div>` : ""}
        </div>
      </div>
      <div class="race-stats">${stats.map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join("")}</div>
      <ol class="race-table">${rows
        .map((r, i) => `<li class="${r.you ? "you" : ""}"><span class="race-pos ${MEDALS[i] ?? ""}">${i + 1}</span><span class="race-name">${r.name}</span><span class="race-time">${r.time}</span><span class="race-gap">${r.gap ?? ""}</span></li>`)
        .join("")}</ol>
      <div class="race-buttons"><button class="secondary race-leave">Leave</button><button class="primary race-again">Race again</button></div>`;
      drawShot();
    },
    // The finish photo: `want` false for none; true with no url while it's
    // being made; then its picture's address, and what tapping it does.
    setPhoto(want, url = null, onTap = null) {
      shot.want = want;
      shot.url = url;
      shot.onTap = onTap;
      drawShot();
    },
  };
}
