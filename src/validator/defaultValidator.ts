import { Validator } from "./Validator.js";
import { simpleValidate } from "./simpleValidate.js";

export const defaultValidator: Validator = {
  validate(data, schema) {
    simpleValidate(data, schema);
  },
};
