/**
 * Performs a simple runtime validation of a value against a JSON-like schema.
 *
 * Supported types: "string", "number", "integer", "boolean", "date", "null", "array", "object".
 *
 * @param data - The value to validate.
 * @param schema - The validation schema object.
 * @throws Error if the data does not conform to the schema.
 */
export function simpleValidate(
  data: any,
  schema: any,
  path: string = ""
): void {
  const expectedType = schema.type;

  if (!expectedType) return;

  const types = Array.isArray(expectedType) ? expectedType : [expectedType];

  const fullPath = path || "value";

  // Handle null
  if (data === null) {
    if (!types.includes("null")) {
      throw new Error(
        `Expected ${types.join(" or ")} at '${fullPath}', got null`
      );
    }
    return;
  }

  // Handle arrays
  if (types.includes("array")) {
    if (!Array.isArray(data)) {
      throw new Error(`Expected array at '${fullPath}', got ${typeof data}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        simpleValidate(data[i], schema.items, `${fullPath}[${i}]`);
      }
    }
    return;
  }

  // Handle objects
  if (types.includes("object")) {
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Expected object at '${fullPath}', got ${typeof data}`);
    }

    for (const key of schema.required ?? []) {
      if (!(key in data)) {
        throw new Error(`Missing required field: '${fullPath}.${key}'`);
      }
    }

    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      const val = data[key];
      if (val !== undefined) {
        simpleValidate(val, propSchema, `${fullPath}.${key}`);
      }
    }
    return;
  }

  // Handle primitives
  const actualType = typeof data;
  let valid = false;

  for (const type of types) {
    switch (type) {
      case "string":
        if (actualType === "string") valid = true;
        break;
      case "number":
        if (actualType === "number") valid = true;
        break;
      case "integer":
        if (actualType === "number" && Number.isInteger(data)) valid = true;
        break;
      case "boolean":
        if (actualType === "boolean") valid = true;
        break;
      case "date":
        if (
          (typeof data === "string" || typeof data === "object") &&
          !isNaN(Date.parse(data))
        )
          valid = true;
        break;
      case "null":
        // already handled
        break;
    }
    if (valid) break;
  }

  if (!valid) {
    throw new Error(
      `Expected ${types.join(" or ")} at '${fullPath}', got ${actualType}`
    );
  }
}
