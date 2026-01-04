(function (global) {
  "use strict";

  // PetEngine.js (classic script)
  // - 32x32 logical pixel art -> rendered to a 64x64 canvas (nearest-neighbor).
  // - Renders from Character JSON (layers/variants) + Accessories JSON (assets).

  function _unwrap(j) {
    return (j && typeof j === "object" && j.content) ? j.content : j;
  }

  class PetEngine {
    /**
     * @param {{canvas: HTMLCanvasElement, debug?: boolean, pixelSize?: number}} opts
     */
    constructor(opts) {
      if (!opts || !opts.canvas) throw new Error("PetEngine: canvas is required");
      this.canvas = opts.canvas;
      this.debug = !!opts.debug;

      this.ctx = this.canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (!this.ctx) throw new Error("PetEngine: 2D context unavailable");
      this.ctx.imageSmoothingEnabled = false;

      // Fixed display size: 64x64 (2x scale)
      this.canvas.width = 64;
      this.canvas.height = 64;

      // Internal 32x32 buffer
      this._buf = document.createElement("canvas");
      this._buf.width = 32;
      this._buf.height = 32;
      this._bctx = this._buf.getContext("2d", { alpha: true });
      this._bctx.imageSmoothingEnabled = false;

      this._img = this._bctx.createImageData(32, 32);

      // last loaded data (optional)
      this._char = null;
      this._acc = null;

      this.clear();
    }

    clear() {
      this._img.data.fill(0);
      this._bctx.putImageData(this._img, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    async loadCharacterFromURL(url) {
      const j = await this._fetchJSON(url);
      this._char = _unwrap(j);
      return this._char;
    }

    async loadAccessoriesFromURL(url) {
      const j = await this._fetchJSON(url);
      this._acc = _unwrap(j);
      return this._acc;
    }

    async _fetchJSON(url) {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`PetEngine: fetch failed ${res.status} ${url}`);
      return await res.json();
    }

    // Accept both:
    // - Spec format: {layers:{base:{pixels}}, variants:{eyes:{...}, mouth:{...}, extra?...}}
    // - Legacy format: {layers:{base:{pixels}, eyes:{normal:{pixels}...}, mouth:{idle...}, extra?...}}
    _normalizeCharacter(char) {
      if (!char || typeof char !== "object") return char;
      if (char.variants && char.layers?.base) return char;

      const out = { ...char };

      // normalize size
      if (typeof out.size === "number") out.size = [out.size, out.size];

      // normalize anchors to {x,y}
      if (out.anchors && typeof out.anchors === "object") {
        const normOne = (v) => {
          if (Array.isArray(v) && v.length === 2) return { x: v[0] | 0, y: v[1] | 0 };
          if (v && typeof v === "object" && typeof v.x === "number" && typeof v.y === "number") return { x: v.x | 0, y: v.y | 0 };
          return undefined;
        };
        const head = normOne(out.anchors.head);
        const fx = normOne(out.anchors.fx);
        out.anchors = { ...out.anchors };
        if (head) out.anchors.head = head;
        if (fx) out.anchors.fx = fx;
      }

      // build variants from legacy layers
      const layers = out.layers && typeof out.layers === "object" ? out.layers : {};
      const v = out.variants && typeof out.variants === "object" ? out.variants : {};

      const legacyEyes = layers.eyes && typeof layers.eyes === "object" ? layers.eyes : null;
      const legacyMouth = layers.mouth && typeof layers.mouth === "object" ? layers.mouth : null;
      const legacyExtra = layers.extra && typeof layers.extra === "object" ? layers.extra : null;

      // Sometimes eyes/mouth were stored directly under layers with a "pixels" key (spec), so ignore those.
      const isVariantMap = (obj) => obj && !Array.isArray(obj) && typeof obj === "object" && !obj.pixels;

      if (!v.eyes && isVariantMap(legacyEyes)) v.eyes = legacyEyes;
      if (!v.mouth && isVariantMap(legacyMouth)) v.mouth = legacyMouth;
      if (!v.extra && isVariantMap(legacyExtra)) v.extra = legacyExtra;

      // Also support files where variants lived at top-level (rare)
      if (!v.eyes && out.eyes && typeof out.eyes === "object") v.eyes = out.eyes;
      if (!v.mouth && out.mouth && typeof out.mouth === "object") v.mouth = out.mouth;

      out.variants = v;

      // base layer: if legacy kept base at layers.base it's already fine.
      if (!out.layers || typeof out.layers !== "object") out.layers = {};
      if (!out.layers.base && layers.base) out.layers.base = layers.base;

      return out;
    }

    /**
     * Render one frame.
     * @param {{
     *  char?: any,
     *  accessories?: any,
     *  eyesVariant?: string,
     *  mouthVariant?: string,
     *  extraVariant?: string,
     *  equip?: {head?: string|null, fx?: string|null}
     * }} args
     */
    renderPet(args) {
      const char0 = _unwrap(args?.char) || this._char;
      const char = this._normalizeCharacter(char0);
      const accessories = _unwrap(args?.accessories) || this._acc;

      if (!char || !char.palette) return;

      const pal = char.palette;
      const data = this._img.data;
      data.fill(0);

      const paint = (pxList, dx = 0, dy = 0) => {
        if (!Array.isArray(pxList)) return;
        for (const p of pxList) {
          const x = (p[0] | 0) + dx;
          const y = (p[1] | 0) + dy;
          const ci = p[2] | 0;
          if (x < 0 || x >= 32 || y < 0 || y >= 32) continue;
          const hex = pal[ci];
          if (!hex || hex.length < 7) continue;
          const off = (y * 32 + x) * 4;
          data[off + 0] = parseInt(hex.slice(1, 3), 16);
          data[off + 1] = parseInt(hex.slice(3, 5), 16);
          data[off + 2] = parseInt(hex.slice(5, 7), 16);
          data[off + 3] = 255;
        }
      };

      // base
      paint(char.layers?.base?.pixels);

      // eyes/mouth
      const eyesKey = args?.eyesVariant || char.defaults?.eyes || "normal";
      const mouthKey = args?.mouthVariant || char.defaults?.mouth || "idle";
      paint(char.variants?.eyes?.[eyesKey]?.pixels);
      paint(char.variants?.mouth?.[mouthKey]?.pixels);

      // extra (optional)
      const extraKey = args?.extraVariant;
      if (extraKey && extraKey !== "default") {
        paint(char.variants?.extra?.[extraKey]?.pixels);
      }

      // accessories (optional): assets are absolute coordinates in 32x32
      const equip = args?.equip || {};
      if (accessories && Array.isArray(accessories.assets)) {
        const byId = new Map();
        for (const a of accessories.assets) if (a && a.id) byId.set(a.id, a);
        const headId = equip.head || null;
        const fxId = equip.fx || null;
        if (headId && byId.has(headId)) paint(byId.get(headId).pixels);
        if (fxId && byId.has(fxId)) paint(byId.get(fxId).pixels);
      }

      // flush: 32x32 -> 64x64 nearest
      this._bctx.putImageData(this._img, 0, 0);
      this.ctx.clearRect(0, 0, 64, 64);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this._buf, 0, 0, 64, 64);
    }

  }

  global.PetEngine = PetEngine;
})(typeof window !== "undefined" ? window : self);
