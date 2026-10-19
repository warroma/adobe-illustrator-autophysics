// AutoPhysics — encoder de GIF animado (GIF89a), sem dependências.
//
// O painel compõe cada quadro num canvas (fundo + um "sprite" PNG por objeto,
// exportados uma vez pelo Illustrator) e entrega os pixels RGBA aqui.
//
//   1. Paleta: GIF tem no máximo 256 cores. Como a animação só MOVE as mesmas
//      artes, uma paleta global serve para todos os quadros: corte pela mediana
//      ("median cut") sobre o histograma de alguns quadros de amostra, com 255
//      cores + 1 índice reservado para "transparente".
//   2. Cada pixel vira o índice da cor mais próxima (tabela de 32.768 entradas,
//      5 bits por canal, calculada uma vez).
//   3. Quadros incrementais: do 2º em diante só vai o retângulo que mudou, e
//      dentro dele os pixels iguais ao quadro anterior viram "transparente"
//      (disposal 1 = deixa o anterior por baixo). Quadros idênticos não são
//      gravados — só somam a duração ao anterior (ex.: o fim parado).
//   4. Compressão LZW de código variável (até 12 bits), em sub-blocos de 255
//      bytes, como manda a especificação.
//
// Funciona como script comum no painel (window.AutoPhysicsGif) e no Node.

(function (root) {
    "use strict";

    var TRANSPARENT = 255;

    // ===== Paleta (median cut) =====

    // Histograma em 5 bits por canal, mas guardando também a soma das cores
    // reais de cada caixinha — assim uma cor chapada sai exata na paleta, e
    // não arredondada para o múltiplo de 8 mais próximo.
    function Palette() {
        this.hist = new Float64Array(32768);
        this.sum = new Float64Array(32768 * 3);
    }

    // Soma os pixels de um RGBA ao histograma (amostrando a cada "step").
    Palette.prototype.addPixels = function (rgba, step) {
        var h = this.hist, sum = this.sum;
        step = step || 1;
        for (var i = 0; i < rgba.length; i += 4 * step) {
            var k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
            h[k]++;
            sum[k * 3] += rgba[i]; sum[k * 3 + 1] += rgba[i + 1]; sum[k * 3 + 2] += rgba[i + 2];
        }
    };

    Palette.prototype.build = function (maxColors) {
        var h = this.hist, colors = [], i;
        for (i = 0; i < 32768; i++) {
            if (h[i] > 0) {
                colors.push({
                    r: (i >> 10) & 31, g: (i >> 5) & 31, b: i & 31, n: h[i],
                    sr: this.sum[i * 3], sg: this.sum[i * 3 + 1], sb: this.sum[i * 3 + 2]
                });
            }
        }
        var boxes = [makeBox(colors)];
        while (boxes.length < maxColors) {
            // Divide a caixa com mais pixels x maior extensão.
            var best = -1, bestScore = 0;
            for (i = 0; i < boxes.length; i++) {
                var bx = boxes[i];
                if (bx.colors.length < 2) continue;
                var score = bx.count * bx.range;
                if (score > bestScore) { bestScore = score; best = i; }
            }
            if (best < 0) break;
            var split = splitBox(boxes[best]);
            boxes.splice(best, 1, split[0], split[1]);
        }
        var rgb = [];
        for (i = 0; i < boxes.length; i++) rgb.push(boxAverage(boxes[i]));
        if (rgb.length === 0) rgb.push([255, 255, 255]);
        this.colors = rgb;

        // Tabela cor de 15 bits -> índice mais próximo.
        var lut = new Uint8Array(32768);
        for (i = 0; i < 32768; i++) {
            var r = ((i >> 10) & 31) * 8 + 4, g = ((i >> 5) & 31) * 8 + 4, b = (i & 31) * 8 + 4;
            var bi = 0, bd = Infinity;
            for (var k = 0; k < rgb.length; k++) {
                var dr = r - rgb[k][0], dg = g - rgb[k][1], db = b - rgb[k][2];
                var d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; // pesos perceptuais aproximados
                if (d < bd) { bd = d; bi = k; }
            }
            lut[i] = bi;
        }
        this.lut = lut;
        return this;
    };

    Palette.prototype.index = function (rgba, out) {
        var lut = this.lut;
        for (var i = 0, j = 0; j < out.length; i += 4, j++) {
            out[j] = lut[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
        }
        return out;
    };

    function makeBox(colors) {
        var box = { colors: colors, count: 0, range: 0, ch: 0 };
        var min = [31, 31, 31], max = [0, 0, 0];
        for (var i = 0; i < colors.length; i++) {
            var c = colors[i];
            box.count += c.n;
            if (c.r < min[0]) min[0] = c.r; if (c.r > max[0]) max[0] = c.r;
            if (c.g < min[1]) min[1] = c.g; if (c.g > max[1]) max[1] = c.g;
            if (c.b < min[2]) min[2] = c.b; if (c.b > max[2]) max[2] = c.b;
        }
        var ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        box.ch = ranges[1] >= ranges[0] && ranges[1] >= ranges[2] ? 1 : (ranges[0] >= ranges[2] ? 0 : 2);
        box.range = ranges[box.ch] + 1;
        return box;
    }

    function splitBox(box) {
        var key = ["r", "g", "b"][box.ch];
        var cs = box.colors.slice().sort(function (a, b) { return a[key] - b[key]; });
        var half = box.count / 2, acc = 0, cut = 1;
        for (var i = 0; i < cs.length - 1; i++) {
            acc += cs[i].n;
            if (acc >= half) { cut = i + 1; break; }
            cut = i + 1;
        }
        return [makeBox(cs.slice(0, cut)), makeBox(cs.slice(cut))];
    }

    function boxAverage(box) {
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < box.colors.length; i++) {
            var c = box.colors[i];
            r += c.sr; g += c.sg; b += c.sb; n += c.n;
        }
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }

    // ===== Saída em bytes =====

    function ByteWriter() {
        this.buf = new Uint8Array(1 << 16);
        this.len = 0;
    }
    ByteWriter.prototype.ensure = function (n) {
        if (this.len + n <= this.buf.length) return;
        var size = this.buf.length;
        while (size < this.len + n) size *= 2;
        var nb = new Uint8Array(size);
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
    };
    ByteWriter.prototype.byte = function (b) { this.ensure(1); this.buf[this.len++] = b & 255; };
    ByteWriter.prototype.u16 = function (v) { this.byte(v & 255); this.byte((v >> 8) & 255); };
    ByteWriter.prototype.bytes = function (arr) {
        this.ensure(arr.length);
        for (var i = 0; i < arr.length; i++) this.buf[this.len++] = arr[i];
    };
    ByteWriter.prototype.ascii = function (s) {
        for (var i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
    };
    ByteWriter.prototype.result = function () { return this.buf.subarray(0, this.len); };

    // ===== LZW (como o omggif / especificação GIF89a, apêndice F) =====

    var dictCode = new Int32Array(4096 * 256);
    var dictGen = new Int32Array(4096 * 256);
    var generation = 0;

    function writeLZW(out, minCodeSize, indices) {
        out.byte(minCodeSize);
        var clearCode = 1 << minCodeSize, eoi = clearCode + 1;
        var nextCode = eoi + 1, codeSize = minCodeSize + 1;
        var cur = 0, curBits = 0;
        var block = new Uint8Array(255), blockLen = 0;

        function flushBlock() {
            if (blockLen === 0) return;
            out.byte(blockLen);
            out.bytes(block.subarray(0, blockLen));
            blockLen = 0;
        }
        function emit(code) {
            cur |= code << curBits;
            curBits += codeSize;
            while (curBits >= 8) {
                block[blockLen++] = cur & 255;
                if (blockLen === 255) flushBlock();
                cur >>>= 8;
                curBits -= 8;
            }
        }

        generation++;
        emit(clearCode);
        var prefix = indices[0];
        for (var i = 1; i < indices.length; i++) {
            var k = indices[i];
            var key = (prefix << 8) | k;
            if (dictGen[key] === generation) {
                prefix = dictCode[key];
                continue;
            }
            emit(prefix);
            if (nextCode === 4096) {
                emit(clearCode);
                generation++;
                nextCode = eoi + 1;
                codeSize = minCodeSize + 1;
            } else {
                if (nextCode >= (1 << codeSize)) codeSize++;
                dictGen[key] = generation;
                dictCode[key] = nextCode++;
            }
            prefix = k;
        }
        emit(prefix);
        emit(eoi);
        if (curBits > 0) {
            block[blockLen++] = cur & 255;
            if (blockLen === 255) flushBlock();
        }
        flushBlock();
        out.byte(0); // fim dos sub-blocos
    }

    // ===== Encoder =====
    //
    // var enc = new GifEncoder(w, h, { loop: true });
    // enc.setPalette(palette);          // Palette já com build()
    // enc.addFrame(rgba, delayCs);      // quantas vezes quiser
    // var bytes = enc.finish();         // Uint8Array

    function GifEncoder(width, height, opts) {
        this.width = width;
        this.height = height;
        this.loop = !opts || opts.loop !== false;
        this.prev = null;       // índices do quadro anterior (tela inteira)
        this.pending = null;    // quadro ainda não gravado (pode ganhar duração)
        this.out = new ByteWriter();
        this.cur = new Uint8Array(width * height);
        this.started = false;
    }

    GifEncoder.prototype.setPalette = function (palette) {
        this.palette = palette;
    };

    GifEncoder.prototype.writeHeader = function () {
        var o = this.out;
        o.ascii("GIF89a");
        o.u16(this.width); o.u16(this.height);
        o.byte(0xF7);  // tabela global, 8 bits de cor, 256 entradas
        o.byte(0);     // cor de fundo
        o.byte(0);     // proporção de pixel
        var cols = this.palette.colors;
        for (var i = 0; i < 256; i++) {
            var c = cols[i] || [0, 0, 0];
            o.byte(c[0]); o.byte(c[1]); o.byte(c[2]);
        }
        if (this.loop) {
            o.byte(0x21); o.byte(0xFF); o.byte(11);
            o.ascii("NETSCAPE2.0");
            o.byte(3); o.byte(1); o.u16(0); o.byte(0); // 0 = repetir para sempre
        }
        this.started = true;
    };

    // delay em centésimos de segundo (o GIF só guarda isso).
    GifEncoder.prototype.addFrame = function (rgba, delayCs) {
        if (!this.started) this.writeHeader();
        var w = this.width, h = this.height;
        var cur = this.palette.index(rgba, this.cur);

        if (!this.prev) {
            this.pending = { x: 0, y: 0, w: w, h: h, data: cur.slice(), delay: delayCs, transparent: false };
            this.prev = cur.slice();
            return;
        }

        // Retângulo do que mudou.
        var prev = this.prev, minX = w, minY = h, maxX = -1, maxY = -1, x, y, i;
        for (y = 0; y < h; y++) {
            var row = y * w;
            for (x = 0; x < w; x++) {
                if (cur[row + x] !== prev[row + x]) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) {
            this.pending.delay += delayCs; // idêntico: só estende o anterior
            return;
        }
        this.flushPending();
        var fw = maxX - minX + 1, fh = maxY - minY + 1;
        var data = new Uint8Array(fw * fh);
        for (y = 0; y < fh; y++) {
            var src = (minY + y) * w + minX;
            for (x = 0; x < fw; x++) {
                i = src + x;
                data[y * fw + x] = cur[i] === prev[i] ? TRANSPARENT : cur[i];
                prev[i] = cur[i];
            }
        }
        this.pending = { x: minX, y: minY, w: fw, h: fh, data: data, delay: delayCs, transparent: true };
    };

    GifEncoder.prototype.flushPending = function () {
        var f = this.pending;
        if (!f) return;
        var o = this.out;
        // Graphic Control Extension
        o.byte(0x21); o.byte(0xF9); o.byte(4);
        o.byte((1 << 2) | (f.transparent ? 1 : 0)); // disposal 1 (manter) + flag de transparência
        o.u16(Math.max(2, Math.min(65535, Math.round(f.delay))));
        o.byte(TRANSPARENT);
        o.byte(0);
        // Image Descriptor (sem tabela local)
        o.byte(0x2C);
        o.u16(f.x); o.u16(f.y); o.u16(f.w); o.u16(f.h);
        o.byte(0);
        writeLZW(o, 8, f.data);
        this.pending = null;
    };

    GifEncoder.prototype.finish = function () {
        this.flushPending();
        this.out.byte(0x3B);
        return this.out.result();
    };

    // 255 cores úteis: o índice 255 é o "transparente" dos quadros incrementais.
    var MAX_COLORS = 255;

    function bytesToBase64(bytes) {
        var chunks = [], CH = 0x8000;
        for (var i = 0; i < bytes.length; i += CH) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
        }
        var bin = chunks.join("");
        if (typeof btoa === "function") return btoa(bin);
        return Buffer.from(bin, "binary").toString("base64");
    }

    var api = { Palette: Palette, GifEncoder: GifEncoder, MAX_COLORS: MAX_COLORS, bytesToBase64: bytesToBase64 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.AutoPhysicsGif = api;
})(this);
