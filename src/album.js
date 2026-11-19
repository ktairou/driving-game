import "./photos.css";
import { speedWords, limitWords, dateWords } from "./speedPhotos.js";

// The album of photos (speedPhotos.js takes them): speed camera photos and
// race finish photos, opened from Settings, by tapping a new speed photo's
// card or the photo on a race's result card. They're kept in the browser's
// own database (IndexedDB), not with the settings (which must stay small):
// at most KEEP (about 40 KB each), newest first, the oldest going to make
// room. Where that database can't be used (some private browsing), photos
// just aren't kept.

const DB_NAME = "drivingGame.photos";
const STORE = "photos";
export const KEEP = 40;

// Which kind a photo is. (Photos from before race finishes were kept have no
// kind: they're all speed camera photos.)
const isFinish = (rec) => rec.kind === "finish";
const KIND_NAMES = { finish: "Race finish", speed: "Speed camera" };

const request = (r) =>
  new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });

class PhotoStore {
  constructor() {
    this.db = null; // a promise of the database (or null if it can't be used)
  }

  // Opened the first time it's needed.
  _open() {
    this.db ??= new Promise((ok) => {
      setTimeout(() => ok(null), 4000); // (some private modes never answer)
      try {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ok(null);
        r.onblocked = () => ok(null);
      } catch {
        ok(null);
      }
    });
    return this.db;
  }

  // One go at the store: `fn` gets it and returns a promise. Null if that fails.
  async _do(mode, fn) {
    const db = await this._open();
    if (!db) return null;
    try {
      return await fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      return null;
    }
  }

  // Keeps a photo (and lets the oldest go past KEEP). Its id, or null if it can't be kept.
  async add(rec) {
    const id = await this._do("readwrite", (s) => request(s.add(rec)));
    if (id === null) return null;
    const keys = await this._do("readonly", (s) => request(s.getAllKeys()));
    if (keys && keys.length > KEEP) await this._do("readwrite", (s) => Promise.all(keys.slice(0, keys.length - KEEP).map((k) => request(s.delete(k)))));
    return id;
  }

  // Every photo kept, newest first; null if they can't be kept here.
  async list() {
    const all = await this._do("readonly", (s) => request(s.getAll()));
    return all ? all.sort((a, b) => b.id - a.id) : null;
  }

  remove(id) {
    return this._do("readwrite", (s) => request(s.delete(id)));
  }
}

const el = (tag, cls, text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class PhotoAlbum {
  // hooks: { units() -> "kmh" | "mph", deliver(file, say) (photo.js: the
  //   share sheet, or a download), settings() -> the Settings panel }
  constructor(hooks) {
    this.hooks = hooks;
    this.store = new PhotoStore();
    this.urls = []; // picture addresses made for the list, let go when it closes
    this.viewing = null; // { rec, file, url, fromList }
    this._build();
  }

  // Either part of it is open (the game waits meanwhile).
  get open() {
    return !this.panel.hidden || !this.viewer.hidden;
  }

  _build() {
    // The way in: a row in Settings, above the credits.
    const settings = this.hooks.settings();
    const card = settings.querySelector(".panel-card");
    const row = el("div", "row");
    row.append(el("div", "label", "Photos"), el("button", "album-open", "Open"));
    card.insertBefore(row, card.querySelector(".credits"));
    row.querySelector("button").addEventListener("click", () => {
      settings.hidden = true;
      this.show();
    });

    this.panel = el("div", "panel");
    this.panel.hidden = true;
    this.panel.innerHTML = `<div class="panel-card album-card"><h2>Photos</h2><p class="note album-note"></p><div class="album-list"></div><button class="close">Back</button></div>`;
    this.note = this.panel.querySelector(".album-note");
    this.list = this.panel.querySelector(".album-list");
    this.panel.querySelector(".close").addEventListener("click", () => {
      this._hideList();
      settings.hidden = false;
    });

    this.viewer = el("div", "panel");
    this.viewer.hidden = true;
    this.viewer.innerHTML = `<div class="panel-card album-view"><img class="album-big" alt=""><p class="album-big-info"></p><div class="album-buttons"><button class="primary">Save picture</button><button class="secondary">Delete</button><button class="secondary">Back</button></div><p class="album-msg"></p></div>`;
    this.big = this.viewer.querySelector(".album-big");
    this.info = this.viewer.querySelector(".album-big-info");
    this.msg = this.viewer.querySelector(".album-msg");
    const [save, del, back] = this.viewer.querySelectorAll(".album-buttons button");
    this.delButton = del;
    // (The file is ready before the tap, so the share sheet can open as part of it.)
    save.addEventListener("click", () => this.viewing && this.hooks.deliver(this.viewing.file, (t) => (this.msg.textContent = t)));
    del.addEventListener("click", async () => {
      const v = this.viewing;
      if (!v?.rec.id) return;
      await this.store.remove(v.rec.id);
      this._back();
    });
    back.addEventListener("click", () => this._back());
    document.body.append(this.panel, this.viewer);
  }

  // A new photo, from the camera: kept if it can be (its id goes on it).
  async add(rec) {
    const id = await this.store.add(rec);
    if (id !== null) rec.id = id;
    return id;
  }

  // The list, from Settings.
  show() {
    this.panel.hidden = false;
    this._render();
  }

  async _render() {
    const all = await this.store.list();
    if (this.panel.hidden) return;
    this._letGo();
    this.list.textContent = "";
    if (!all) this.note.textContent = "Photos can't be kept on this device (private browsing may be on).";
    else if (!all.length) this.note.textContent = "No photos yet. A speed camera takes your picture when you drive past it over the limit, and a camera at the finish line takes one when you finish a race.";
    else this.note.textContent = `Newest first. The last ${KEEP} are kept.`;
    const units = this.hooks.units();
    for (const rec of all ?? []) {
      const url = URL.createObjectURL(new Blob([rec.jpeg], { type: "image/jpeg" }));
      this.urls.push(url);
      const item = el("div", "album-item");
      const open = el("button", "album-item-open");
      const img = el("img");
      img.src = url;
      img.alt = "";
      const text = el("span", "album-item-text");
      const kind = isFinish(rec) ? "finish" : "speed";
      text.append(el("span", `album-kind ${kind}`, KIND_NAMES[kind]));
      if (isFinish(rec)) text.append(el("b", "", `${rec.pos} place · ${rec.time}`), el("small", "", rec.race), el("small", "", dateWords(rec.taken, rec.clock)));
      else text.append(el("b", "", `${speedWords(rec.speed, units)} · limit ${limitWords(rec.limit, units)}`), el("small", "", rec.place), el("small", "", dateWords(rec.taken, rec.clock)));
      open.append(img, text);
      open.addEventListener("click", () => this.view(rec, true));
      const del = el("button", "album-delete", "Delete");
      del.addEventListener("click", async () => {
        await this.store.remove(rec.id);
        this._render();
      });
      item.append(open, del);
      this.list.append(item);
    }
  }

  // One photo, large: from the list, or straight from the card (`fromList` false).
  view(rec, fromList = false) {
    this._closeViewer();
    const blob = new Blob([rec.jpeg], { type: "image/jpeg" });
    const d = new Date(rec.taken);
    const two = (n) => String(n).padStart(2, "0");
    const name = `${isFinish(rec) ? "race-finish" : "speed-camera"}-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.jpg`;
    this.viewing = { rec, fromList, url: URL.createObjectURL(blob), file: new File([blob], name, { type: "image/jpeg" }) };
    const units = this.hooks.units();
    this.big.src = this.viewing.url;
    this.big.alt = isFinish(rec) ? "Your car crossing the finish line" : "Your car, caught by a speed camera";
    this.info.textContent = isFinish(rec) ? `${rec.pos} place in ${rec.time}` : `${speedWords(rec.speed, units)} where the limit is ${limitWords(rec.limit, units)}`;
    const small = el("small", "", `${isFinish(rec) ? rec.race : rec.place} · ${dateWords(rec.taken, rec.clock)}`);
    this.info.append(small);
    this.msg.textContent = "";
    // (Not kept, so nothing to delete.)
    this.delButton.hidden = !rec.id;
    this.panel.hidden = true;
    this.viewer.hidden = false;
  }

  // Back from one photo: to the list it came from, or to driving.
  _back() {
    const fromList = this.viewing?.fromList;
    this._closeViewer();
    if (fromList) this.show();
  }

  _closeViewer() {
    if (this.viewing) URL.revokeObjectURL(this.viewing.url);
    this.viewing = null;
    this.big.removeAttribute("src");
    this.viewer.hidden = true;
  }

  _hideList() {
    this.panel.hidden = true;
    this._letGo();
    this.list.textContent = "";
  }

  _letGo() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.length = 0;
  }
}
