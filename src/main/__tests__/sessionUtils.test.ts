import { describe, it, expect } from 'vitest';
import { decodeCwd, formatTimestamp, readSessionCwd, readSessionName, readGroupCwd } from '../sessionUtils';

describe('decodeCwd', () => {
  it('decodes a --C--Users-hcz-.pi-agent-- path', () => {
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toBe('C:\\Users-hcz-.pi-agent');
  });

  it('decodes a --D--personal-agent_space-pi-tool-- path', () => {
    expect(decodeCwd('--D--personal-agent_space-pi-tool--')).toBe('D:\\personal-agent_space-pi-tool');
  });

  it('decodes nested -- separated segments', () => {
    expect(decodeCwd('--D--a--b--c--')).toBe('D:\\a\\b\\c');
  });

  it('handles C--Users--test without leading --', () => {
    expect(decodeCwd('C--Users--test')).toBe('C:\\Users\\test');
  });

  it('handles empty string', () => {
    expect(decodeCwd('')).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('formats a full ISO-ish filename', () => {
    expect(formatTimestamp('2026-07-03T19-07-11-857Z_abc.jsonl')).toBe('2026-07-03 19:07');
  });

  it('returns unchanged for non-matching filenames', () => {
    expect(formatTimestamp('notes.txt')).toBe('notes.txt');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('abc.jsonl')).toBe('abc.jsonl');
  });
});

describe('readSessionCwd', () => {
  it('reads cwd from the first line of a .jsonl file', () => {
    const file = __dirname + '/fixtures/read-session-cwd.jsonl';
    // Create inline test fixture
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{"cwd":"/my/project"}\n{"type":"message"}');
    expect(readSessionCwd(file)).toBe('/my/project');
    fs.unlinkSync(file);
  });

  it('returns undefined for nonexistent file', () => {
    expect(readSessionCwd('/tmp/nonexistent.jsonl')).toBeUndefined();
  });

  it('returns undefined when first line has no cwd', () => {
    const file = __dirname + '/fixtures/no-cwd.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{"type":"message"}\n');
    expect(readSessionCwd(file)).toBeUndefined();
    fs.unlinkSync(file);
  });
});

describe('readSessionName', () => {
  it('reads the first user message as the session name', () => {
    const file = __dirname + '/fixtures/read-session-name.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'message', message: { role: 'user', content: 'Hello, please help me' }
    }));
    expect(readSessionName(file)).toBe('Hello, please help me');
    fs.unlinkSync(file);
  });

  it('returns undefined when the file has no user message', () => {
    const file = __dirname + '/fixtures/no-user-message.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'message', message: { role: 'assistant', content: 'Hello' }
    }));
    expect(readSessionName(file)).toBeUndefined();
    fs.unlinkSync(file);
  });

  it('returns undefined for nonexistent file', () => {
    expect(readSessionName('/tmp/nonexistent.jsonl')).toBeUndefined();
  });
});

describe('readGroupCwd', () => {
  it('reads cwd from the first .jsonl file in the directory', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = __dirname + '/fixtures/group-cwd';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'first.jsonl'), '{"cwd":"/group/cwd"}');
    fs.writeFileSync(path.join(dir, 'second.jsonl'), '{"cwd":"/other"}');
    expect(readGroupCwd(dir)).toBe('/group/cwd');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns undefined when directory has no .jsonl files', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = __dirname + '/fixtures/empty-group';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    expect(readGroupCwd(dir)).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });
});