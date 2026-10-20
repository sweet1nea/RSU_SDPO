/* Forgiving QR decoding for the admin camera scanners.
 *
 * jsQR on its own reads clean, high-contrast codes but gives up on the kind
 * of image a camera gets of a laser-engraved label: low contrast between the
 * marks and the surface, glare, slight blur, or light marks on a dark
 * surface. decodeQr() tries, in order, and returns the first success:
 *   1. the frame as it is (both dark-on-light and light-on-dark);
 *   2. the frame with its contrast stretched to the full range;
 *   3. the stretched frame at half size (a blurry code reads better smaller).
 * The cheap first attempt handles a normal code, so the extra work only
 * happens while a hard-to-read code is in view.
 *
 * The scanners call this once per camera frame. Steps 2 and 3 cost more, so
 * pass { enhance: false } on some frames to keep the video smooth; the
 * default is to run everything.
 *
 * Usage: RsuQrDecode.decodeQr(jsQR, imageData.data, width, height[, opts])
 *        -> string | null
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RsuQrDecode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Greyscale, then stretch the 2nd-98th percentile range to 0-255. Using
  // percentiles instead of min/max keeps a few glare pixels from flattening
  // the rest of the image. Returns RGBA so jsQR can read it unchanged.
  function stretchContrast(rgba, width, height) {
    var n = width * height;
    var grey = new Uint8ClampedArray(n);
    var hist = new Uint32Array(256);
    for (var i = 0, p = 0; i < n; i += 1, p += 4) {
      var g = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
      grey[i] = g;
      hist[grey[i]] += 1;
    }
    var lowCut = n * 0.02;
    var highCut = n * 0.98;
    var lo = 0;
    var hi = 255;
    var acc = 0;
    for (var v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= lowCut) {
        lo = v;
        break;
      }
    }
    acc = 0;
    for (var w = 0; w < 256; w += 1) {
      acc += hist[w];
      if (acc >= highCut) {
        hi = w;
        break;
      }
    }
    if (hi - lo < 8) return null; // flat frame — nothing to stretch
    var scale = 255 / (hi - lo);
    var out = new Uint8ClampedArray(n * 4);
    for (var j = 0, q = 0; j < n; j += 1, q += 4) {
      var s = (grey[j] - lo) * scale;
      out[q] = out[q + 1] = out[q + 2] = s;
      out[q + 3] = 255;
    }
    return out;
  }

  // Box-average the image down to half size.
  function halve(rgba, width, height) {
    var w2 = width >> 1;
    var h2 = height >> 1;
    var out = new Uint8ClampedArray(w2 * h2 * 4);
    for (var y = 0; y < h2; y += 1) {
      for (var x = 0; x < w2; x += 1) {
        var o = (y * w2 + x) * 4;
        var a = ((2 * y) * width + 2 * x) * 4;
        var b = a + 4;
        var c = a + width * 4;
        var d = c + 4;
        for (var k = 0; k < 3; k += 1) out[o + k] = (rgba[a + k] + rgba[b + k] + rgba[c + k] + rgba[d + k]) >> 2;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w2, height: h2 };
  }

  function decodeQr(jsQR, rgba, width, height, options) {
    var enhance = !options || options.enhance !== false;
    var opts = { inversionAttempts: 'attemptBoth' };
    var r = jsQR(rgba, width, height, opts);
    if (r && r.data) return r.data;
    if (!enhance) return null;

    var stretched = stretchContrast(rgba, width, height);
    if (!stretched) return null;
    r = jsQR(stretched, width, height, opts);
    if (r && r.data) return r.data;

    if (width >= 320 && height >= 240) {
      var small = halve(stretched, width, height);
      r = jsQR(small.data, small.width, small.height, opts);
      if (r && r.data) return r.data;
    }
    return null;
  }

  return { decodeQr: decodeQr, stretchContrast: stretchContrast };
});
