// Range Bands Ruler — v1.4.5
// Instance-patch approach for Foundry v10–v12 (and v13+).
// No libWrapper required for the label swap. Keeps module settings.

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
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    hint: "If enabled, only show bands when the ruler is snapped to grid.",
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
function makeLabel(d, base) {
  return game.settings.get(MODULE_ID, "showNumericFallback") && base
    ? `${bandFor(d)} (${base})`
    : bandFor(d);
}
function shouldBand(ruler) {
  const only = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !only || Boolean(ruler?.snapped ?? true);
}
function parseNum(text) {
  const m = typeof text === "string" ? text.match(/(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : 0;
}

/** Get an array of label display objects regardless of how the ruler stores them. */
function getLabelNodes(ctx) {
  if (Array.isArray(ctx?.labels)) return ctx.labels;
  if (ctx?.labels?.children && Array.isArray(ctx.labels.children)) return ctx.labels.children;
  if (Array.isArray(ctx?.tooltips)) return ctx.tooltips;
  if (ctx?.tooltips?.children && Array.isArray(ctx.tooltips.children)) return ctx.tooltips.children;
  return [];
}

/** Replace label texts using segment distances when available (idempotent). */
function postProcessLabels(ctx) {
  if (!shouldBand(ctx)) return;

  const labelNodes = getLabelNodes(ctx);
  const segs = Array.isArray(ctx?.segments) ? ctx.segments : [];

  // Build from segment distance if available, otherwise parse text
  const build = (lab, segDist) => {
    if (!lab || typeof lab.text !== "string") return;
    const base = lab.text; // whatever Foundry just wrote (numeric distance)
    const d = (segDist ?? parseNum(base)) || 0;
    lab.text = makeLabel(d, base);
  };

  if (labelNodes.length && segs.length && labelNodes.length === segs.length) {
    for (let i = 0; i < labelNodes.length; i++) {
      build(labelNodes[i], segs[i]?.distance);
    }
    return;
  }

  for (const lab of labelNodes) build(lab, undefined);
}

/** Patch a single ruler instance (idempotent). */
function patchRulerInstance(ruler) {
  if (!ruler || ruler._rbrPatched) return false;

  if (typeof ruler._refreshTooltips === "function") {
    const orig = ruler._refreshTooltips.bind(ruler);
    ruler._refreshTooltips = function (...args) {
      const out = orig(...args);
      try { postProcessLabels(this); } catch (e) { console.warn(`${MODULE_ID} | _refreshTooltips patch failed`, e); }
      return out;
    };
    ruler._rbrPatched = true;
    console.log(`${MODULE_ID} | Patched instance via _refreshTooltips`);
    return true;
  }

  if (typeof ruler.measure === "function") {
    const orig = ruler.measure.bind(ruler);
    ruler.measure = function (...args) {
      const out = orig(...args);
      try { postProcessLabels(this); } catch (e) { console.warn(`${MODULE_ID} | measure patch failed`, e); }
      return out;
    };
    ruler._rbrPatched = true;
    console.log(`${MODULE_ID} | Patched instance via measure`);
    return true;
  }

  console.warn(`${MODULE_ID} | Could not find a method to patch on this ruler instance.`);
  return false;
}

/** Try to find and patch the current user's ruler instance. */
function tryPatchCurrentRuler() {
  const r =
    gp(canvas, "controls.ruler") ||
    gp(canvas, "hud.ruler") ||
    game.ruler ||
    gp(ui, "controls.controls.ruler");
  if (r) patchRulerInstance(r);
}

// Patch when the canvas is ready and on a few lifecycle hooks in case the ruler is recreated.
Hooks.on("canvasReady", () => {
  console.log(`${MODULE_ID} | canvasReady — attempting instance patch`);
  tryPatchCurrentRuler();
});
Hooks.on("updateUser", () => tryPatchCurrentRuler());
Hooks.on("controlToken", () => tryPatchCurrentRuler());
Hooks.on("renderSceneControls", () => tryPatchCurrentRuler());

// Expose a tiny API
Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { repatch: () => tryPatchCurrentRuler() };
});
