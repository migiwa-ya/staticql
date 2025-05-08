/**
 * Performs a simple runtime validation of a value against a JSON-like schema.
 *
 * Supported types: "string", "number", "integer", "boolean", "date", "null", "array", "object".
 *
 * @param data - The value to validate.
 * @param schema - The validation schema object.
 * @throws Error if the data does not conform to the schema.
 */
export function simpleValidate(data: any, schema: any): void {
  const expectedType = schema.type;

  if (!expectedType) return;

  if (expectedType === "null") {
    if (data !== null) {
      throw new Error(`Expected null, got ${typeof data}`);
    }
    return;
  }

  if (expectedType === "array") {
    if (!Array.isArray(data)) {
      throw new Error(`Expected array, got ${typeof data}`);
    }
    if (schema.items) {
      for (const item of data) {
        simpleValidate(item, schema.items);
      }
    }
    return;
  }

  if (expectedType === "object") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`Expected object, got ${typeof data}`);
    }

    for (const key of schema.required ?? []) {
      if (!(key in data)) {
        throw new Error(`Missing required field: ${key}`);
      }
    }

    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      const val = data[key];
      if (val !== undefined) {
        simpleValidate(val, propSchema);
      }
    }
    return;
  }

  const actualType = typeof data;

  switch (expectedType) {
    case "string":
      if (actualType !== "string") {
        throw new Error(`Expected string, got ${actualType}`);
      }
      break;

    case "number":
      if (actualType !== "number") {
        throw new Error(`Expected number, got ${actualType}`);
      }
      break;

    case "integer":
      if (actualType !== "number" || !Number.isInteger(data)) {
        throw new Error(`Expected integer, got ${data}`);
      }
      break;

    case "boolean":
      if (actualType !== "boolean") {
        throw new Error(`Expected boolean, got ${actualType}`);
      }
      break;

    case "date":
      if (!(typeof data === "string" && !isNaN(Date.parse(data)))) {
        throw new Error(`Expected date (ISO 8601 string), got ${data}`);
      }
      break;

    default:
      throw new Error(`Unsupported type in schema: ${expectedType}`);
  }
}
