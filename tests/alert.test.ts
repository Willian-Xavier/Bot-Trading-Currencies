import { describe, expect, it } from 'vitest';
import { isAlertTriggered, isValidTradingViewSymbol, normalizeSymbol } from '../src/domain/alert.js';

describe('alert domain rules', () => {
  it('triggers buy when price reaches or falls below target', () => {
    expect(isAlertTriggered('buy', 100, 100)).toBe(true);
    expect(isAlertTriggered('buy', 99.99, 100)).toBe(true);
    expect(isAlertTriggered('buy', 100.01, 100)).toBe(false);
  });

  it('triggers sell when price reaches or rises above target', () => {
    expect(isAlertTriggered('sell', 100, 100)).toBe(true);
    expect(isAlertTriggered('sell', 100.01, 100)).toBe(true);
    expect(isAlertTriggered('sell', 99.99, 100)).toBe(false);
  });

  it('normalizes and validates exchange-qualified symbols', () => {
    expect(normalizeSymbol(' nasdaq:aapl ')).toBe('NASDAQ:AAPL');
    expect(isValidTradingViewSymbol('NASDAQ:AAPL')).toBe(true);
    expect(isValidTradingViewSymbol('FX:EURUSD')).toBe(true);
    expect(isValidTradingViewSymbol('AAPL')).toBe(false);
  });
});
