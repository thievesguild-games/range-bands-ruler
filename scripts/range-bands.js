// Range Bands Ruler — v1.2.4
// Works on Foundry v10–v12 (and v13+ fallback). Requires libWrapper.

const MODULE_ID = "range-bands-ruler";
const getProp = (obj, path) => foundry.utils.getProperty(obj, path);

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

function getBands() {
  try { const arr = JSON.parse(game.settings.get(MODULE_ID, "bands")); return Array.isArray(arr) ? arr : DEFAULT_BANDS; }
  catch { return DEFAULT_BANDS; }
}
function bandForDistance(d) {
  const bands = getBands();
  for (const b of bands) if (d >= b.min && d <= b.max) return b.label;
  return bands[bands.length - 1]?.label ?? String(d);
}
function makeBandLabel(distance, baseText) {
  const showNum = game.settings.get(MODULE_ID, "showNumericFallback");
  const label = bandForDistance(distance);
  return showNum && baseText ? `${label} (${baseText})` : label;
}
function shouldBand(ruler) {
  const onlySnapped = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !onlySnapped || Boolean(ruler?.snapped ?? true);
}

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Foundry version:`, game.version, "release gen:", getProp(game, "release.generation"));

  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler requires libWrapper.");
    return;
  }
  const lw = globalThis.libWrapper;

  // Use the active ruler class, but register via STRING target so libWrapper accepts it.
  const RulerClass = getProp(CONFIG, "Canvas.rulerClass") ?? globalThis.Ruler;
  const className = RulerClass?.name || RulerClass?.prototype?.constructor?.name || "Ruler";
  console.log(`${MODULE_ID} | Active ruler class: ${className}`);

  function hook(path, fn) {
    const exists = !!getProp(globalThis, path);
    console.log(`${MODULE_ID} | ${exists ? "Hooking" : "Missing"} ${path}`);
    if (exists) lw.register(MODULE_ID, path, fn, "WRAPPER");
    return exists;
  }

  // v10–v12 primary: _getSegmentLabel(distance, opts)
  const hookedPrimary = hook(`${className}.prototype._getSegmentLabel`, function (wrapped, distance, ...args) {
    const base = wrapped(distance, ...args); // e.g., "60 ft"
    if (!shouldBand(this)) return base;
    return makeBandLabel(distance, base);
  });

  // Fallbacks (some builds)
  hook(`${className}.prototype._getRulerText`, function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    const dist = Number(args?.[0] ?? 0);
    return makeBandLabel(dist, base);
  });

  hook(`${className}.prototype._getMeasurementText`, function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    const dist = Number(args?.[0] ?? 0);
    return makeBandLabel(dist, base);
  });

  // v13+: _formatDistance(distance, opts)
  hook(`${className}.prototype._formatDistance`, function (wrapped, distance, ...rest) {
    const base = wrapped(distance, ...rest);
    if (!shouldBand(this)) return base;
    return makeBandLabel(distance, base);
  });

  // Last resort: post-process tooltips (works across versions)
  hook(`${className}.prototype._refreshTooltips`, function (wrapped, ...args) {
    const out = wrapped(...args);
    try {
      if (!shouldBand(this)) return out;
      const labels = this?.labels ?? this?.tooltips ?? [];
      for (const lab of labels) {
        if (!lab || typeof lab.text !== "string") continue;
        const num = Number((lab.text.match(/(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
        lab.text = makeBandLabel(num, lab.text);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Tooltip post-process failed`, e);
    }
    return out;
  });

  if (!hookedPrimary) {
    console.warn(`${MODULE_ID} | Primary method missing; relying on fallbacks for ruler labels.`);
  }
});
