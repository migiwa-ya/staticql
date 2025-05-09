import { Validator } from "./Validator.js";
import { simpleValidate } from "./simpleValidate.js";

/**
 * A basic Validator implementation using simple structural validation logic.
 *
 * This validator checks data against a minimal JSON-like schema
 * using the `simpleValidate` function.
 */
export const defaultValidator: Validator = {
  /**
   * Validates a data object using the built-in simple validator.
   *
   * @param data - The data to validate.
   * @param schema - The JSON-like schema definition.
   * @param path - The schema property name.
   * @throws If validation fails.
   */
  validate(data, schema, path) {
    simpleValidate(data, schema, path);
  },
};
