import { describe, expect, it } from 'vitest';
import { CASES, numbersIn } from '../evals/cases.js';

describe('eval harness', () => {
  it('parses Turkish and English number formats', () => {
    expect(numbersIn('ROAS 18,81 ve harcama 5.415,20 TL, %-12,5')).toEqual([18.81, 5415.2, -12.5]);
    expect(numbersIn('spend was 1,234.56 and CPA 63.5')).toEqual([1234.56, 63.5]);
    expect(numbersIn('toplam 12.000 TL')).toEqual([12000]);
  });

  it('has unique case ids covering analysis, action and safety', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(new Set(CASES.map((c) => c.checks))).toEqual(new Set(['analysis', 'action', 'safety']));
  });
});
