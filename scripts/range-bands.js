// Range Bands Ruler — v1.5.1
// v12: instance patch (tooltips/measure)  |  v13+: prototype patch (_formatDistance via libWrapper)
// Keeps: Show Numeric in Parentheses, Hide Bracket Distances, Only When Snapped

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
    hint: "Removes Foundry’s [segment total] so the number appears only once.",
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
  } catch { return DEFAULT_BANDS; }
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

/* -------------------- v12 helpers (post-process labels) -------------------- */
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

/* -------------------- v12 instance patch -------------------- */
function patchRulerInstance_v12(ruler) {
  if (!ruler) return false;

  if (typeof ruler._refreshTooltips === "function" && !ruler._rbrPatchedTooltips) {
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

  if (typeof ruler.measure === "function" && !ruler._rbrPatchedMeasure) {
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

  console.warn(`${MODULE_ID} | v12: Could not find a method to patch on this ruler instance.`);
  return false;
}

function tryPatchCurrentRuler_v12() {
  const r =
    gp(canvas, "controls.ruler") ||
    gp(canvas, "hud.ruler") ||
    game.ruler ||
    gp(ui, "controls.controls.ruler");
  if (r) patchRulerInstance_v12(r);
}

/* -------------------- v13+ prototype patch via libWrapper -------------------- */
function patchPrototype_v13() {
  const gen = Number(gp(game, "release.generation")) || 0;
  if (gen < 13) return false;

  const lw = game.modules.get("lib-wrapper");
  const RulerClass = gp(CONFIG, "Canvas.rulerClass") ?? globalThis.Ruler;
  const className = RulerClass?.name || "Ruler";

  // Prefer libWrapper (string target form)
  if (lw?.active) {
    const path = `${className}.prototype._formatDistance`;
    const exists = !!gp(globalThis, path);
    console.log(`${MODULE_ID} | v13: ${exists ? "Hooking" : "Missing"} ${path}`);
    if (exists) {
      libWrapper.register(MODULE_ID, path, function (wrapped, distance, ...rest) {
        const base = wrapped(distance, ...rest); // "60 ft"
        if (!shouldBand(this)) return base;
        const d = typeof distance === "number" ? distance : parseNum(base);
        return makeBandedLabel(d, base);
      }, "WRAPPER");
      return true;
    }
  }

  // Fallback: monkey-patch prototype directly if libWrapper missing
  const proto = RulerClass?.prototype;
  if (proto && typeof proto._formatDistance === "function" && !proto._rbrPatchedFormat) {
    const orig = proto._formatDistance;
    proto._formatDistance = function (distance, ...rest) {
      const base = orig.call(this, distance, ...rest);
      if (!shouldBand(this)) return base;
      const d = typeof distance === "number" ? distance : parseNum(base);
      return makeBandedLabel(d, base);
    };
    proto._rbrPatchedFormat = true;
    console.log(`${MODULE_ID} | v13: Patched prototype via _formatDistance (no libWrapper)`);
    return true;
  }

  console.warn(`${MODULE_ID} | v13: Could not find _formatDistance to patch.`);
  return false;
}

/* -------------------- lifecycle -------------------- */
Hooks.on("canvasReady", () => {
  const gen = Number(gp(game, "release.generation")) || 12;
  if (gen >= 13) {
    patchPrototype_v13();
  } else {
    console.log(`${MODULE_ID} | canvasReady — attempting v12 instance patch`);
    tryPatchCurrentRuler_v12();
  }
});

// Also try on ready (useful if canvas already mounted)
Hooks.once("ready", () => {
  const gen = Number(gp(game, "release.generation")) || 12;
  if (gen >= 13) patchPrototype_v13();
  else tryPatchCurrentRuler_v12();
});
