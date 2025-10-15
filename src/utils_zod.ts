import { z, ZodTypeAny, ZodObject } from "zod";

/** Unwrap common wrappers so we can see the underlying type */
function unwrap(t: ZodTypeAny): ZodTypeAny {
  // Peel off Optional/Nullable/Default/Effects/Branded/Readonly/Catch, etc.
  // Uses minimal private fields where needed; fine for tooling.
  // Loop until stable.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // @ts-expect-error private access
    const def = t?._def;
    if (!def) break;

    if (t.isOptional?.()) { t = def.innerType; continue; }
    // nullable, default
    if (def?.innerType) { t = def.innerType; continue; }
    // effects(schema)
    if (def?.schema) { t = def.schema; continue; }
    // branded/readonly/catch/pipeline(type)
    if (def?.type) { t = def.type; continue; }

    break;
  }
  return t;
}

/*
function typeToString(t: ZodTypeAny): string {
  t = unwrap(t);

  if (t instanceof z.ZodString) return "string";
  if (t instanceof z.ZodNumber) return "number";
  if (t instanceof z.ZodBoolean) return "boolean";
  if (t instanceof z.ZodDate) return "date";
  if (t instanceof z.ZodBigInt) return "bigint";
  if (t instanceof z.ZodLiteral) return JSON.stringify(t.value);
  if (t instanceof z.ZodEnum) return `enum<${t._def.values.join(" | ")}>`;
  if (t instanceof z.ZodNativeEnum) return "enum";
  if (t instanceof z.ZodArray) {
    // @ts-expect-error private
    const elem = t._def.type as ZodTypeAny;
    return `array<${typeToString(elem)}>`;
  }
  if (t instanceof z.ZodRecord) {
    // @ts-expect-error private
    const valueType = t._def.valueType as ZodTypeAny;
    return `record<string, ${typeToString(valueType)}>`;
  }
  if (t instanceof z.ZodUnion) {
    // @ts-expect-error private
    const options = t._def.options as ZodTypeAny[];
    return options.map(typeToString).join(" | ");
  }
  if (t instanceof z.ZodDiscriminatedUnion) {
    // @ts-expect-error private
    const options = [...t._def.options.values()] as ZodTypeAny[];
    return options.map(typeToString).join(" | ");
  }
  if (t instanceof z.ZodObject) return "object";
  if (t instanceof z.ZodTuple) return "tuple";
  if (t instanceof z.ZodUnknown) return "unknown";
  if (t instanceof z.ZodAny) return "any";
  if (t instanceof z.ZodNull) return "null";
  if (t instanceof z.ZodUndefined) return "undefined";

  return "unknown";
}
*/

function typeToString(t: ZodTypeAny): string {
  t = unwrap(t);
  // @ts-expect-error private
  const def = t._def ?? {};
  const kind: string = def.typeName; // like "ZodString", "ZodArray", ...

  switch (kind) {
    case "ZodString": return "string";
    case "ZodNumber": return "number";
    case "ZodBoolean": return "boolean";
    case "ZodDate": return "date";
    case "ZodBigInt": return "bigint";
    case "ZodLiteral": return JSON.stringify(def.value);
    case "ZodEnum": return `enum<${(def.values as string[]).join(" | ")}>`;
    case "ZodNativeEnum": return "enum";
    case "ZodNull": return "null";
    case "ZodUndefined": return "undefined";
    case "ZodUnknown": return "unknown";
    case "ZodAny": return "any";
    case "ZodArray": {
      const elem = def.type as z.ZodTypeAny;
      return `array<${typeToString(elem)}>`;
    }
    case "ZodRecord": {
      const valueType = def.valueType as z.ZodTypeAny;
      return `record<string, ${typeToString(valueType)}>`;
    }
    case "ZodUnion": {
      const options = def.options as z.ZodTypeAny[];
      return options.map(typeToString).join(" | ");
    }
    case "ZodDiscriminatedUnion": {
      const options = Array.from((def.options as Map<any, any>).values()) as z.ZodTypeAny[];
      return options.map(typeToString).join(" | ");
    }
    case "ZodObject": return "object";
    case "ZodTuple": return "tuple";
    default: return "unknown";
  }
}

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

function collectFields(
  schema: ZodObject<any>,
  prefix = ""
): FieldInfo[] {
  const out: FieldInfo[] = [];
  const shape = schema.shape;

  for (const key of Object.keys(shape)) {
    const original = shape[key] as ZodTypeAny;
    const unwrapped = unwrap(original);
    const path = prefix ? `${prefix}.${key}` : key;

    const info: FieldInfo = {
      path,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      optional: original.isOptional?.() === true,
      type: typeToString(unwrapped),
      description: fieldDescription(original),
    };

    if (unwrapped instanceof z.ZodObject) {
      out.push(info); // include the parent node (object) summary
      out.push(...collectFields(unwrapped, path)); // and recurse into children
    } else {
      out.push(info);
    }
  }

  return out;
}

/** Turn a Zod object schema into a prompt-friendly text block */
export function schemaToPrompt(schema: ZodObject<any>): string {
  const lines: string[] = [];
  const desc =
    schema.meta?.()?.description
    // @ts-expect-error private (older Zod)
    || schema._def?.description;

  if (desc) {
    lines.push(`Schema: ${desc}`);
  } else {
    lines.push("Schema:");
  }

  const fields = collectFields(schema);
  for (const f of fields) {
    const opt = f.optional ? "optional" : "required";
    const descPart = f.description ? ` — ${f.description}` : "";
    lines.push(`- ${f.path} (${f.type}, ${opt})${descPart}`);
  }

  return lines.join("\n");
}