import { z, ZodTypeAny, ZodObject } from "zod";

// Narrowly checks if something looks like a Zod schema
function isZodSchema(x: any): x is ZodTypeAny {
  return !!x && typeof x === "object" && x._def && typeof x._def.typeName === "string";
}

// Unwrap common wrappers so we can see the underlying type
function unwrap(t: any): ZodTypeAny | undefined {
  if (!isZodSchema(t)) return undefined;

  // Loop but bail out if structure isn't as expected
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isZodSchema(t)) return undefined;
    const d: any = t._def;
    if (!d) return t;

    // Optional/Nullable have .innerType
    if (typeof (t as any).isOptional === "function" && (t as any).isOptional()) { t = d.innerType; continue; }
    if ("innerType" in d && isZodSchema(d.innerType)) { t = d.innerType; continue; }

    // Effects wrap .schema, branded/readonly/pipeline/catch wrap .type
    if ("schema" in d && isZodSchema(d.schema)) { t = d.schema; continue; }
    if ("type" in d && isZodSchema(d.type)) { t = d.type; continue; }

    return t;
  }
}

function typeToString(t0: any): string {
  const t = unwrap(t0);
  if (!isZodSchema(t)) return "unknown";

  const def: any = t._def || {};
  const kind: string = def.typeName;

  switch (kind) {
    case "ZodString": return "string";
    case "ZodNumber": return "number";
    case "ZodBoolean": return "boolean";
    case "ZodDate": return "date";
    case "ZodBigInt": return "bigint";
    case "ZodLiteral": return JSON.stringify(def.value);
    case "ZodEnum": return `enum<${Array.isArray(def.values) ? def.values.join(" | ") : ""}>`;
    case "ZodNativeEnum": return "enum";
    case "ZodNull": return "null";
    case "ZodUndefined": return "undefined";
    case "ZodUnknown": return "unknown";
    case "ZodAny": return "any";

    case "ZodArray": {
      const elem = def.type;
      return `array<${isZodSchema(elem) ? typeToString(elem) : "unknown"}>`;
    }

    case "ZodRecord": {
      const valueType = def.valueType;
      return `record<string, ${isZodSchema(valueType) ? typeToString(valueType) : "unknown"}>`;
    }

    case "ZodUnion": {
      const options: any[] = Array.isArray(def.options) ? def.options : [];
      return options.map(o => (isZodSchema(o) ? typeToString(o) : "unknown")).join(" | ");
    }

    case "ZodDiscriminatedUnion": {
      const optMap: Map<any, any> | undefined = def.options;
      const options = optMap ? Array.from(optMap.values()) : [];
      return options.map(o => (isZodSchema(o) ? typeToString(o) : "unknown")).join(" | ");
    }

    case "ZodObject": return "object";
    //case "ZodTuple": return "tuple";
    case "ZodTuple": {
      const items = (def.items ?? []).map((i: any) => isZodSchema(i) ? typeToString(i) : "unknown");
      return `tuple<${items.join(", ")}>`;
    }

    default: return "unknown";
  }
}

// Safe meta/description pull
function getDescription(s: any): string | undefined {
  if (isZodSchema(s) && typeof (s as any).meta === "function") {
    const m = (s as any).meta();
    if (m?.description) return m.description;
  }
  // Fallback to private def (older Zod)
  if (isZodSchema(s) && s._def?.description) return s._def.description;
  // Try unwrapped
  const u = unwrap(s);
  if (u && typeof (u as any).meta === "function") {
    const m = (u as any).meta();
    if (m?.description) return m.description;
  }
  if (u?._def?.description) return u._def.description;
  return undefined;
}

/*
type FieldInfo = {
  path: string;          // e.g., "templates", "knowledge[].source"
  type: string;          // e.g., "string", "array<string>", "record<string, ...>"
  optional: boolean;
  description?: string;
};

function fieldDescription(t: ZodTypeAny): string | undefined {
  // Prefer wrapper meta (where .describe is usually attached), then inner
  return t.meta?.()?.description
      || unwrap(t).meta?.()?.description
      // fallback (older Zod): private def
      // @ts-expect-error private
      || t._def?.description
      // @ts-expect-error private
      || unwrap(t)._def?.description;
}
*/

// Collect fields safely from a Zod object schema
function collectFields(schema: any, prefix = ""): Array<{
  path: string;
  type: string;
  optional: boolean;
  description?: string;
}> {
  const out: any[] = [];
  const obj = unwrap(schema);
  if (!isZodSchema(obj) || obj._def?.typeName !== "ZodObject") return out;

  const shape = (obj as z.ZodObject<any>).shape;
  for (const key of Object.keys(shape)) {
    const original: any = (shape as any)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    const unwrapped = unwrap(original);

    const optional = !!(original && typeof original.isOptional === "function" && original.isOptional());
    const description = getDescription(original);
    const typeStr = typeToString(original);

    out.push({ path, type: typeStr, optional, description });

    // Recurse into nested object/array-of-object/record-of-object if desired
    if (isZodSchema(unwrapped) && unwrapped._def?.typeName === "ZodObject") {
      out.push(...collectFields(unwrapped, path));
    } else if (isZodSchema(unwrapped) && unwrapped._def?.typeName === "ZodArray") {
      const elem = unwrap(unwrapped._def?.type);
      if (isZodSchema(elem) && elem._def?.typeName === "ZodObject") {
        out.push(...collectFields(elem, `${path}[]`));
      }
    } else if (isZodSchema(unwrapped) && unwrapped._def?.typeName === "ZodRecord") {
      const val = unwrap(unwrapped._def?.valueType);
      if (isZodSchema(val) && val._def?.typeName === "ZodObject") {
        out.push(...collectFields(val, `${path}{value}`));
      }
    }
  }
  return out;
}

/** Turn a Zod object schema into text for LLM prompts */
export function schemaToPrompt(schema: any): string {
  const desc = getDescription(schema);
  const lines = [desc ? `Schema: ${desc}` : "Schema:"];
  const fields = collectFields(schema);
  for (const f of fields) {
    const opt = f.optional ? "optional" : "required";
    const d = f.description ? ` — ${f.description}` : "";
    lines.push(`- ${f.path} (${f.type}, ${opt})${d}`);
  }
  return lines.join("\n");
}