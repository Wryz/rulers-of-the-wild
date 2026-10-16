import { describe, expect, it } from 'vitest';

// Player input must reach the sim only as tick-tagged commands (docs/SPEC.md, Commands).
// The client can't be run headless, so this guards the rule by reading its source: no
// client code may write a fighter's input fields or press its buttons directly.
const SOURCES = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('client input routing', () => {
  it('reads the client sources', () => {
    expect(Object.keys(SOURCES)).toContain('../src/game/game.ts');
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
  });

  it('never writes moveInput, press() or pickupRequest on a fighter', () => {
    const offences: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      text.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\.moveInput\b/.test(code) || /\.press\(/.test(code) || /\.pickupRequest\s*=\s*[1-9]/.test(code)) {
          offences.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });

  it("queues the player's input as commands in the game loop", () => {
    const game = SOURCES['../src/game/game.ts'];
    expect(game).toMatch(/this\.sim\.commands\.push\(\s*moveCommand\(/);
    expect(game).toMatch(/kind: 'button'/);
  });
});
