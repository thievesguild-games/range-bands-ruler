// ============================================================================
// Range Bands Ruler  —  v1.5.18
// Thieves Guild Games
//
// Works with Foundry VTT v12 and v13
// - v13: uses _getWaypointLabelContext and computes live distance from segments
//        (segment.ray.distance in pixels -> scene units). No more d=0.
//        Keeps ctx.distance numeric; appends band to units: "m • Near"
//        (or just "Near" if you disable numeric).
// - v12: post-processes the PIXI labels after measurement/tooltip refresh.
//
// Requires: libWrapper (hard dependency in your manifest)
// Settings:
//   - bands (world, JSON): [{label,min,max}, ...] in scene units (feet, meters,
//     whatever your scene uses)
//   - showNumericFallback (client)
//   - hideBracketDistances (client)
//   - bandWhenSnappedOnly (client)
// Debugging:
//   - set DEBUG_RBR = true to log computed distances and bands in v13
// ============================================================================

const MODULE_ID = "range-bands-ruler";
const DEBUG_RBR = false; // flip true while testing to see d/units/band in console

// Foundry-safe getProperty
const gp = (obj, path) => foundry?.utils?.getProperty ? foundry.utils.getProperty(obj, path) : undefined;

/* ---------------- Settings ---------------- */

const DEFAULT_BANDS = [
  { label: "Melee",   min: 0,  max: 5  },
  { label: "Close",   min: 6,  max: 10 },
  { label: "Near",    min: 11, max: 20 },
  { label: "Far",     min: 21, max: 40 },
  { label: "Distant", min: 41, max: 80 },
  { label: "Extreme", min: 81, max: 999999 }
];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "bands", {
    name: "Range Bands",
    hint: "JSON array of {label,min,max} in scene units.",
    scope: "world", config: true, type: String,
    default: JSON.stringify(DEFAULT_BANDS, null, 2)
  });
  game.settings.register(MODULE_ID, "showNumericFallback", {
    name: "Show Numeric in Parentheses",
    hint: "Show the numeric distance alongside the band.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "hideBracketDistances", {
    name: "Hide Bracket Distances",
    hint: "Strip Foundry’s [segment total] from labels.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    hint: "Only show bands when the ruler is snapped to grid.",
    scope: "client", config: true, type: Boolean, default: false
  });
});

/* ---------------- Utilities ---------------- */

function isV13Plus() {
  const gen = Number(gp(game, "release.generation"));
  return Number.isFinite(gen) ? gen >= 13 : Number((game?.version || "0").split(".")[0]) >= 13;
}

function getBands() {
  try {
    const parsed = JSON.parse(game.settings.get(MODULE_ID, "bands"));
    if (Array.isArray(parsed)) {
      // normalize & sort (gap-safe, order-agnostic)
      return parsed
        .map(b => ({ label: String(b.label), min: Number(b.min), max: Number(b.max) }))
        .filter(b => Number.isFinite(b.min) && Number.isFinite(b.max))
        .sort((a, b) => a.min - b.min);
    }
  } catch { /* ignore */ }
  return DEFAULT_BANDS;
}

function bandFor(d) {
  const arr = getBands();
  let chosen = arr.length ? arr[arr.length - 1].label : `${d}`;
  for (const b of arr) {
    if (d >= b.min && d <= b.max) { chosen = b.label; break; }
  }
  return chosen;
}

function parseNum(text) {
  const m = typeof text === "string" ? text.match(/(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : 0;
}

function cleanBase(t) {
  let s = String(t ?? "");
  if (game.settings.get(MODULE_ID, "hideBracketDistances")) s = s.replace(/\[.*?\]/g, "").trim();
  return s;
}

function stripBandWrappers(text) {
  let t = String(text ?? "");
  for (let i = 0; i < 6; i++) {
    const m = t.match(/^\s*[^()]+?\s*\((.*)\)\s*$/);
    if (!m) break;
    t = m[1];
  }
  return t.trim();
}

function shouldBand(ruler) {
  const only = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !only || Boolean(ruler?.snapped ?? true);
}

/** v13: compute live distance from segments/waypoints */
function computeLiveDistanceV13(ruler) {
  // Prefer segments (supports multi-waypoint rulers)
  const segs = ruler?.segments;
  const dim  = canvas?.dimensions;
  if (Array.isArray(segs) && dim) {
    const unitsPerPixel = (dim.distance ?? 1) / (dim.size ?? 1);
    let total = 0;
    for (const s of segs) {
      if (s?.ray?.distance != null) {
        total += s.ray.distance * unitsPerPixel;        // v13: pixels -> scene units
      } else if (typeof s?.distance === "number") {
        total += s.distance;                             // fallback (v12-style)
      }
    }
    if (total > 0) return total;
  }

  // Fallback: compute straight-line between first/last waypoint
  const wps = ruler?.waypoints;
  if (Array.isArray(wps) && wps.length >= 2 && dim) {
    const a = wps[0], b = wps[wps.length - 1];
    const dx = (b.x ?? 0) - (a.x ?? 0);
    const dy = (b.y ?? 0) - (a.y ?? 0);
    const pixels = Math.hypot(dx, dy);
    const unitsPerPixel = (dim.distance ?? 1) / (dim.size ?? 1);
    const dist = pixels * unitsPerPixel;
    if (dist > 0) return dist;
  }

  return 0;
}

function makeBandedText(distance, baseText) {
  const band = bandFor(distance);
  const base = cleanBase(baseText);
  if (!game.settings.get(MODULE_ID, "showNumericFallback")) return band;
  return `${band} (${base})`;
}

function getSceneUnits() {
  return String(canvas?.scene?.grid?.units ?? "").trim();
}

/* ---------------- v12 patches (instance post-process) ---------------- */

function getLabelNodes(ctx) {
  if (Array.isArray(ctx?.labels)) return ctx.labels;
  if (ctx?.labels?.children && Array.isArray(ctx.labels.children)) return ctx.labels.children;
  if (Array.isArray(ctx?.tooltips)) return ctx.tooltips;
  if (ctx?.tooltips?.children && Array.isArray(ctx.tooltips.children)) return ctx.tooltips.children;
  return [];
}

function postProcessLabelsV12(ruler) {
  if (!shouldBand(ruler)) return;

  const nodes = getLabelNodes(ruler);
  const segs  = Array.isArray(ruler?.segments) ? ruler.segments : [];

  const apply = (lab, segDist) => {
    if (!lab || typeof lab.text !== "string") return;
    let base = stripBandWrappers(lab.text);
    base = cleanBase(base);
    const d = (segDist ?? parseNum(base)) || 0;
    lab.text = makeBandedText(d, base);
  };

  if (nodes.length && segs.length && nodes.length === segs.length) {
    for (let i = 0; i < nodes.length; i++) apply(nodes[i], segs[i]?.distance);
  } else {
    for (const lab of nodes) apply(lab, undefined);
  }
}

function patchInstanceV12(ruler) {
  if (!ruler) return false;

  if (typeof ruler._refreshTooltips === "function" && !ruler._rbrPatchedTooltips) {
    const orig = ruler._refreshTooltips.bind(ruler);
    ruler._refreshTooltips = function (...args) {
      const out = orig(...args);
      try { postProcessLabelsV12(this); } catch (e) { console.warn(`${MODULE_ID} | v12 _refreshTooltips patch failed`, e); }
      return out;
    };
    ruler._rbrPatchedTooltips = true;
    console.log(`${MODULE_ID} | v12: patched via _refreshTooltips`);
    return true;
  }

  if (typeof ruler.measure === "function" && !ruler._rbrPatchedMeasure) {
    const orig = ruler.measure.bind(ruler);
    ruler.measure = function (...args) {
      const out = orig(...args);
      try { postProcessLabelsV12(this); } catch (e) { console.warn(`${MODULE_ID} | v12 measure patch failed`, e); }
      return out;
    };
    ruler._rbrPatchedMeasure = true;
    console.log(`${MODULE_ID} | v12: patched via measure`);
    return true;
  }

  console.warn(`${MODULE_ID} | v12: no instance method to patch`);
  return false;
}

function tryPatchCurrentRulerV12() {
  const r = gp(canvas, "controls.ruler") || gp(canvas, "hud.ruler") || game.ruler || gp(ui, "controls.controls.ruler");
  if (r) patchInstanceV12(r);
}

/* ---------------- v13 patches (prototype via libWrapper) ---------------- */

function getRulerClass() {
  return gp(foundry, "canvas.interaction.Ruler") || gp(CONFIG, "Canvas.rulerClass") || globalThis.Ruler;
}

function patchPrototypeV13() {
  const R = getRulerClass();
  if (!R?.prototype) {
    console.warn(`${MODULE_ID} | v13: Ruler prototype not found; will retry.`);
    return false;
  }

  const proto = R.prototype;

  // Preferred: modify waypoint context (HTML pill)
  if (typeof proto._getWaypointLabelContext === "function" && !proto._rbrPatchedWLC) {
    libWrapper.register(
      MODULE_ID,
      proto._getWaypointLabelContext,
      function (wrapped, ...args) {
        const ctx = wrapped.apply(this, args);
        try {
          if (!ctx || !shouldBand(this)) return ctx;

          // distance may be 0/undefined here -> compute live
          let d = (typeof ctx.distance === "number" ? ctx.distance : 0);
          if (!d || d <= 0) d = computeLiveDistanceV13(this);

          const band = bandFor(d);
          const units = getSceneUnits();

          if (DEBUG_RBR) console.log(`[${MODULE_ID}] d=${d} units=${units} band=${band}`);

          if (game.settings.get(MODULE_ID, "showNumericFallback")) {
            // pill: "14.5 m • Near"
            ctx.units = units ? `${units} • ${band}` : band;
            // leave ctx.distance numeric
          } else {
            // pill: "Near"
            ctx.units = band;
            ctx.distance = ""; // show only the band
          }

          if (game.settings.get(MODULE_ID, "hideBracketDistances") && typeof ctx.units === "string") {
            ctx.units = ctx.units.replace(/\[.*?\]/g, "").trim();
          }
        } catch (e) {
          console.warn(`${MODULE_ID} | v13 _getWaypointLabelContext patch failed`, e);
        }
        return ctx;
      },
      "WRAPPER"
    );
    proto._rbrPatchedWLC = true;
    console.log(`${MODULE_ID} | v13: patched via _getWaypointLabelContext`);
  }

  // Fallback: after refresh, rewrite any PIXI labels (rarely needed in v13)
  if (typeof proto._refresh === "function" && !proto._rbrPatchedRefresh) {
    libWrapper.register(
      MODULE_ID,
      proto._refresh,
      function (wrapped, ...args) {
        const out = wrapped.apply(this, args);
        try {
          if (!shouldBand(this)) return out;
          const nodes = (this?.labels?.children && Array.isArray(this.labels.children)) ? this.labels.children
                      : (this?.tooltips?.children && Array.isArray(this.tooltips.children)) ? this.tooltips.children
                      : [];
          for (const lab of nodes) {
            if (!lab || typeof lab.text !== "string") continue;
            const base = cleanBase(stripBandWrappers(lab.text));
            const d    = parseNum(base);
            lab.text   = makeBandedText(d || 0, base);
          }
        } catch (e) { console.warn(`${MODULE_ID} | v13 _refresh fallback failed`, e); }
        return out;
      },
      "WRAPPER"
    );
    proto._rbrPatchedRefresh = true;
    console.log(`${MODULE_ID} | v13: patched prototype via _refresh (fallback)`);
  }

  return true;
}

function tryPatchV13WithRetries() {
  const ok = patchPrototypeV13();
  if (ok) return;
  // retry shortly (class may be set up a tick later)
  setTimeout(() => patchPrototypeV13(), 200);
  Hooks.once("renderSceneControls", () => patchPrototypeV13());
}

/* ---------------- Lifecycle ---------------- */

Hooks.once("ready", () => {
  if (isV13Plus()) {
    tryPatchV13WithRetries();
  } else {
    tryPatchCurrentRulerV12();
  }
});

Hooks.on("canvasReady", () => {
  if (isV13Plus()) {
    tryPatchV13WithRetries();
  } else {
    tryPatchCurrentRulerV12();
  }
});
