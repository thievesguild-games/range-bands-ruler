// Range Bands Ruler — v1.3.0
// Supports Foundry v10–v13+. Requires libWrapper.
// Shows configurable range bands on the ruler labels.

const MODULE_ID = "range-bands-ruler";

/* ----------------------------- Settings ----------------------------- */

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

/* ----------------------------- Helpers ----------------------------- */

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
  // Primary: arg[0] is numeric distance for _getSegmentLabel(distance, opts)
  if (typeof args?.[0] === "number" && isFinite(args[0])) return args[0];
  // Segment tail (v12+)
  const seg = ctx?.segments?.at?.(-1);
  if (seg?.distance) return seg.distance;
  // Total distance fallback (single segment)
  if (typeof ctx?.totalDistance === "number") return ctx.totalDistance;
  // If base is numeric, use it
  if (typeof base === "number") return base;
  // Parse from text like "60 ft [50 ft]"
  if (typeof base === "string") {
    const m = base.match(/(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/* ------------------------------ Hooking ----------------------------- */

Hooks.once("ready", () => {
  // Sanity logs
  console.log(`${MODULE_ID} | Foundry version:`, game.version, "release:", getProperty(game, "release.generation"));
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler: libWrapper is not active. Labels may not change.");
    console.warn(`${MODULE_ID} | libWrapper missing or inactive.`);
    return;
  }

  const lw = globalThis.libWrapper;

  // Use the active ruler class (systems can override the default Ruler)
  const RulerClass = CONFIG.Canvas?.rulerClass ?? globalThis.Ruler;
  if (!RulerClass) {
    console.warn(`${MODULE_ID} | No ruler class found to patch.`);
    return;
  }
  const protoPath = `${RulerClass.name}.prototype`;

  // Helper to register a wrapper safely and log it
  function wrap(path, fn) {
    if (getProperty(globalThis, path)) {
      lw.register(MODULE_ID, path, fn, "WRAPPER");
      console.log(`${MODULE_ID} | Wrapped ${path}`);
      return true;
    }
    return false;
  }

  // v10–v12 primary: _getSegmentLabel(distance, opts)
  const hooked1 = wrap(`${protoPath}._getSegmentLabel`, function (wrapped, ...args) {
    const base = wrapped(...args); // e.g., "60 ft"
    if (!shouldBand(this)) return base;
    const dist = extractDistance(this, args, base);
    const out = makeBandLabel(dist, base);
    // Debug log once per second at most
    if (CONFIG.debug?.rangeBandsRuler) console.log(`${MODULE_ID} | _getSegmentLabel ->`, { base, dist, out });
    return out;
  });

  // Older fallbacks (some v10/early v11 builds)
  const hooked2 = wrap(`${protoPath}._getRulerText`, function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    const dist = extractDistance(this, args, base);
    const out = makeBandLabel(dist, base);
    if (CONFIG.debug?.rangeBandsRuler) console.log(`${MODULE_ID} | _getRulerText ->`, { base, dist, out });
    return out;
  });

  const hooked3 = wrap(`${protoPath}._getMeasurementText`, function (wrapped, ...args) {
    const base = wrapped(...args);
    if (!shouldBand(this)) return base;
    const dist = extractDistance(this, args, base);
    const out = makeBandLabel(dist, base);
    if (CONFIG.debug?.rangeBandsRuler) console.log(`${MODULE_ID} | _getMeasurementText ->`, { base, dist, out });
    return out;
  });

  // v13+: _formatDistance(distance, opts)
  const hooked4 = wrap(`${protoPath}._formatDistance`, function (wrapped, distance, ...rest) {
    const base = wrapped(distance, ...rest);
    if (!shouldBand(this)) return base;
    const out = makeBandLabel(distance, base);
    if (CONFIG.debug?.rangeBandsRuler) console.log(`${MODULE_ID} | _formatDistance ->`, { base, distance, out });
    return out;
  });

  // Final safety net across versions: post-process tooltips after build
  const hooked5 = wrap(`${protoPath}._refreshTooltips`, function (wrapped, ...args) {
    const out = wrapped(...args);
    try {
      if (!shouldBand(this)) return out;
      const labels = this?.labels ?? this?.tooltips ?? [];
      for (const lab of labels) {
        if (!lab || typeof lab.text !== "string") continue;
        const d = (lab?.segment?.distance) ?? extractDistance(this, undefined, lab.text);
        const newText = makeBandLabel(d, lab.text);
        if (newText !== lab.text) {
          if (CONFIG.debug?.rangeBandsRuler) console.log(`${MODULE_ID} | tooltip patch`, { from: lab.text, to: newText });
          lab.text = newText;
        }
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | tooltip post-process failed`, e);
    }
    return out;
  });

  // If nothing hooked, notify so you know to poke me
  if (!(hooked1 || hooked2 || hooked3 || hooked4 || hooked5)) {
    ui.notifications?.warn(`${MODULE_ID}: No ruler methods were patched. Your system may replace the ruler differently.`);
    console.warn(`${MODULE_ID} | No ruler methods were patched on ${RulerClass.name}.`);
  }
});
