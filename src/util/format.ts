import type { Protocol } from "devtools-protocol";

const MAX_PREVIEW = 200;

export function truncate(s: string, max = MAX_PREVIEW): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}

// Compact textual preview of a CDP RemoteObject without dereferencing further.
export function previewRemoteObject(obj: Protocol.Runtime.RemoteObject): string {
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.type === "undefined") return "undefined";
  if (obj.subtype === "null") return "null";
  if (obj.type === "string") return JSON.stringify(obj.value ?? "");
  if (obj.type === "number" || obj.type === "boolean" || obj.type === "bigint") {
    return String(obj.value);
  }
  if (obj.type === "function") {
    return obj.description ? truncate(obj.description) : "function";
  }
  if (obj.preview) {
    return truncate(previewFromPreview(obj.preview));
  }
  if (obj.description) return truncate(obj.description);
  return obj.className ?? obj.subtype ?? obj.type;
}

function previewFromPreview(p: Protocol.Runtime.ObjectPreview): string {
  if (p.subtype === "array") {
    const items = (p.properties ?? [])
      .map((pp) => previewProperty(pp))
      .join(", ");
    return `[${items}${p.overflow ? ", …" : ""}]`;
  }
  const items = (p.properties ?? [])
    .map((pp) => `${pp.name}: ${previewProperty(pp)}`)
    .join(", ");
  const head = p.description && p.description !== "Object" ? `${p.description} ` : "";
  return `${head}{${items}${p.overflow ? ", …" : ""}}`;
}

function previewProperty(p: Protocol.Runtime.PropertyPreview): string {
  if (p.type === "string") return JSON.stringify(p.value ?? "");
  if (p.value !== undefined) return p.value;
  return p.type;
}

export function describeRemote(obj: Protocol.Runtime.RemoteObject): {
  type: string;
  preview: string;
  objectId?: string;
} {
  return {
    type: obj.subtype ?? obj.type,
    preview: previewRemoteObject(obj),
    ...(obj.objectId ? { objectId: obj.objectId } : {}),
  };
}

// Wrap any value into the MCP tool content envelope.
export function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Stringify a JSON result with a stable shape for the LLM to parse.
export function toolJson(value: unknown) {
  return toolText(JSON.stringify(value, null, 2));
}
