"use strict";

// Testes do encoder de GIF do AutoPhysics (com.autophysics.panel/js/gif.js).
// Rodar: node test/autophysics/gif.test.js
//
// Codifica quadros sintéticos e decodifica de volta com um decodificador
// mínimo e independente escrito aqui (LZW + composição de transparência), e
// confere pixel a pixel contra os quadros originais mapeados na paleta.

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var G = require("../com.autophysics.panel/js/gif.js");

// ---- decodificador de referência ----

function lzwDecode(data, minCodeSize, pixelCount) {
    var clear = 1 << minCodeSize, eoi = clear + 1;
    var codeSize = minCodeSize + 1, dict = [], next = eoi + 1, prev = null;
    var out = [], bitPos = 0;
    function reset() {
        dict = [];
        for (var i = 0; i < clear; i++) dict[i] = [i];
        codeSize = minCodeSize + 1; next = eoi + 1; prev = null;
    }
    reset();
    for (;;) {
        if (bitPos + codeSize > data.length * 8) break;
        var code = 0;
        for (var b = 0; b < codeSize; b++) {
            var bit = (data[(bitPos + b) >> 3] >> ((bitPos + b) & 7)) & 1;
            code |= bit << b;
        }
        bitPos += codeSize;
        if (code === clear) { reset(); continue; }
        if (code === eoi) break;
        var entry;
        if (code < next && dict[code]) entry = dict[code];
        else if (code === next && prev) entry = prev.concat([prev[0]]);
        else throw new Error("código LZW inválido " + code + " (next " + next + ")");
        for (var e = 0; e < entry.length; e++) out.push(entry[e]);
        if (prev && next < 4096) {
            dict[next++] = prev.concat([entry[0]]);
            if (next === (1 << codeSize) && codeSize < 12) codeSize++;
        }
        prev = entry;
    }
    assert.strictEqual(out.length, pixelCount, "LZW decodificou " + out.length + " pixels, esperava " + pixelCount);
    return out;
}

function decodeGif(bytes) {
    var p = 0;
    function u8() { return bytes[p++]; }
    function u16() { var v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; }
    var sig = String.fromCharCode.apply(null, bytes.subarray(0, 6)); p = 6;
    assert.strictEqual(sig, "GIF89a");
    var w = u16(), h = u16(), packed = u8(); u8(); u8();
    assert.ok(packed & 0x80, "tem tabela global");
    var gctSize = 1 << ((packed & 7) + 1);
    var gct = [];
    for (var i = 0; i < gctSize; i++) gct.push([u8(), u8(), u8()]);
    var screen = new Uint8Array(w * h * 3);
    var frames = [], gce = null, loop = false;
    for (;;) {
        var t = u8();
        if (t === 0x3B) break;
        if (t === 0x21) {
            var label = u8();
            if (label === 0xF9) {
                u8(); var pk = u8(); var delay = u16(); var ti = u8(); u8();
                gce = { disposal: (pk >> 2) & 7, transparent: pk & 1, ti: ti, delay: delay };
            } else {
                var size = u8();
                var ident = String.fromCharCode.apply(null, bytes.subarray(p, p + size));
                p += size;
                if (ident === "NETSCAPE2.0") loop = true;
                for (var sz = u8(); sz > 0; sz = u8()) p += sz;
            }
            continue;
        }
        assert.strictEqual(t, 0x2C, "bloco desconhecido 0x" + t.toString(16));
        var fx = u16(), fy = u16(), fw = u16(), fh = u16(), ipk = u8();
        assert.strictEqual(ipk & 0x80, 0, "sem tabela local");
        var mcs = u8(), chunks = [];
        for (var bs = u8(); bs > 0; bs = u8()) { chunks.push(bytes.subarray(p, p + bs)); p += bs; }
        var data = Buffer.concat(chunks.map(function (c) { return Buffer.from(c); }));
        var idx = lzwDecode(data, mcs, fw * fh);
        for (var y = 0; y < fh; y++) {
            for (var x = 0; x < fw; x++) {
                var ci = idx[y * fw + x];
                if (gce && gce.transparent && ci === gce.ti) continue;
                var o = ((fy + y) * w + fx + x) * 3;
                screen[o] = gct[ci][0]; screen[o + 1] = gct[ci][1]; screen[o + 2] = gct[ci][2];
            }
        }
        frames.push({ rgb: screen.slice(), delay: gce ? gce.delay : 0 });
        gce = null;
    }
    return { width: w, height: h, frames: frames, loop: loop, gct: gct };
}

// ---- quadros sintéticos: fundo em degradê + quadrados coloridos se movendo ----

var W = 120, H = 90;
function makeFrame(t) {
    var rgba = new Uint8Array(W * H * 4);
    for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
            var o = (y * W + x) * 4;
            rgba[o] = 200 + Math.round(55 * x / W); rgba[o + 1] = 230; rgba[o + 2] = 240 - Math.round(40 * y / H); rgba[o + 3] = 255;
        }
    }
    function square(cx, cy, s, r, g, b) {
        for (var y = Math.max(0, cy); y < Math.min(H, cy + s); y++) {
            for (var x = Math.max(0, cx); x < Math.min(W, cx + s); x++) {
                var o = (y * W + x) * 4;
                rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
            }
        }
    }
    square(10 + t * 3, 10 + t * 2, 20, 230, 60, 50);
    square(70, 5 + t * 4, 15, 40, 90, 220);
    square(30, 60, 12, 30, 160, 70); // parado
    return rgba;
}

var times = [0, 1, 2, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10];
var frames = times.map(makeFrame);

var pal = new G.Palette();
frames.forEach(function (f) { pal.addPixels(f, 1); });
pal.build(G.MAX_COLORS);
assert.ok(pal.colors.length <= 255, "no máximo 255 cores úteis");

var enc = new G.GifEncoder(W, H, { loop: true });
enc.setPalette(pal);
frames.forEach(function (f) { enc.addFrame(f, 4); });
var bytes = enc.finish();

var dec = decodeGif(bytes);
assert.strictEqual(dec.width, W);
assert.strictEqual(dec.height, H);
assert.ok(dec.loop, "GIF repete (NETSCAPE2.0)");
// Os 3 quadros com t=3 são iguais: viram um quadro só, com duração 3x.
assert.strictEqual(dec.frames.length, times.length - 2, "quadros idênticos foram unidos");
assert.strictEqual(dec.frames[3].delay, 12, "duração somada dos quadros iguais");

// Cada quadro decodificado = o original mapeado na paleta, pixel a pixel.
var unique = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12];
unique.forEach(function (fi, k) {
    var expected = pal.index(frames[fi], new Uint8Array(W * H));
    var got = dec.frames[k].rgb;
    for (var i = 0; i < W * H; i++) {
        var c = pal.colors[expected[i]];
        if (got[i * 3] !== c[0] || got[i * 3 + 1] !== c[1] || got[i * 3 + 2] !== c[2]) {
            assert.fail("quadro " + k + " pixel " + i + " difere: " + [got[i * 3], got[i * 3 + 1], got[i * 3 + 2]] + " != " + c);
        }
    }
});
// As cores sólidas dos quadrados têm que sair quase exatas (paleta boa).
function nearest(rgb) {
    var best = Infinity;
    pal.colors.forEach(function (c) { best = Math.min(best, Math.abs(c[0] - rgb[0]) + Math.abs(c[1] - rgb[1]) + Math.abs(c[2] - rgb[2])); });
    return best;
}
assert.ok(nearest([230, 60, 50]) <= 12 && nearest([40, 90, 220]) <= 12 && nearest([30, 160, 70]) <= 12, "cores sólidas preservadas");
console.log("roundtrip de " + dec.frames.length + " quadros: OK (" + bytes.length + " bytes, " + pal.colors.length + " cores)");

// ---- LZW com muitos códigos (força o reset da tabela em 4096) ----

(function () {
    var bw = 300, bh = 200, rgba = new Uint8Array(bw * bh * 4), seed = 3;
    for (var i = 0; i < bw * bh; i++) {
        seed = (seed * 16807) % 2147483647;
        rgba[i * 4] = seed & 255; rgba[i * 4 + 1] = (seed >> 8) & 255; rgba[i * 4 + 2] = (seed >> 16) & 255; rgba[i * 4 + 3] = 255;
    }
    var p2 = new G.Palette(); p2.addPixels(rgba, 1); p2.build(G.MAX_COLORS);
    var e2 = new G.GifEncoder(bw, bh, { loop: false });
    e2.setPalette(p2); e2.addFrame(rgba, 10);
    var b2 = e2.finish();
    var d2 = decodeGif(b2);
    assert.ok(!d2.loop, "sem loop quando pedido");
    var exp = p2.index(rgba, new Uint8Array(bw * bh));
    for (var k = 0; k < bw * bh; k++) {
        var c = p2.colors[exp[k]];
        if (d2.frames[0].rgb[k * 3] !== c[0] || d2.frames[0].rgb[k * 3 + 2] !== c[2]) assert.fail("ruído: pixel " + k + " difere");
    }
    console.log("LZW com reset de tabela: OK (" + b2.length + " bytes)");
})();

// Grava uma cópia para inspeção manual (ex.: abrir num navegador).
var outPath = path.join(os.tmpdir(), "autophysics-gif-test.gif");
fs.writeFileSync(outPath, Buffer.from(bytes));
assert.strictEqual(G.bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), "base64 confere com o do Node");
console.log("\ngif.test.js: todos os testes passaram (" + outPath + ")");
