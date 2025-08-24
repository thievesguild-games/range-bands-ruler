// Range Bands Ruler — v1.5.17
// v12 + v13, with robust distance caching for v13 pills

const MODULE_ID = "range-bands-ruler";
// Turn on while testing to see the distance and band in the console
const DEBUG_RBR = true;

const gp = (o, p) => (foundry?.utils?.getProperty ? foundry.utils.getProperty(o, p) : undefined);

/* ---------------- Settings ---------------- */
const DEFAULT_BANDS = [
  { label: "Contact", min: 0,  max: 1 },
  { label: "Close",   min: 1,  max: 5 },
  { label: "Near",    min: 6,  max: 15 },
  { label: "Far",     min: 16, max: 30 },
  { label: "Distant", min: 31, max: 120 },
  { label: "Extreme", min: 121, max: 999999 }
];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "bands", {
    name: "Range Bands",
    hint: "JSON array of {label,min,max} in scene units (units-agnostic).",
    scope: "world", config: true,
    default: JSON.stringify(DEFAULT_BANDS, null, 2), type: String
  });
  game.settings.register(MODULE_ID, "showNumericFallback", {
    name: "Show Numeric in Parentheses",
    hint: "Append the numeric distance after the band label.",
    scope: "client", config: true, default: true, type: Boolean
  });
  game.settings.register(MODULE_ID, "hideBracketDistances", {
    name: "Hide Bracket Distances",
    hint: "Remove Foundry’s [segment total] so the number appears only once.",
    scope: "client", config: true, default: true, type: Boolean
  });
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    hint: "Only show bands when the ruler is snapped to the grid.",
    scope: "client", config: true, default: false, type: Boolean
  });
});

/* ---------------- Helpers ---------------- */
function getBands() {
  try {
    const raw = JSON.parse(game.settings.get(MODULE_ID, "bands"));
    return Array.isArray(raw) ? raw : DEFAULT_BANDS;
  } catch {
    return DEFAULT_BANDS;
  }
}

/** robust band lookup (sorted, numeric, gap-safe) */
function bandFor(d) {
  const arr = getBands()
    .map(b => ({ label: String(b.label), min: Number(b.min), max: Number(b.max) }))
    .filter(b => Number.isFinite(b.min) && Number.isFinite(b.max))
    .sort((a, b) => a.min - b.min);

  let chosen = arr.length ? arr[arr.length - 1].label : String(d);
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
function shouldBand(ruler) {
  const only = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !only || Boolean(ruler?.snapped ?? true);
}
function makeBanded(distance, baseText) {
  const base = cleanBase(baseText);
  if (!game.settings.get(MODULE_ID, "showNumericFallback")) return bandFor(distance);
  return `${bandFor(distance)} (${base})`;
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
function getLabelNodes(ctx) {
  if (Array.isArray(ctx?.labels)) return ctx.labels;
  if (ctx?.labels?.children && Array.isArray(ctx.labels.children)) return ctx.labels.children;
  if (Array.isArray(ctx?.tooltips)) return ctx.tooltips;
  if (ctx?.tooltips?.children && Array.isArray(ctx.tooltips.children)) return ctx.tooltips.children;
  return [];
}
function isV13Plus() {
  const gen = Number(gp(game, "release.generation"));
  return Number.isFinite(gen) ? gen >= 13 : (Number((game?.version || "0").split(".")[0]) >= 13);
}

/* ---- v13 distance cache (shared across hooks) ---- */
let LAST_DISTANCE = 0; // in scene units
function setLastDistance(d) {
  if (Number.isFinite(d) && d > 0) LAST_DISTANCE = d;
}
function getLastDistance() {
  return LAST_DISTANCE || 0;
}

/* ---------------- v12: instance post-process ---------------- */
function postProcessLabelsV12(ctx) {
  if (!shouldBand(ctx)) return;
  const nodes = getLabelNodes(ctx);
  const segs  = Array.isArray(ctx?.segments) ? ctx.segments : [];

  const apply = (lab, segDist) => {
    if (!lab || typeof lab.text !== "string") return;
    let base = stripBandWrappers(lab.text);
    base = cleanBase(base);
    const d = (segDist ?? parseNum(base)) || 0;
    lab.text = makeBanded(d, base);
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

/* ---------------- v13: prototype patch ---------------- */
function getRulerProtos() {
  const candidates = [
    gp(foundry, "canvas.interaction.Ruler"),
    gp(CONFIG, "Canvas.rulerClass"),
    globalThis.Ruler
  ].filter(Boolean);
  return candidates.map(C => C && C.prototype).filter(Boolean);
}

function patchPrototypeV13() {
  let patchedAny = false;

  for (const proto of getRulerProtos()) {
    if (!proto) continue;

    // Preferred: modify waypoint context for the HTML pill
    if (typeof proto._getWaypointLabelContext === "function" && !proto._rbrPatchedWLC) {
      const orig = proto._getWaypointLabelContext;
      proto._getWaypointLabelContext = function (...args) {
        const ctx = orig.apply(this, args);
        try {
          if (!ctx || !shouldBand(this)) return ctx;

          // Some builds pass distance later; fall back to our cached value.
          let dNum = (typeof ctx.distance === "number" ? ctx.distance : 0) || getLastDistance();

          // Derive plain units from scene (don't reuse formatted ctx.units)
          const sceneUnits = String(canvas?.scene?.grid?.units ?? ctx.units ?? "").trim();
          const band = bandFor(dNum);

          if (DEBUG_RBR) console.log(`[${MODULE_ID}] d=${dNum} units=${sceneUnits} band=${band}`);

          if (game.settings.get(MODULE_ID, "showNumericFallback")) {
            ctx.units = sceneUnits ? `${sceneUnits} • ${band}` : band;  // pill: "14.5 m • Near"
            // ctx.distance remains numeric (could be last cached)
          } else {
            ctx.units = band;   // pill: "Near"
            ctx.distance = "";  // show only the band
          }

          if (game.settings.get(MODULE_ID, "hideBracketDistances") && typeof ctx.units === "string") {
            ctx.units = ctx.units.replace(/\[.*?\]/g, "").trim();
          }
        } catch (e) {
          console.warn(`${MODULE_ID} | v13 _getWaypointLabelContext pill patch failed`, e);
        }
        return ctx;
      };
      proto._rbrPatchedWLC = true;
      patchedAny = true;
      console.log(`${MODULE_ID} | v13: patched _getWaypointLabelContext (using cached distance)`);
    }

    // Safety net 1: some systems compose label text in segment style.
    if (typeof proto._getSegmentStyle === "function" && !proto._rbrPatchedSegStyle) {
      const orig = proto._getSegmentStyle;
      proto._getSegmentStyle = function (...args) {
        const style = orig.apply(this, args) ?? {};
        try {
          if (!shouldBand(this)) return style;

          const key = "label" in style ? "label" : ("text" in style ? "text" : null);
          if (key && typeof style[key] === "string") {
            const base = cleanBase(stripBandWrappers(style[key]));
            const d    = parseNum(base);
            setLastDistance(d); // <-- cache numeric for pill
            style[key] = makeBanded(d || 0, base);
          }
        } catch (e) { console.warn(`${MODULE_ID} | v13 _getSegmentStyle patch failed`, e); }
        return style;
      };
      proto._rbrPatchedSegStyle = true;
      patchedAny = true;
      console.log(`${MODULE_ID} | v13: patched prototype via _getSegmentStyle (caching distance)`);
    }

    // Safety net 2: rewrite PIXI nodes after refresh and cache numeric
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
            setLastDistance(d); // <-- cache numeric for pill
            lab.text   = makeBanded(d || 0, base);
          }
        } catch (e) { console.warn(`${MODULE_ID} | v13 prototype _refresh fallback failed`, e); }
        return out;
      };
      proto._rbrPatchedRefresh = true;
      patchedAny = true;
      console.log(`${MODULE_ID} | v13: patched prototype via _refresh (fallback + cache)`);
    }
  }

  if (!patchedAny) console.warn(`${MODULE_ID} | v13: could not patch any Ruler prototype; will retry.`);
  return patchedAny;
}

/* ---------------- Lifecycle ---------------- */
function tryPatchV13WithRetries() {
  let ok = patchPrototypeV13();
  if (ok) return;
  setTimeout(() => patchPrototypeV13(), 200);
  Hooks.once("renderSceneControls", () => patchPrototypeV13());
}

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
