// Range Bands Ruler — v1.5.0
// Works on Foundry v10–v12 (instance patch via _refreshTooltips/measure)
// and v13+ (instance patch via _formatDistance). No libWrapper needed.

const MODULE_ID = "range-bands-ruler";
const gp = (o, p) => (foundry?.utils?.getProperty ? foundry.utils.getProperty(o, p) : undefined);

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
    hint: "JSON array of {label,min,max} in scene units.",
    scope: "world",
    config: true,
    default: JSON.stringify(DEFAULT_BANDS, null, 2),
    type: String
  });
  game.settings.register(MODULE_ID, "showNumericFallback", {
    name: "Show Numeric in Parentheses",
    hint: "Append the numeric distance after the band label.",
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "hideBracketDistances", {
    name: "Hide Bracket Distances",
    hint: "Removes Foundry’s [segment total] from the label so the number appears only once.",
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    hint: "If enabled, only show bands when the ruler is snapped to the grid.",
    scope: "client",
    config: true,
    default: false,
    type: Boolean
  });
});

function getBands() {
  try {
    const a = JSON.parse(game.settings.get(MODULE_ID, "bands"));
    return Array.isArray(a) ? a : DEFAULT_BANDS;
  } catch {
    return DEFAULT_BANDS;
  }
}
function bandFor(d) {
  const arr = getBands();
  for (const b of arr) if (d >= b.min && d <= b.max) return b.label;
  return arr.length ? arr[arr.length - 1].label : String(d);
}
function parseNum(text) {
  const m = typeof text === "string" ? text.match(/(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : 0;
}
function cleanBaseText(t) {
  let s = String(t ?? "");
  if (game.settings.get(MODULE_ID, "hideBracketDistances")) s = s.replace(/\[.*?\]/g, "").trim();
  return s;
}
function shouldBand(ruler) {
  const only = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !only || Boolean(ruler?.snapped ?? true);
}
function makeBandedLabel(distance, baseText) {
  const base = cleanBaseText(baseText);
  if (!game.settings.get(MODULE_ID, "showNumericFallback")) return bandFor(distance);
  return `${bandFor(distance)} (${base})`;
}

// ---- v12 label post-process helpers ----
function getLabelNodes(ctx) {
  if (Array.isArray(ctx?.labels)) return ctx.labels;
  if (ctx?.labels?.children && Array.isArray(ctx.labels.children)) return ctx.labels.children;
  if (Array.isArray(ctx?.tooltips)) return ctx.tooltips;
  if (ctx?.tooltips?.children && Array.isArray(ctx.tooltips.children)) return ctx.tooltips.children;
  return [];
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
function postProcessLabels_v12(ctx) {
  if (!shouldBand(ctx)) return;

  const labelNodes = getLabelNodes(ctx);
  const segs = Array.isArray(ctx?.segments) ? ctx.segments : [];

  const apply = (lab, segDist) => {
    if (!lab || typeof lab.text !== "string") return;
    let base = stripBandWrappers(lab.text);
    base = cleanBaseText(base);
    const d = (segDist ?? parseNum(base)) || 0;
    lab.text = makeBandedLabel(d, base);
  };

  if (labelNodes.length && segs.length && labelNodes.length === segs.length) {
    for (let i = 0; i < labelNodes.length; i++) apply(labelNodes[i], segs[i]?.distance);
  } else {
    for (const lab of labelNodes) apply(lab, undefined);
  }
}

// ---- patch the live ruler instance (v12 & v13+) ----
function patchRulerInstance(ruler) {
  if (!ruler) return false;
  const gen = Number(gp(game, "release.generation")) || 12;

  // v13+ : wrap _formatDistance to return band text directly
  if (gen >= 13 && typeof ruler._formatDistance === "function" && !ruler._rbrPatchedFormat) {
    const origFD = ruler._formatDistance.bind(ruler);
    ruler._formatDistance = function (distance, ...rest) {
      const base = origFD(distance, ...rest); // "60 ft" (possibly with bracketed total)
      if (!shouldBand(this)) return base;
      const d = typeof distance === "number" ? distance : parseNum(base);
      return makeBandedLabel(d, base);
    };
    ruler._rbrPatchedFormat = true;
    console.log(`${MODULE_ID} | Patched v13 instance via _formatDistance`);
    return true;
  }

  // v12 fallback: patch _refreshTooltips, else patch measure
  if (gen < 13 && typeof ruler._refreshTooltips === "function" && !ruler._rbrPatchedTooltips) {
    const orig = ruler._refreshTooltips.bind(ruler);
    ruler._refreshTooltips = function (...args) {
      const out = orig(...args);
      try { postProcessLabels_v12(this); } catch (e) { console.warn(`${MODULE_ID} | _refreshTooltips patch failed`, e); }
      return out;
    };
    ruler._rbrPatchedTooltips = true;
    console.log(`${MODULE_ID} | Patched v12 instance via _refreshTooltips`);
    return true;
  }
  if (gen < 13 && typeof ruler.measure === "function" && !ruler._rbrPatchedMeasure) {
    const orig = ruler.measure.bind(ruler);
    ruler.measure = function (...args) {
      const out = orig(...args);
      try { postProcessLabels_v12(this); } catch (e) { console.warn(`${MODULE_ID} | measure patch failed`, e); }
      return out;
    };
    ruler._rbrPatchedMeasure = true;
    console.log(`${MODULE_ID} | Patched v12 instance via measure`);
    return true;
  }

  console.warn(`${MODULE_ID} | Could not find a method to patch on this ruler instance.`);
  return false;
}

function tryPatchCurrentRuler() {
  const r =
    gp(canvas, "controls.ruler") ||
    gp(canvas, "hud.ruler") ||
    game.ruler ||
    gp(ui, "controls.controls.ruler");
  if (r) patchRulerInstance(r);
}

// Patch when canvas is available and when UI/state changes might recreate the ruler.
Hooks.on("canvasReady", () => {
  console.log(`${MODULE_ID} | canvasReady — attempting instance patch`);
  tryPatchCurrentRuler();
});
Hooks.on("updateUser", () => tryPatchCurrentRuler());
Hooks.on("controlToken", () => tryPatchCurrentRuler());
Hooks.on("renderSceneControls", () => tryPatchCurrentRuler());

// Optional API
Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { repatch: () => tryPatchCurrentRuler() };
});
