// Range Bands Ruler — v1.5.7
// v12: instance post-process of label text (tooltips/measure)
// v13+: patch the Ruler prototype (preferred: _getWaypointLabelContext;
//       fallback: _getSegmentStyle; last resort: prototype _refresh)
// No hard dependency on libWrapper.

const MODULE_ID = "range-bands-ruler";
const gp = (o, p) => (foundry?.utils?.getProperty ? foundry.utils.getProperty(o, p) : undefined);

/* ---------------- settings ---------------- */
const DEFAULT_BANDS = [
  { label: "Contact", min: 0,  max: 1 },
  { label: "Close",   min: 2,  max: 5 },
  { label: "Near",    min: 6,  max: 15 },
  { label: "Far",     min: 16, max: 30 },
  { label: "Distant", min: 31, max: 120 },
  { label: "Extreme", min: 121, max: 999999 }
];

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
function rbrGetBands() {
  try { const a = JSON.parse(game.settings.get(MODULE_ID, "bands")); return Array.isArray(a) ? a : DEFAULT_BANDS; }
  catch { return DEFAULT_BANDS; }
}
function rbrBandFor(d) {
  const arr = rbrGetBands();
  for (const b of arr) if (d >= b.min && d <= b.max) return b.label;
  return arr.length ? arr[arr.length - 1].label : String(d);
}
function rbrParseNum(text) {
  const m = typeof text === "string" ? text.match(/(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : 0;
}
function rbrCleanBase(t) {
  let s = String(t ?? "");
  if (game.settings.get(MODULE_ID, "hideBracketDistances")) s = s.replace(/\[.*?\]/g, "").trim();
  return s;
}
function rbrShouldBand(ruler) {
  const only = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !only || Boolean(ruler?.snapped ?? true);
}
function rbrMakeLabel(distance, baseText) {
  const base = rbrCleanBase(baseText);
  if (!game.settings.get(MODULE_ID, "showNumericFallback")) return rbrBandFor(distance);
  return `${rbrBandFor(distance)} (${base})`;
}
function rbrStripBandWrappers(text) {
  let t = String(text ?? "");
  for (let i = 0; i < 6; i++) {
    const m = t.match(/^\s*[^()]+?\s*\((.*)\)\s*$/);
    if (!m) break;
    t = m[1];
  }
  return t.trim();
}
function rbrGetLabelNodes(ctx) {
  if (Array.isArray(ctx?.labels)) return ctx.labels;
  if (ctx?.labels?.children && Array.isArray(ctx.labels.children)) return ctx.labels.children;
  if (Array.isArray(ctx?.tooltips)) return ctx.tooltips;
  if (ctx?.tooltips?.children && Array.isArray(ctx.tooltips.children)) return ctx.tooltips.children;
  return [];
}
function rbrIsV13Plus() {
  const gen = Number(gp(game, "release.generation"));
  return Number.isFinite(gen) ? gen >= 13 : (Number((game?.version || "0").split(".")[0]) >= 13);
}

/* ---------------- v12: instance post-process ---------------- */
function rbrPostProcessLabelsV12(ctx) {
  if (!rbrShouldBand(ctx)) return;
  const nodes = rbrGetLabelNodes(ctx);
  const segs  = Array.isArray(ctx?.segments) ? ctx.segments : [];

  const apply = (lab, segDist) => {
    if (!lab || typeof lab.text !== "string") return;
    let base = rbrStripBandWrappers(lab.text);
    base = rbrCleanBase(base);
    const d = (segDist ?? rbrParseNum(base)) || 0;
    lab.text = rbrMakeLabel(d, base);
  };

  if (nodes.length && segs.length && nodes.length === segs.length) {
    for (let i = 0; i < nodes.length; i++) apply(nodes[i], segs[i]?.distance);
  } else {
    for (const lab of nodes) apply(lab, undefined);
  }
}
function rbrPatchInstanceV12(ruler) {
  if (!ruler) return false;

  if (typeof ruler._refreshTooltips === "function" && !ruler._rbrPatchedTooltips) {
    const orig = ruler._refreshTooltips.bind(ruler);
    ruler._refreshTooltips = function (...args) {
      const out = orig(...args);
      try { rbrPostProcessLabelsV12(this); } catch (e) { console.warn(`${MODULE_ID} | v12 _refreshTooltips patch failed`, e); }
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
      try { rbrPostProcessLabelsV12(this); } catch (e) { console.warn(`${MODULE_ID} | v12 measure patch failed`, e); }
      return out;
    };
    ruler._rbrPatchedMeasure = true;
    console.log(`${MODULE_ID} | v12: patched via measure`);
    return true;
  }

  console.warn(`${MODULE_ID} | v12: no instance method to patch`);
  return false;
}
function rbrTryPatchCurrentRulerV12() {
  const r = gp(canvas, "controls.ruler") || gp(canvas, "hud.ruler") || game.ruler || gp(ui, "controls.controls.ruler");
  if (r) rbrPatchInstanceV12(r);
}

/* ---------------- v13: prototype patch (definitive) ---------------- */
function rbrGetRulerProtos() {
  const candidates = [
    gp(foundry, "canvas.interaction.Ruler"),
    gp(CONFIG, "Canvas.rulerClass"),
    globalThis.Ruler
  ].filter(Boolean);
  return candidates.map(C => C && C.prototype).filter(Boolean);
}
function rbrPatchPrototypeV13() {
  let patched = false;

  for (const proto of rbrGetRulerProtos()) {
    if (!proto || proto._rbrPatchedV13) continue;

    // Preferred: rewrite the context that contains label text.
    if (typeof proto._getWaypointLabelContext === "function") {
      const orig = proto._getWaypointLabelContext;
      proto._getWaypointLabelContext = function (...args) {
        const ctx = orig.apply(this, args);
        try {
          if (!ctx || typeof ctx.text !== "string" || !rbrShouldBand(this)) return ctx;
          const argDist = typeof args?.[0]?.distance === "number" ? args[0].distance : undefined;
          const ctxDist = typeof ctx.distance === "number" ? ctx.distance : undefined;
          const base    = rbrCleanBase(rbrStripBandWrappers(ctx.text));
          const d       = (argDist ?? ctxDist ?? rbrParseNum(base)) || 0;
          ctx.text = rbrMakeLabel(d, base);
        } catch (e) { console.warn(`${MODULE_ID} | v13 _getWaypointLabelContext patch failed`, e); }
        return ctx;
      };
      proto._rbrPatchedV13 = true;
      patched = true;
      console.log(`${MODULE_ID} | v13: patched prototype via _getWaypointLabelContext`);
      continue;
    }

    // Fallback: some builds expose a segment style with text/label
    if (typeof proto._getSegmentStyle === "function") {
      const orig = proto._getSegmentStyle;
      proto._getSegmentStyle = function (...args) {
        const style = orig.apply(this, args) ?? {};
        try {
          if (!rbrShouldBand(this)) return style;
          const key = "label" in style ? "label" : ("text" in style ? "text" : null);
          if (key && typeof style[key] === "string") {
            const base = rbrCleanBase(rbrStripBandWrappers(style[key]));
            const d    = rbrParseNum(base);
            style[key] = rbrMakeLabel(d, base);
          }
        } catch (e) { console.warn(`${MODULE_ID} | v13 _getSegmentStyle patch failed`, e); }
        return style;
      };
      proto._rbrPatchedV13 = true;
      patched = true;
      console.log(`${MODULE_ID} | v13: patched prototype via _getSegmentStyle`);
      continue;
    }

    // Last resort: after each refresh, walk any PIXI text nodes and rewrite
    if (typeof proto._refresh === "function") {
      const orig = proto._refresh;
      proto._refresh = function (...args) {
        const out = orig.apply(this, args);
        try {
          const nodes = (this?.labels?.children && Array.isArray(this.labels.children)) ? this.labels.children
                      : (this?.tooltips?.children && Array.isArray(this.tooltips.children)) ? this.tooltips.children
                      : [];
          if (nodes.length && rbrShouldBand(this)) {
            for (const lab of nodes) {
              if (!lab || typeof lab.text !== "string") continue;
              const base = rbrCleanBase(rbrStripBandWrappers(lab.text));
              const d    = rbrParseNum(base);
              lab.text   = rbrMakeLabel(d, base);
            }
          }
        } catch (e) { console.warn(`${MODULE_ID} | v13 prototype _refresh fallback failed`, e); }
        return out;
      };
      proto._rbrPatchedV13 = true;
      patched = true;
      console.log(`${MODULE_ID} | v13: patched prototype via _refresh (fallback)`);
      continue;
    }
  }

  if (!patched) console.warn(`${MODULE_ID} | v13: could not patch any Ruler prototype; will retry.`);
  return patched;
}

/* ---------------- lifecycle ---------------- */
function rbrTryPatchV13WithRetries() {
  let ok = rbrPatchPrototypeV13();
  if (ok) return;
  // Retry shortly and when scene controls render (some systems set/replace the class late)
  setTimeout(() => rbrPatchPrototypeV13(), 200);
  Hooks.once("renderSceneControls", () => rbrPatchPrototypeV13());
}

Hooks.once("ready", () => {
  if (rbrIsV13Plus()) {
    rbrTryPatchV13WithRetries();
  } else {
    rbrTryPatchCurrentRulerV12();
  }
});
Hooks.on("canvasReady", () => {
  if (rbrIsV13Plus()) {
    rbrTryPatchV13WithRetries();
  } else {
    rbrTryPatchCurrentRulerV12();
  }
});
