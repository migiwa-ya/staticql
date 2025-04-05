import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const configPath = path.join(__dirname, 'staticql.config.ts');
const outputPath = path.join(__dirname, 'output');
const indexFile = path.join(outputPath, 'herbs.index.json');

describe('CLI generate.ts', () => {
  beforeAll(async () => {
    await fs.rm(outputPath, { recursive: true, force: true });

   
    await exec('tsx', [
      path.resolve('cli/generate.ts'),
      configPath,
      outputPath
    ]);
  });

  it('should generate herbs.index.json with correct structure', async () => {
    const exists = await fs.stat(indexFile).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const json = JSON.parse(await fs.readFile(indexFile, 'utf-8'));
    expect(json.fields).toContain('name');
    expect(json.fields).toContain('herbState.name');

    const record = json.records.find((r: any) => r.slug === 'peppermint');
    expect(record.values.name).toBe('ペパーミント');
    expect(record.values['herbState.name']).toBe('乾燥');
  });
});
