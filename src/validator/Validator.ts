// 暫定的なJSON Schema型
type JSONSchema7 = {
  type?: string;
  properties?: {
    [key: string]: JSONSchema7;
  };
  items?: JSONSchema7;
  required?: string[];
  enum?: string[];
  [key: string]: any; // その他プロパティの許容（緩めの設定）
};

export interface Validator {
  validate(data: unknown, schema: JSONSchema7): void | never;
}
