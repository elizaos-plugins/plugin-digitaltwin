
/**
 * parseXml: convert an XML string into a JS object (key/value).
 * - Text-only elements -> string
 * - Elements with children -> nested object
 * - Repeated sibling tags -> array
 * - Attributes (optional) -> stored under "@attrs" (toggle with options.includeAttributes)
 *
 * @param {string} xml
 * @param {object} [options]
 * @param {boolean} [options.arrayize=true]    Turn repeated siblings into arrays
 * @param {boolean} [options.includeAttributes=false]  Include attributes as "@attrs"
 * @param {boolean} [options.coercePrimitives=true]    Coerce "true"/"false"/numbers/null
 * @returns {object|null}
 */
export function parseXml(xml, options = {}) {
  if (typeof xml !== 'string' || !xml.trim()) return null;
  const {
    arrayize = true,
    includeAttributes = false,
    coercePrimitives = true,
  } = options;
  // --- helpers ---------------------------------------------------------------
  const coerce = (val) => {
    if (!coercePrimitives) return val;
    const s = val.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (s !== '' && !isNaN(s)) return Number(s);
    return s;
  };
  const isTextOnly = (node) =>
    node.childNodes &&
    Array.from(node.childNodes).every((n) => n.nodeType === 3 || n.nodeType === 4); // TEXT or CDATA
  const setProp = (obj, key, value) => {
    if (obj[key] === undefined) {
      obj[key] = value;
    } else if (arrayize) {
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      obj[key].push(value);
    } else {
      // last-one-wins if arrays are disabled
      obj[key] = value;
    }
  };
  // --- acquire a DOM ---------------------------------------------------------
  let doc;
  if (typeof DOMParser !== 'undefined') {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
    // Handle parsererrors in browsers
    if (doc.getElementsByTagName('parsererror').length) return null;
  } else {
    // Minimal fallback: try to load via JSDOM-like environments that expose ActiveX (very old) – otherwise bail
    try {
      // Node.js has no DOMParser by default; without deps we can't fully parse XML.
      // Try a very naive root extraction to avoid throwing.
      const m = xml.match(/<([A-Za-z0-9:_-]+)[^>]*>([\s\S]*)<\/\1>/);
      if (!m) return null;
      // If we're here, no real DOM — do a simplified parse of direct children.
      return parseFlatByRegex(m[2], { coercePrimitives, arrayize });
    } catch {
      return null;
    }
  }
  // walk from the documentElement
  const walk = (el) => {
    if (isTextOnly(el)) {
      const text = el.textContent ?? '';
      return coerce(text.trim());
    }
    const out = {};
    if (includeAttributes && el.attributes && el.attributes.length) {
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = coerce(a.value);
      if (Object.keys(attrs).length) out['@attrs'] = attrs;
    }
    for (const child of el.children) {
      const val = walk(child);
      setProp(out, child.tagName, val);
    }
    return out;
  };
  return walk(doc.documentElement);
  // --- fallback for environments without DOMParser ---------------------------
  function parseFlatByRegex(innerXml, opts) {
    const { coercePrimitives, arrayize } = opts;
    const out = {};
    const tagRE = /<([A-Za-z0-9:_-]+)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = tagRE.exec(innerXml))) {
      const [, tag, _attrs, body] = m;
      // Create a fresh regex to test for nested tags (avoids infinite loop)
      const nestedTagRE = /<([A-Za-z0-9:_-]+)(\s[^>]*)?>([\s\S]*?)<\/\1>/;
      const hasNested = nestedTagRE.test(body);
      const val = hasNested ? parseFlatByRegex(body, opts) : coerce(body.trim());
      if (out[tag] === undefined) {
        out[tag] = val;
      } else if (arrayize) {
        if (!Array.isArray(out[tag])) out[tag] = [out[tag]];
        out[tag].push(val);
      } else {
        out[tag] = val;
      }
    }
    return Object.keys(out).length ? out : null;
  }
}