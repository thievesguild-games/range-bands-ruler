// Range Bands Ruler — v1.4.0
// Instance-patch approach for maximal compatibility on v10–v12 (and v13+).
// No libWrapper needed for the label swap. Keeps module settings.

const MODULE_ID = "range-bands-ruler";
const gp = (o, p) => foundry.utils?.getProperty?.(o, p);

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
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    scope: "client",
    config: true,
    default: false,
    type: Boolean
  });
});

function getBands() {
  try { const a = JSON.parse(game.settings.get(MODULE_ID, "bands")); return Array.isArray(a) ? a : DEFAULT_BANDS; }
  catch { return DEFAULT_BANDS; }
}
function bandFor(d) {
  for (const b of getBands()) if (d >= b.min && d <= b.max) return b.label;
  const arr = getBands(); return arr.length ? arr[arr.length - 1].label : String(d);
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

/** Replace text of existing labels using segment distances when available. */
function postProcessLabels(ctx) {
  if (!shouldBand(ctx)) return;

  const labels = ctx?.labels ?? ctx?.tooltips ?? [];
  const segs   = ctx?.segments ?? [];

  // If labels correspond to segments, use segment distance
  if (labels.length && segs.length && labels.length === segs.length) {
    for (let i = 0; i < labels.length; i++) {
      const lab = labels[i];
      if (!lab || typeof lab.text !== "string") continue;
      const d = segs[i]?.distance ?? parseNum(lab.text);
      lab.text = makeLabel(d, lab.text);
    }
    return;
  }

  // Otherwise, parse numeric from label text
  for (const lab of labels) {
    if (!lab || typeof lab.text !== "string") continue;
    const d = parseNum(lab.text);
    lab.text = makeLabel(d, lab.text);
  }
}

/** Patch a single ruler instance (idempotent). */
function patchRulerInstance(ruler) {
  if (!ruler || ruler._rbrPatched) return false;

  // Prefer tooltip refresher if present
  if (typeof ruler._refreshTooltips === "function") {
    const orig = ruler._refreshTooltips.bind(ruler);
    ruler._refreshTooltips = function(...args) {
      const out = orig(...args);
      try { postProcessLabels(this); } catch (e) { console.warn(`${MODULE_ID} | _refreshTooltips patch failed`, e); }
      return out;
    };
    ruler._rbrPatched = true;
    console.log(`${MODULE_ID} | Patched instance via _refreshTooltips`);
    return true;
  }

  // Fallback: wrap measure
  if (typeof ruler.measure === "function") {
    const orig = ruler.measure.bind(ruler);
    ruler.measure = function(...args) {
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
  const r = gp(canvas, "controls.ruler") || gp(canvas, "hud.ruler") || gp(ui, "controls.controls.ruler") || game.ruler;
  if (r) patchRulerInstance(r);
}

// Patch on initial canvas ready, and whenever the scene/canvas changes.
Hooks.on("canvasReady", () => {
  console.log(`${MODULE_ID} | canvasReady — attempting instance patch`);
  tryPatchCurrentRuler();
});

// Some systems (or reconnects) recreate the ruler later; keep trying on a few lifecycle hooks.
Hooks.on("updateUser", () => tryPatchCurrentRuler());
Hooks.on("controlToken", () => tryPatchCurrentRuler());
Hooks.on("renderSceneControls", () => tryPatchCurrentRuler());
Hooks.on("hotbarDrop", () => tryPatchCurrentRuler());

// Debug helper (optional): command to re-patch on demand
game.modules?.get(MODULE_ID)?.api = {
  repatch: () => tryPatchCurrentRuler()
};
