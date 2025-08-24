// Range Bands Ruler — v1.5.4
// v12: instance post-process (works as you have today)
// v13+: patch _getWaypointLabelContext to rewrite label text

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

/* ---------------- settings ---------------- */
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "bands", {
    name: "Range Bands",
    hint: "JSON array of {label,min,max} in scene units.",
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

/* ---------------- helpers ---------------- */
function getBands() {
  try { const a = JSON.parse(game.settings.get(MODULE_ID, "bands")); return Array.isArray(a) ? a : DEFAULT_BANDS; }
  catch { return DEFAULT_BANDS; }
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

/* ---------------- v12 logic you already had (unchanged) ---------------- */
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
  const nodes = getLabelNodes(ctx);
  const segs  = Array.isArray(ctx?.segments) ? ctx.segments : [];
  const apply = (lab, segDist) => {
    if (!lab || typeof lab.text !== "string") return;
    let base = stripBandWrappers(lab.text);
    base = cleanBaseText(base);
    const d = (segDist ?? parseNum(base)) || 0;
    lab.text = makeBandedLabel(d, base);
  };
  if (nodes.length && segs.length && nodes.length === segs.length) {
    for (let i = 0; i < nodes.length; i++) apply(nodes[i], segs[i]?.distance);
  } else {
    for (const lab of nodes) apply(lab, undefined);
  }
}
function patchInstance_v12(ruler) {
  if (!ruler) return false;
  if (typeof ruler._refreshTooltips === "function" && !ruler._rbrPatchedTooltips) {
    const orig = ruler._refreshTooltips.bind(ruler);
    ruler._refreshTooltips = function (...args) {
      const out = orig(...args);
      try { postProcessLabels_v12(this); } catch (e) { console.warn(`${MODULE_ID} | v12 _refreshTooltips patch failed`, e); }
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
      try { postProcessLabels_v12(this); } catch (e) { console.warn(`${MODULE_ID} | v12 measure patch failed`, e); }
      return out;
    };
    ruler._rbrPatchedMeasure = true;
    console.log(`${MODULE_ID} | v12: patched via measure`);
    return true;
  }
  console.warn(`${MODULE_ID} | v12: no instance method to patch`);
  return false;
}
function tryPatchCurrentRuler_v12() {
  const r = gp(canvas, "controls.ruler") || gp(canvas, "hud.ruler") || game.ruler || gp(ui, "controls.controls.ruler");
  if (r) patchInstance_v12(r);
}

/* ---------------- v13: patch _getWaypointLabelContext ---------------- */
function patchPrototype_v13_exact() {
  const RulerClass = gp(foundry, "canvas.interaction.Ruler") || gp(CONFIG, "Canvas.rulerClass") || globalThis.Ruler;
  if (!RulerClass) { console.warn(`${MODULE_ID} | v13: No Ruler class found.`); return false; }

  const proto = RulerClass.prototype;

  // This exists on your build (from your dump):
  if (typeof proto._getWaypointLabelContext === "function" && proto._rbrPatchedWLC !== true) {
    const orig = proto._getWaypointLabelContext;
    proto._getWaypointLabelContext = function (...args) {
      // The original returns an object like { text, ... }  — we’ll rewrite text.
      const ctx = orig.apply(this, args);
      try {
        if (!shouldBand(this) || !ctx || typeof ctx.text !== "string") return ctx;

        // Prefer a numeric from args/ctx if present
        // Common shapes seen: args[0]?.distance or ctx.distance
        const maybeDist =
          (args && typeof args[0]?.distance === "number" ? args[0].distance : undefined) ??
          (typeof ctx.distance === "number" ? ctx.distance : undefined);

        const base = cleanBaseText(stripBandWrappers(ctx.text));
        const d = (typeof maybeDist === "number" ? maybeDist : parseNum(base)) || 0;
        ctx.text = makeBandedLabel(d, base);
      } catch (e) {
        console.warn(`${MODULE_ID} | v13 _getWaypointLabelContext patch failed`, e);
      }
      return ctx;
    };
    proto._rbrPatchedWLC = true;
    console.log(`${MODULE_ID} | v13: patched prototype via _getWaypointLabelContext`);
    return true;
  }

  console.warn(`${MODULE_ID} | v13: _getWaypointLabelContext not found on prototype.`);
  return false;
}

/* ---------------- v13 fallback: patch instance via _refresh ---------------- */
function patchInstance_v13_fallback(ruler) {
  if (!ruler) return false;
  if (typeof ruler._refresh === "function" && !ruler._rbrPatchedRefresh) {
    const orig = ruler._refresh.bind(ruler);
    ruler._refresh = function (...args) {
      const out = orig(...args);
      try {
        // We don’t have label containers on your build; instead, grab the latest context by
        // calling the prototype method (if present) on the ruler’s current state and rebuild text.
        // If that’s not available either, do nothing (UI will remain stock).
        if (typeof this._getWaypointLabelContext === "function") {
          // No direct handle to label display objects here; the prototype patch above is preferred.
          // This fallback is mostly a no-op on your v13, but we keep it for other variants.
        }
      } catch (e) { /* ignore */ }
      return out;
    };
    ruler._rbrPatchedRefresh = true;
    console.log(`${MODULE_ID} | v13: patched instance via _refresh (fallback)`);
    return true;
  }
  console.warn(`${MODULE_ID} | v13: no instance method to patch`);
  return false;
}

/* ---------------- lifecycle ---------------- */
function isV13Plus() {
  const gen = Number(gp(game, "release.generation"));
  return Number.isFinite(gen) ? gen >= 13 : (Number(gp(game, "version")?.split?.(".")?.[0]) >= 13);
}

Hooks.on("canvasReady", () => {
  if (isV13Plus()) {
    // Try the prototype hook first (best accuracy)
    const ok = patchPrototype_v13_exact();
    if (!ok) {
      // Fallback: instance refresh hook (limited)
      const r = gp(canvas, "controls.ruler") || gp(canvas, "hud.ruler") || game.ruler || gp(ui, "controls.controls.ruler");
      patchInstance_v13_fallback(r);
    }
  } else {
    console.log(`${MODULE_ID} | canvasReady — attempting v12 instance patch`);
    tryPatchCurrentRuler_v12();
  }
});

Hooks.once("ready", () => {
  if (isV13Plus()) {
    // In case canvasReady fired before module load ordering
    patchPrototype_v13_exact();
  } else {
    tryPatchCurrentRuler_v12();
  }
});
