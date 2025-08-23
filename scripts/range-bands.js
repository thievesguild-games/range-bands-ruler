// Range Bands Ruler — v1.3.0
// Broad-compat fallback for Foundry v10–v12 (and v13+).
// Requires libWrapper. Tries multiple update/refresh methods and post-processes labels.

const MODULE_ID = "range-bands-ruler";
const gp = (o, p) => foundry.utils.getProperty(o, p);

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

function bands() {
  try { const a = JSON.parse(game.settings.get(MODULE_ID, "bands")); return Array.isArray(a) ? a : DEFAULT_BANDS; }
  catch { return DEFAULT_BANDS; }
}
function bandFor(d) {
  for (const b of bands()) if (d >= b.min && d <= b.max) return b.label;
  const a = bands(); return a.length ? a[a.length - 1].label : String(d);
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

/** Replace label texts with our band text using segment distances when we can. */
function postProcessLabels(ctx) {
  if (!shouldBand(ctx)) return;

  const labels = ctx?.labels ?? ctx?.tooltips ?? [];
  const segs   = ctx?.segments ?? [];

  // Try 1: one label per segment
  if (labels.length && segs.length && labels.length === segs.length) {
    for (let i = 0; i < labels.length; i++) {
      const lab = labels[i];
      if (!lab || typeof lab.text !== "string") continue;
      const d = segs[i]?.distance ?? parseNum(lab.text);
      lab.text = makeLabel(d, lab.text);
    }
    return;
  }

  // Try 2: labels without matching segments -> parse numeric
  for (const lab of labels) {
    if (!lab || typeof lab.text !== "string") continue;
    const d = parseNum(lab.text);
    lab.text = makeLabel(d, lab.text);
  }
}

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Foundry version:`, game.version, "release gen:", gp(game, "release.generation"));

  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler requires libWrapper.");
    return;
  }
  const lw = globalThis.libWrapper;

  // Active ruler class (systems can override this)
  const RulerClass = gp(CONFIG, "Canvas.rulerClass") ?? globalThis.Ruler;
  const className  = RulerClass?.name || "Ruler";
  console.log(`${MODULE_ID} | Active ruler class: ${className}`);

  // Dump prototype so we can see what's available on your build
  try {
    const names = Object.getOwnPropertyNames(RulerClass.prototype).filter(n => typeof RulerClass.prototype[n] === "function");
    console.log(`${MODULE_ID} | Ruler proto methods:`, names.sort());
  } catch { /* ignore */ }

  // Candidate methods that run whenever the ruler updates/redraws. We’ll wrap the first we find.
  const candidates = [
    "_refreshTooltips", "_refreshLabels", "refresh", "render", "_render", "draw", "_draw",
    "measure", "_measure", "_update", "update", "_onMouseMove", "_onDragMove"
  ];

  let hooked = false;
  for (const m of candidates) {
    const path = `${className}.prototype.${m}`;
    const exists = !!gp(globalThis, path);
    console.log(`${MODULE_ID} | ${exists ? "Hooking" : "Missing"} ${path}`);
    if (!exists) continue;

    lw.register(MODULE_ID, path, function (wrapped, ...args) {
      const out = wrapped(...args);
      try { postProcessLabels(this); } catch (e) { console.warn(`${MODULE_ID} | postProcessLabels failed`, e); }
      return out;
    }, "WRAPPER");

    hooked = true;
    break;
  }

  if (!hooked) {
    ui.notifications?.warn("Range Bands Ruler: Could not find a ruler update method to hook; module inactive.");
  }
});
