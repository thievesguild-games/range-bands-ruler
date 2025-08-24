// Range Bands Ruler — v1.5.3
// v12: instance post-process (tooltips/measure)
// v13+: try prototype formatters; else instance post-process; else MutationObserver
// No hard dependency on libWrapper.

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
    hint: "Remove Foundry’s [segment total] so the number appears only once.",
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

/* ---------- v12: label post-process on the live ruler instance ---------- */
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
  const r =
    gp(canvas, "controls.ruler") ||
    gp(canvas, "hud.ruler") ||
    game.ruler ||
    gp(ui, "controls.controls.ruler");
  if (r) patchInstance_v12(r);
}

/* ---------- v13+: patch the formatter on the class prototype, or fallback ---------- */
function patchPrototype_v13() {
  const RulerClass =
    gp(foundry, "canvas.interaction.Ruler") ||     // canonical in v13
    gp(CONFIG, "Canvas.rulerClass") ||
    globalThis.Ruler;

  if (!RulerClass) {
    console.warn(`${MODULE_ID} | v13: No Ruler class found to patch.`);
    return false;
  }
  const proto = RulerClass.prototype;

  // Try a bunch of likely formatter names
  const candidates = [
    "_formatDistance", "formatDistance",
    "_formatMeasurement", "formatMeasurement",
    "_formatValue", "formatValue"
  ];
  const fmt = candidates.find(n => typeof proto?.[n] === "function");

  if (fmt) {
    if (proto._rbrPatchedFormatName === fmt) return true;
    const original = proto[fmt];
    proto[fmt] = function (distance, ...rest) {
      const base = original.call(this, distance, ...rest);      // e.g. "60 ft [60 ft]"
      if (!shouldBand(this)) return base;
      const d = typeof distance === "number" ? distance : parseNum(base);
      return makeBandedLabel(d, base);
    };
    proto._rbrPatchedFormatName = fmt;
    console.log(`${MODULE_ID} | v13: patched prototype via ${fmt}`);
    return true;
  }

  console.warn(`${MODULE_ID} | v13: formatter not found on prototype. Falling back to instance patch.`);
  return false;
}

function patchInstance_v13(ruler) {
  if (!ruler) return false;

  // Try a wide set of update/refresh methods on the instance
  const tryNames = [
    "_refreshTooltips","refreshTooltips","_updateTooltips","updateTooltips",
    "_refreshLabels","refreshLabels","_updateLabels","updateLabels",
    "_refresh","refresh","_render","render","_draw","draw","_measure","measure"
  ];
  for (const name of tryNames) {
    const fn = ruler[name];
    if (typeof fn === "function" && !ruler._rbrPatchedName) {
      const orig = fn.bind(ruler);
      ruler[name] = function (...args) {
        const out = orig(...args);
        try { // rewrite labels after the tool updates
          const nodes = getLabelNodes(this);
          if (nodes.length) {
            // emulate v12 path: use text + (if present) segments
            const segs = Array.isArray(this?.segments) ? this.segments : [];
            const apply = (lab, segDist) => {
              if (!lab || typeof lab.text !== "string") return;
              let base = stripBandWrappers(lab.text);
              base = cleanBaseText(base);
              const d = (segDist ?? parseNum(base)) || 0;
              lab.text = makeBandedLabel(d, base);
            };
            if (segs.length === nodes.length) {
              for (let i = 0; i < nodes.length; i++) apply(nodes[i], segs[i]?.distance);
            } else {
              for (const lab of nodes) apply(lab, undefined);
            }
          }
        } catch (e) { console.warn(`${MODULE_ID} | v13 instance fallback failed`, e); }
        return out;
      };
      ruler._rbrPatchedName = name;
      console.log(`${MODULE_ID} | v13: patched instance via ${name}`);
      return true;
    }
  }

  // Last resort: observe label container and rewrite on mutation
  const container = gp(ruler, "labels") || gp(ruler, "tooltips");
  if (container?.children && typeof MutationObserver !== "undefined" && !ruler._rbrObserver) {
    const obs = new MutationObserver(() => {
      try {
        const nodes = getLabelNodes(ruler);
        for (const lab of nodes) {
          if (!lab || typeof lab.text !== "string") continue;
          const base = cleanBaseText(stripBandWrappers(lab.text));
          const d = parseNum(base);
          lab.text = makeBandedLabel(d, base);
        }
      } catch (e) { /* ignore */ }
    });
    obs.observe(container, { childList: true, subtree: true, characterData: true });
    ruler._rbrObserver = obs;
    console.log(`${MODULE_ID} | v13: observing labels with MutationObserver`);
    return true;
  }

  console.warn(`${MODULE_ID} | v13: no instance method to patch`);
  return false;
}

/* ---------- lifecycle ---------- */
function isV13Plus() {
  const gen = Number(gp(game, "release.generation"));
  return Number.isFinite(gen) ? gen >= 13 : (Number(gp(game, "version")?.split?.(".")?.[0]) >= 13);
}

function tryPatch_v13() {
  const okProto = patchPrototype_v13();
  if (okProto) return true;

  // fallback to instance patch
  const r =
    gp(canvas, "controls.ruler") ||
    gp(canvas, "hud.ruler") ||
    game.ruler ||
    gp(ui, "controls.controls.ruler");
  if (r) return patchInstance_v13(r);
  return false;
}

Hooks.on("canvasReady", () => {
  if (isV13Plus()) {
    tryPatch_v13();
  } else {
    console.log(`${MODULE_ID} | canvasReady — attempting v12 instance patch`);
    tryPatchCurrentRuler_v12();
  }
});

Hooks.once("ready", () => {
  if (isV13Plus()) {
    tryPatch_v13();
  } else {
    tryPatchCurrentRuler_v12();
  }
});
