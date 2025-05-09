/**
 * Simplified JSON Schema (draft-07 compatible) definition.
 */
export type JSONSchema7 = {
  type?: string | string[];
  properties?: {
    [key: string]: JSONSchema7;
  };
  items?: JSONSchema7;
  required?: string[];
  enum?: string[];
  [key: string]: any;
};

/**
 * Validator interface for schema-based data validation.
 */
export interface Validator {
  /**
   * Validates a data object against the given JSON schema.
   *
   * @param data - The data to be validated.
   * @param schema - A JSONSchema7-compliant schema.
   * @param path - The schema property name.
   * @throws If validation fails.
   */
  validate(data: unknown, schema: JSONSchema7, path?: string): void | never;
}
