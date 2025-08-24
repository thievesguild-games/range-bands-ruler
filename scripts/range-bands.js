// ============================================================================
// Range Bands Ruler  —  v1.5.24
// Thieves Guild Games
//
// v12 + v13 support. For v13 we:
//   • Compute one distance from segments/waypoints (pixels → scene units)
//   • Round once and set ctx.distance to that value
//   • Choose the band from the same rounded value (no desync)
//   • Append band to the pill units: "m • Near" (or just "Near" if numeric hidden)
//
// Settings:
//   - bands (world, JSON of {label,min,max} in scene units)
//   - showNumericFallback (client)
//   - hideBracketDistances (client)
//   - bandWhenSnappedOnly (client)
//
// Debugging:
//   - DEBUG_RBR = true logs d/units/band each move.
// ============================================================================

const MODULE_ID = "range-bands-ruler";
const DEBUG_RBR = true; // keep on while verifying

const gp = (obj, path) => (foundry?.utils?.getProperty ? foundry.utils.getProperty(obj, path) : undefined);

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
      return parsed
        .map(b => ({ label: String(b.label), min: Number(b.min), max: Number(b.max) }))
        .filter(b => Number.isFinite(b.min) && Number.isFinite(b.max))
        .sort((a, b) => a.min - b.min);
    }
  } catch {}
  return DEFAULT_BANDS;
}

/** Gap-safe band selection (fills gaps toward the *earlier* band). */
function bandFor(d) {
  const EPS = 1e-6;
  const arr = getBands().slice().sort((a, b) => a.max - b.max);
  if (!arr.length) return `${d}`;
  if (d < arr[0].min - EPS) return arr[0].label;
  for (const b of arr) if (d <= b.max + EPS) return b.label;
  return arr[arr.length - 1].label;
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

function getSceneUnits() {
  return String(canvas?.scene?.grid?.units ?? "").trim();
}

/* ---------------- Distance recovery (v13) ---------------- */

function toPointArray(maybe) {
  if (!maybe) return [];
  if (Array.isArray(maybe)) return maybe;
  try { if (typeof maybe[Symbol.iterator] === "function") return Array.from(maybe); } catch {}
  if (maybe.children && Array.isArray(maybe.children)) return maybe.children;
  return [];
}

function computeLiveDistanceV13(ruler, ctxPosition) {
  const dim = canvas?.dimensions;
  if (!dim) return 0;
  const upp = (dim.distance ?? 1) / (dim.size ?? 1);

  // Prefer last segment's ray.distance (pixels)
  const segs = ruler?.segments;
  if (Array.isArray(segs) && segs.length) {
    const last = segs[segs.length - 1];
    if (last?.ray?.distance != null) return last.ray.distance * upp;

    let sum = 0;
    for (const s of segs) {
      if (s?.ray?.distance != null) sum += s.ray.distance * upp;
      else if (typeof s?.distance === "number") sum += s.distance;
    }
    if (sum > 0) return sum;
  }

  // Fallback: origin/first waypoint → ctx.position
  const wps = toPointArray(ruler?.waypoints);
  let start = wps.length ? wps[0] : (ruler?.origin || ruler?._origin || ruler?._from || null);
  const end = ctxPosition || ruler?._to || ruler?.destination || null;

  if (start && end && start.x != null && start.y != null && end.x != null && end.y != null) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const pixels = Math.hypot(dx, dy);
    return pixels * upp;
  }

  if (DEBUG_RBR) {
    console.log(`[${MODULE_ID}] DEBUG: could not compute distance.`,
      { segs: Array.isArray(segs) ? segs.length : typeof segs,
        lastRay: segs?.at?.(-1)?.ray,
        wpsType: typeof ruler?.waypoints,
        wpsLen: toPointArray(ruler?.waypoints).length,
        start,
        end: ctxPosition });
  }
  return 0;
}

/* ---------------- v12 patches (instance) ---------------- */

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
    lab.text = `${bandFor(d)} (${base})`;
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

/* ---------------- v13 patches (prototype, no libWrapper) ---------------- */

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

  if (typeof proto._getWaypointLabelContext === "function" && !proto._rbrPatchedWLC) {
    const orig = proto._getWaypointLabelContext;
    proto._getWaypointLabelContext = function (...args) {
      const ctx = orig.apply(this, args);
      try {
        if (!ctx || !shouldBand(this)) return ctx;

        // Compute ONCE and round ONCE; use this value everywhere
        const raw = computeLiveDistanceV13(this, ctx.position);
        const dRounded = Number((raw ?? 0).toFixed(2));
        const units = getSceneUnits();

        // Keep the pill numeric in sync with the band decision
        ctx.distance = dRounded;

        const band = bandFor(dRounded);
        if (DEBUG_RBR) console.log(`[${MODULE_ID}] d=${dRounded} units=${units} band=${band}`);

        if (game.settings.get(MODULE_ID, "showNumericFallback")) {
          ctx.units = units ? `${units} • ${band}` : band; // e.g., "4.92 m • Close"
        } else {
          ctx.units = band;
          ctx.distance = ""; // show only the band text
        }

        if (game.settings.get(MODULE_ID, "hideBracketDistances") && typeof ctx.units === "string") {
          ctx.units = ctx.units.replace(/\[.*?\]/g, "").trim();
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | v13 _getWaypointLabelContext patch failed`, e);
      }
      return ctx;
    };
    proto._rbrPatchedWLC = true;
    console.log(`${MODULE_ID} | v13: patched via _getWaypointLabelContext`);
  }

  if (typeof proto._refresh === "function" && !proto._rbrPatchedRefresh) {
    const orig = proto._refresh;
    proto._refresh = function (...args) {
      const out = orig.apply(this, args);
      try {
        if (!shouldBand(this)) return out;
        const nodes = (this?.labels?.children && Array.isArray(this.labels.children)) ? this.labels.children
                    : (this?.tooltips?.children && Array.isArray(this.tooltips.children)) ? this.tooltips.children
                    : [];
        for (const lab of nodes) {
          if (!lab || typeof lab.text !== "string") continue;
          const base = cleanBase(stripBandWrappers(lab.text));
          const d    = parseNum(base);
          lab.text   = `${bandFor(d || 0)} (${base})`;
        }
      } catch (e) { console.warn(`${MODULE_ID} | v13 _refresh fallback failed`, e); }
      return out;
    };
    proto._rbrPatchedRefresh = true;
    console.log(`${MODULE_ID} | v13: patched prototype via _refresh (fallback)`);
  }

  return true;
}

function tryPatchV13WithRetries() {
  const ok = patchPrototypeV13();
  if (ok) return;
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
