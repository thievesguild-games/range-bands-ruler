// Range Bands Ruler — v1.2.3
// Supports Foundry v10–v12 (and v13+ fallback).
// Requires libWrapper. Hooks CONFIG.Canvas.rulerClass instead of global Ruler.

const MODULE_ID = "range-bands-ruler";
const { getProperty } = foundry.utils;

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
  try {
    return JSON.parse(game.settings.get(MODULE_ID, "bands"));
  } catch {
    return DEFAULT_BANDS;
  }
}
function bandForDistance(d) {
  const bands = getBands();
  for (const b of bands) if (d >= b.min && d <= b.max) return b.label;
  return bands[bands.length - 1].label;
}
function makeBandLabel(distance, baseText) {
  const showNum = game.settings.get(MODULE_ID, "showNumericFallback");
  const label = bandForDistance(distance);
  return showNum && baseText ? `${label} (${baseText})` : label;
}
function shouldBand(ruler) {
  const onlySnapped = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  if (!onlySnapped) return true;
  return Boolean(ruler?.snapped ?? true);
}

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler requires libWrapper");
    return;
  }

  const RulerClass = CONFIG.Canvas?.rulerClass ?? Ruler;
  const proto = RulerClass.prototype;
  console.log(`${MODULE_ID} | Active ruler class:`, proto.constructor.name);

  function wrapIf(method, fn) {
    if (typeof proto[method] === "function") {
      console.log(`${MODULE_ID} | Hooking ${method}`);
      libWrapper.register(MODULE_ID, proto, method, fn, "WRAPPER");
      return true;
    } else {
      console.log(`${MODULE_ID} | Missing ${method}`);
      return false;
    }
  }

  // Primary for v10–v12
  wrapIf("_getSegmentLabel", function (wrapped, distance, ...args) {
    const base = wrapped(distance, ...args);
    if (!shouldBand(this)) return base;
    return makeBandLabel(distance, base);
  });

  // Fallbacks
  wrapIf("_getRulerText", function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    return makeBandLabel(Number(args[0] ?? 0), base);
  });

  wrapIf("_getMeasurementText", function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    return makeBandLabel(Number(args[0] ?? 0), base);
  });

  // v13+
  wrapIf("_formatDistance", function (wrapped, distance, ...rest) {
    const base = wrapped(distance, ...rest);
    if (!shouldBand(this)) return base;
    return makeBandLabel(distance, base);
  });

  // Last fallback: post-process labels
  wrapIf("_refreshTooltips", function (wrapped, ...args) {
    const out = wrapped(...args);
    try {
      if (!shouldBand(this)) return out;
      for (const lab of this?.labels ?? []) {
        if (!lab?.text) continue;
        const num = Number((lab.text.match(/(\d+)/) ?? [])[1] ?? 0);
        lab.text = makeBandLabel(num, lab.text);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Tooltip post-process failed`, e);
    }
    return out;
  });
});
