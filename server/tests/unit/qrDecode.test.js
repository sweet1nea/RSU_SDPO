'use strict';

// client/js/shared/qr-decode.js — the retry ladder the admin scanners use for
// hard-to-read (engraved) QR codes. jsQR is replaced by a fake so the tests
// check the order of attempts, not the QR decoding itself.

const { decodeQr, stretchContrast } = require('../../../client/js/shared/qr-decode');

function frame(w, h, lo, hi) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const v = i % 2 ? lo : hi;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return d;
}

describe('stretchContrast', () => {
  test('expands a low-contrast frame to the full 0-255 range', () => {
    const out = stretchContrast(frame(64, 64, 110, 140), 64, 64);
    const vals = new Set();
    for (let i = 0; i < out.length; i += 4) vals.add(out[i]);
    expect(Math.min(...vals)).toBe(0);
    expect(Math.max(...vals)).toBe(255);
  });
  test('returns null for a flat frame', () => {
    expect(stretchContrast(frame(64, 64, 128, 128), 64, 64)).toBeNull();
  });
});

describe('decodeQr', () => {
  const w = 640;
  const h = 480;
  const data = frame(w, h, 110, 140);

  test('returns the first successful read and stops', () => {
    const jsQR = jest.fn().mockReturnValue({ data: 'CODE-1' });
    expect(decodeQr(jsQR, data, w, h)).toBe('CODE-1');
    expect(jsQR).toHaveBeenCalledTimes(1);
    expect(jsQR.mock.calls[0][3]).toEqual({ inversionAttempts: 'attemptBoth' });
  });
  test('falls back to the contrast-stretched frame', () => {
    const jsQR = jest.fn().mockReturnValueOnce(null).mockReturnValueOnce({ data: 'CODE-2' });
    expect(decodeQr(jsQR, data, w, h)).toBe('CODE-2');
    expect(jsQR).toHaveBeenCalledTimes(2);
  });
  test('then tries the half-size frame', () => {
    const jsQR = jest.fn().mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValueOnce({ data: 'CODE-3' });
    expect(decodeQr(jsQR, data, w, h)).toBe('CODE-3');
    expect(jsQR.mock.calls[2][1]).toBe(w / 2);
  });
  test('returns null when nothing reads', () => {
    expect(decodeQr(jest.fn().mockReturnValue(null), data, w, h)).toBeNull();
  });
  test('enhance:false only makes the cheap attempt', () => {
    const jsQR = jest.fn().mockReturnValue(null);
    expect(decodeQr(jsQR, data, w, h, { enhance: false })).toBeNull();
    expect(jsQR).toHaveBeenCalledTimes(1);
  });
});
