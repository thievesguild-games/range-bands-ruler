// Range Bands Ruler — v1.2.2
// Supports Foundry v10–v12 (and tries v13+).
// Requires libWrapper. Patches the active ruler class via CONFIG.Canvas.rulerClass.

const MODULE_ID = "range-bands-ruler";
const { getProperty } = foundry.utils; // v12+ safe access

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
    hint: "JSON array of {label,min,max} in scene distance units.",
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
    const arr = JSON.parse(game.settings.get(MODULE_ID, "bands"));
    if (!Array.isArray(arr)) throw new Error("Bands must be an array");
    return arr.map(b => ({
      label: String(b.label ?? "").trim(),
      min: Number(b.min ?? 0),
      max: Number(b.max ?? 0)
    })).filter(b => b.label && isFinite(b.min) && isFinite(b.max) && b.max >= b.min);
  } catch (e) {
    console.warn(`${MODULE_ID} | Invalid bands config; using defaults.`, e);
    return DEFAULT_BANDS;
  }
}

function bandForDistance(d) {
  const bands = getBands();
  for (const b of bands) if (d >= b.min && d <= b.max) return b.label;
  return bands.length ? bands[bands.length - 1].label : String(d);
}

function makeBandLabel(distance, baseText) {
  const showNum = game.settings.get(MODULE_ID, "showNumericFallback");
  const label = bandForDistance(distance);
  return (showNum && baseText) ? `${label} (${baseText})` : label;
}

function shouldBand(ruler) {
  const onlySnapped = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  if (!onlySnapped) return true;
  return Boolean(ruler?.snapped ?? true);
}

// Extract a numeric distance from common call-sites / contexts
function extractDistance(ctx, args, base) {
  if (typeof args?.[0] === "number" && isFinite(args[0])) return args[0];  // _getSegmentLabel(distance,...)
  const seg = ctx?.segments?.at?.(-1);
  if (seg?.distance) return seg.distance;
  if (typeof ctx?.totalDistance === "number") return ctx.totalDistance;
  if (typeof base === "number") return base;
  if (typeof base === "string") {
    const m = base.match(/(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Foundry version:`, game.version, "release gen:", getProperty(game, "release.generation"));

  const lw = game.modules.get("lib-wrapper");
  if (!lw?.active) {
    ui.notifications?.warn("Range Bands Ruler: libWrapper is not active. Labels will not change.");
    console.warn(`${MODULE_ID} | libWrapper missing or inactive.`);
    return;
  }

  const RulerClass = getProperty(CONFIG, "Canvas.rulerClass") ?? globalThis.Ruler;
  if (!RulerClass) {
    console.warn(`${MODULE_ID} | No ruler class found (CONFIG.Canvas.rulerClass).`);
    return;
  }

  // Helper: register by OBJECT reference (works even if the class isn't globally named)
  const wrapIf = (proto, method, wrapperFn) => {
    const exists = typeof proto?.[method] === "function";
    console.log(`${MODULE_ID} | ${exists ? "Hooking" : "Missing"}: ${proto?.constructor?.name || "Ruler"}.prototype.${method}`);
    if (exists) {
      libWrapper.register(MODULE_ID, proto, method, wrapperFn, "WRAPPER");
      return true;
    }
    return false;
  };

  const proto = RulerClass.prototype;
  let patched = false;

  // v10–v12 primary
  patched ||= wrapIf(proto, "_getSegmentLabel", function (wrapped, ...args) {
    const base = wrapped(...args); // e.g., "60 ft"
    if (!shouldBand(this)) return base;
    const dist = extractDistance(this, args, base);
    return makeBandLabel(dist, base);
  });

  // Older fallbacks
  patched ||= wrapIf(proto, "_getRulerText", function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    const dist = extractDistance(this, args, base);
    return makeBandLabel(dist, base);
  });

  patched ||= wrapIf(proto, "_getMeasurementText", function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    const dist = extractDistance(this, args, base);
    return makeBandLabel(dist, base);
  });

  // v13+ formatter (harmless on v12 if missing)
  patched ||= wrapIf(proto, "_formatDistance", function (wrapped, distance, ...rest) {
    const base = wrapped(distance, ...rest);
    if (!shouldBand(this)) return base;
    return makeBandLabel(distance, base);
  });

  // Ultimate fallback: post-process tooltips
  patched ||= wrapIf(proto, "_refreshTooltips", function (wrapped, ...args) {
    const out = wrapped(...args);
    try {
      if (!shouldBand(this)) return out;
      const labels = this?.labels ?? this?.tooltips ?? [];
      for (const lab of labels) {
        if (!lab || typeof lab.text !== "string") continue;
        const d = (lab?.segment?.distance) ?? extractDistance(this, undefined, lab.text);
        lab.text = makeBandLabel(d, lab.text);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | tooltip post-process failed`, e);
    }
    return out;
  });

  if (!patched) {
    ui.notifications?.warn("Range Bands Ruler: No ruler methods were patched. Your system may override the ruler differently.");
    console.warn(`${MODULE_ID} | No ruler methods were patched on`, RulerClass);
  } else {
    console.log(`${MODULE_ID} | Range band wrappers registered.`);
  }
});
