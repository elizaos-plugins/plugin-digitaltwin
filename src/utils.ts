
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
type ParseXmlOptions = {
  arrayize?: boolean;
  includeAttributes?: boolean;
  coercePrimitives?: boolean;
};

type ParsedXml = Record<string, unknown> | null;

export function parseXml(xml: string, options: ParseXmlOptions = {}): ParsedXml {
  if (typeof xml !== 'string' || !xml.trim()) {
    return null;
  }

  const {
    arrayize = true,
    includeAttributes = false,
    coercePrimitives = true,
  } = options;

  const coerce = (val: string): unknown => {
    if (!coercePrimitives) return val;
    const s = val.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
    return s;
  };

  const domParserCtor = (globalThis as typeof globalThis & { DOMParser?: { new (): any } }).DOMParser;

  try {
    if (!domParserCtor) {
      return parseWithRegexFallback(xml, { coercePrimitives, arrayize });
    }

    const parser = new domParserCtor();
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror')?.length) {
      return parseWithRegexFallback(xml, { coercePrimitives, arrayize });
    }
    const walk = (element: any): unknown => {
      if (!element) return null;
      const childNodes = Array.from(element.childNodes ?? []);
      const textOnly =
        childNodes.length > 0 &&
        childNodes.every(
          (node: any) => node?.nodeType === 3 || node?.nodeType === 4 // TEXT or CDATA
        );
      if (textOnly) {
        const text = element.textContent ?? '';
        return coerce(String(text));
      }

      const result: Record<string, unknown> = {};
      if (includeAttributes && element.attributes && element.attributes.length) {
        const attrs: Record<string, unknown> = {};
        for (const attrNode of Array.from(element.attributes as unknown[])) {
          const attr = attrNode as { name?: string; value?: unknown };
          if (!attr?.name) continue;
          attrs[attr.name] = coerce(String(attr.value ?? ''));
        }
        if (Object.keys(attrs).length > 0) {
          result['@attrs'] = attrs;
        }
      }

      for (const childNode of Array.from((element.children ?? []) as unknown[])) {
        const child = childNode as { tagName?: string };
        const value = walk(childNode as any);
        if (value === undefined) continue;
        const tagName = typeof child.tagName === 'string' ? child.tagName : undefined;
        if (!tagName) continue;
        if (result[tagName] === undefined) {
          result[tagName] = value;
        } else if (arrayize) {
          const existing = result[tagName];
          if (Array.isArray(existing)) {
            existing.push(value);
          } else {
            result[tagName] = [existing, value];
          }
        } else {
          result[tagName] = value;
        }
      }

      return result;
    };

    return walk(doc.documentElement) as ParsedXml;
  } catch {
    return parseWithRegexFallback(xml, { coercePrimitives, arrayize });
  }

  function parseWithRegexFallback(
    outerXml: string,
    opts: { coercePrimitives: boolean; arrayize: boolean }
  ): ParsedXml {
    const rootMatch = outerXml.match(/<([A-Za-z0-9:_-]+)[^>]*>([\s\S]*)<\/\1>/);
    if (!rootMatch) {
      return null;
    }
    return parseFlatByRegex(rootMatch[2], opts);
  }

  function parseFlatByRegex(
    innerXml: string,
    opts: { coercePrimitives: boolean; arrayize: boolean }
  ): ParsedXml {
    const { coercePrimitives, arrayize } = opts;
    const out: Record<string, unknown> = {};
    const tagRE = /<([A-Za-z0-9:_-]+)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRE.exec(innerXml)) !== null) {
      const [, tag, , body] = match;
      const nestedTagRE = /<([A-Za-z0-9:_-]+)(\s[^>]*)?>([\s\S]*?)<\/\1>/;
      const hasNested = nestedTagRE.test(body);
      const value = hasNested
        ? parseFlatByRegex(body, opts)
        : coercePrimitives
          ? coerce(body.trim())
          : body.trim();

      if (out[tag] === undefined) {
        out[tag] = value;
      } else if (arrayize) {
        const existing = out[tag];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          out[tag] = [existing, value];
        }
      } else {
        out[tag] = value;
      }
    }

    return Object.keys(out).length ? out : null;
  }
}