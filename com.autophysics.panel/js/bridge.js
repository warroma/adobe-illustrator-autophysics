// AutoPhysics — tradução entre o que o host.jsx devolve (texto, coordenadas
// do documento com y para CIMA) e o que o motor de física usa (coordenadas
// locais da prancheta, em pt, com y para BAIXO), e de volta.
//
// Tudo aqui é lógica pura, sem DOM nem CEP, para poder ser testado no Node
// (test/autophysics/bridge.test.js).

(function (root) {
    "use strict";

    var Physics = root.AutoPhysics || (typeof require === "function" ? require("./physics.js") : null);

    // a = colidir pela aparência (efeitos 3D, sombra...): -1 automático, 0 não, 1 sim.
    var DEFAULT_PROPS = { e: 0.3, w: 1, o: 0, a: -1 };

    // ===== Propriedades por objeto (Tag "AutoPhysics": "e=0.3;w=1;o=0;a=1") =====

    function parseProps(str) {
        var p = { e: DEFAULT_PROPS.e, w: DEFAULT_PROPS.w, o: DEFAULT_PROPS.o, a: DEFAULT_PROPS.a };
        String(str || "").split(";").forEach(function (kv) {
            var m = /^\s*([ewoa])\s*=\s*(-?[\d.]+)\s*$/.exec(kv);
            if (m) p[m[1]] = parseFloat(m[2]);
        });
        p.e = Math.max(0, Math.min(1, p.e));
        p.w = Math.max(0.1, Math.min(10, p.w));
        p.o = Math.max(-100, Math.min(100, p.o));
        p.a = p.a === 0 || p.a === 1 ? p.a : -1;
        return p;
    }

    function formatProps(p) {
        var out = "e=" + round(p.e, 3) + ";w=" + round(p.w, 3) + ";o=" + round(p.o, 3);
        return p.a === 0 || p.a === 1 ? out + ";a=" + p.a : out;
    }

    function round(v, d) {
        var k = Math.pow(10, d);
        return Math.round(v * k) / k;
    }

    // ===== Coordenadas =====
    //
    // abRect = [left, top, right, bottom] como o Illustrator dá. Mapeamento
    // linear de "top" para y = 0 e "bottom" para y = altura: funciona tanto
    // com y para cima (o normal no scripting) quanto se vier invertido.

    function frame(abRect) {
        var l = abRect[0], t = abRect[1], r = abRect[2], b = abRect[3];
        var w = Math.abs(r - l), h = Math.abs(b - t);
        var sx = r >= l ? 1 : -1, sy = b >= t ? 1 : -1;
        return {
            width: w,
            height: h,
            toLocalX: function (x) { return (x - l) * sx; },
            toLocalY: function (y) { return (y - t) * sy; },
            toDocX: function (x) { return l + x * sx; },
            toDocY: function (y) { return t + y * sy; },
            // Ângulo local (radianos, positivo = horário na tela, já que o y
            // local cresce para baixo) -> graus do rotate() do Illustrator
            // (positivo = anti-horário na tela).
            toDocDeg: function (a) { return -a * 180 / Math.PI; }
        };
    }

    // ===== Leitura do describe() do host =====

    function parseDescription(text) {
        text = String(text || "");
        if (text.indexOf("ERRO") === 0) return { error: text };
        var lines = text.split("\n");
        var head = lines[0].split("|");
        if (head[0] !== "OK") return { error: "ERRO: resposta inesperada do Illustrator: " + text.slice(0, 120) };
        var desc = {
            abIndex: parseInt(head[1], 10),
            abName: head[2],
            abRect: head[3].split(",").map(parseFloat),
            items: []
        };
        for (var i = 1; i < lines.length; i++) {
            if (!lines[i]) continue;
            var f = lines[i].split("|");
            var it = {
                uuid: f[0],
                name: f[1],
                typename: f[2],
                stroke: parseFloat(f[3]) || 0,
                color: f[4].split(",").map(function (v) { return parseInt(v, 10); }),
                bounds: parseBox(f[5]),
                visibleBounds: parseBox(f[6]),
                props: f[7],
                paths: f[8] ? f[8].split(";").map(parsePath) : []
            };
            it.effect = effectOf(desc.abRect, it);
            desc.items.push(it);
        }
        return desc;
    }

    function parseBox(str) {
        var v = String(str || "").split(",").map(parseFloat);
        return v.length === 4 && v.every(isFinite) ? v : null;
    }

    // Quanto a aparência (limites visíveis) passa do desenho (limites
    // geométricos + meio traço), em coordenadas locais. Uma extrusão 3D cresce
    // para UM lado: vira o deslocamento (dx, dy) da "face de trás"; o que
    // cresce por igual dos quatro lados (desfoque, brilho) vira "sym".
    // active = a aparência é visivelmente maior que o desenho.
    function effectOf(abRect, it) {
        var none = { active: false, dx: 0, dy: 0, sym: 0 };
        if (!it.bounds || !it.visibleBounds) return none;
        var fr = frame(abRect);
        function box(b) {
            var xa = fr.toLocalX(b[0]), xb = fr.toLocalX(b[2]), ya = fr.toLocalY(b[1]), yb = fr.toLocalY(b[3]);
            return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) };
        }
        var g = box(it.bounds), v = box(it.visibleBounds), st = it.stroke || 0;
        var gl = Math.max(0, g.x0 - v.x0 - st), gr = Math.max(0, v.x1 - g.x1 - st);
        var gt = Math.max(0, g.y0 - v.y0 - st), gb = Math.max(0, v.y1 - g.y1 - st);
        var size = Math.max(g.x1 - g.x0, g.y1 - g.y0, 1);
        var grow = Math.max(gl, gr, gt, gb);
        return {
            active: grow > Math.max(1, 0.02 * size),
            dx: gr - gl, dy: gb - gt,
            sym: Math.min(gl, gr, gt, gb)
        };
    }

    function useAppearance(p, effect) {
        return p.a === 1 || (p.a === -1 && effect && effect.active);
    }

    // Colisão pela aparência: cada peça convexa é "varrida" pelo deslocamento
    // da extrusão (casca da peça + a mesma peça deslocada) — exatamente o
    // volume de uma extrusão reta —, e o crescimento por igual entra como
    // offset. Um círculo vira polígono antes de varrer.
    function sweepShape(shape, effect) {
        if (Math.abs(effect.dx) < 0.5 && Math.abs(effect.dy) < 0.5) return shape;
        var parts = shape.kind === "circle" ? [circlePolygon(shape, 24)] : shape.parts;
        var hull = Physics._internal.convexHull;
        return {
            kind: "parts",
            parts: parts.map(function (pt) {
                return hull(pt.concat(pt.map(function (v) { return { x: v.x + effect.dx, y: v.y + effect.dy }; })));
            })
        };
    }

    function circlePolygon(c, n) {
        var out = [];
        for (var k = 0; k < n; k++) out.push({ x: c.cx + c.r * Math.cos(2 * Math.PI * k / n), y: c.cy + c.r * Math.sin(2 * Math.PI * k / n) });
        return out;
    }

    function parsePath(s) {
        return { closed: s.charAt(0) === "c", pts: s.slice(2) ? s.slice(2).split(",").map(parseFloat) : [] };
    }

    // ===== Cena para o motor =====
    //
    // propsByUuid[uuid] = { e, w, o } (o em pt). O meio traço do objeto entra
    // no offset: a colisão é pela borda VISÍVEL, não pelo caminho geométrico.
    // Objetos com o centro fora da largura da prancheta, ou abaixo do chão,
    // ficam de fora (não há onde caírem).

    function buildScene(desc, propsByUuid) {
        var fr = frame(desc.abRect);
        var scene = { width: fr.width, height: fr.height, items: [] };
        var meta = [], skipped = [];
        desc.items.forEach(function (it) {
            var local = it.paths.map(function (p) {
                var pts = [];
                for (var k = 0; k + 1 < p.pts.length; k += 2) pts.push(fr.toLocalX(p.pts[k]), fr.toLocalY(p.pts[k + 1]));
                return { closed: p.closed, pts: pts };
            });
            var shape = Physics.shapeFromPaths(local);
            if (!shape) { skipped.push({ uuid: it.uuid, reason: "sem contorno" }); return; }
            var c = shapeCenter(shape);
            if (c.x < 0 || c.x > fr.width) { skipped.push({ uuid: it.uuid, reason: "fora da prancheta" }); return; }
            if (c.y > fr.height) { skipped.push({ uuid: it.uuid, reason: "abaixo da prancheta" }); return; }
            var p = propsByUuid[it.uuid] || parseProps(it.props);
            var offset = p.o + it.stroke;
            var appearance = useAppearance(p, it.effect);
            if (appearance) {
                shape = sweepShape(shape, it.effect);
                offset += it.effect.sym;
            }
            scene.items.push({ shape: shape, restitution: p.e, weight: p.w, offset: offset });
            meta.push({
                uuid: it.uuid, bounds: it.bounds, color: it.color, props: p, appearance: appearance,
                // Desenho de verdade (com miolos), para a prévia.
                art: Physics._internal.sampleSubpaths(local, 6)
            });
        });
        return { scene: scene, meta: meta, skipped: skipped, frame: fr };
    }

    function shapeCenter(shape) {
        if (shape.kind === "circle") return { x: shape.cx, y: shape.cy };
        var sx = 0, sy = 0, n = 0;
        shape.parts.forEach(function (pt) { pt.forEach(function (v) { sx += v.x; sy += v.y; n++; }); });
        return { x: sx / n, y: sy / n };
    }

    // ===== Estado final -> chamada do host =====
    //
    // "uuid|cx0,cy0|cx1,cy1|graus|props" por objeto (ver AutoPhysics_apply).

    function buildApplySpec(sim, frameIndex) {
        var fr = sim.frame, res = sim.result, f = res.frames[frameIndex], lines = [];
        sim.meta.forEach(function (m, i) {
            var b = res.bodies[i];
            lines.push([
                m.uuid,
                round(fr.toDocX(b.x), 4) + "," + round(fr.toDocY(b.y), 4),
                round(fr.toDocX(f[i * 3]), 4) + "," + round(fr.toDocY(f[i * 3 + 1]), 4),
                round(fr.toDocDeg(f[i * 3 + 2]), 5),
                formatProps(m.props)
            ].join("|"));
        });
        return lines.join("\n");
    }

    // "OK|uuid,l,t,r,b;..." -> { uuid: [l,t,r,b] }
    function parseBounds(text) {
        text = String(text || "");
        if (text.indexOf("OK|") !== 0) return null;
        var map = {};
        text.slice(3).split(";").forEach(function (entry) {
            if (!entry) return;
            var f = entry.split(",");
            map[f[0]] = f.slice(1).map(parseFloat);
        });
        return map;
    }

    function boundsMatch(a, b, tol) {
        if (!a || !b) return false;
        for (var i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
        return true;
    }

    // Em que pose o documento está: "start", "final" ou null (mexeram).
    function detectPose(sim, current) {
        var tol = 0.05;
        var atStart = true, atFinal = !!sim.finalBounds;
        sim.meta.forEach(function (m) {
            var cur = current[m.uuid];
            if (!boundsMatch(cur, m.bounds, tol)) atStart = false;
            if (sim.finalBounds && !boundsMatch(cur, sim.finalBounds[m.uuid], tol)) atFinal = false;
        });
        return atStart ? "start" : (atFinal ? "final" : null);
    }

    // ===== Sprites do GIF =====

    // "OK|pasta|fundo\narquivo|l,t,r,b\n..." do AutoPhysics_exportSprites.
    function parseSprites(text) {
        text = String(text || "");
        if (text.indexOf("OK|") !== 0) return { error: text || "ERRO: sem resposta do Illustrator." };
        var lines = text.split("\n"), head = lines[0].split("|");
        var out = { folder: head[1], background: head[2] || "", sprites: [] };
        for (var i = 1; i < lines.length; i++) {
            if (!lines[i]) continue;
            var f = lines[i].split("|");
            out.sprites.push({ path: f[0], rect: f[1].split(",").map(parseFloat) });
        }
        return out;
    }

    // Retângulo do sprite em coordenadas locais + a pose (centroide e ângulo)
    // do objeto no momento em que o PNG foi exportado. Para desenhar o quadro
    // k: transladar para o centroide do quadro, girar (a_k - ângulo do sprite)
    // e desenhar o PNG deslocado de (x - cx, y - cy).
    function spriteLocal(sim, i, rect, pose) {
        var fr = sim.frame, res = sim.result;
        var xA = fr.toLocalX(rect[0]), xB = fr.toLocalX(rect[2]);
        var yA = fr.toLocalY(rect[1]), yB = fr.toLocalY(rect[3]);
        var f = pose === "final" ? res.frames[res.frames.length - 1] : null;
        return {
            x: Math.min(xA, xB), y: Math.min(yA, yB),
            w: Math.abs(xB - xA), h: Math.abs(yB - yA),
            cx: f ? f[i * 3] : res.bodies[i].x,
            cy: f ? f[i * 3 + 1] : res.bodies[i].y,
            angle: f ? f[i * 3 + 2] : 0
        };
    }

    // Índice do quadro gravado (100 Hz) para o quadro k do GIF.
    function gifFrameSchedule(duration, hz, fps, speed) {
        var delayCs = Math.round(100 / fps);
        var step = delayCs / 100 * speed; // segundos de simulação por quadro do GIF
        var total = Math.max(1, Math.floor(duration / step + 1e-9) + 1);
        var idx = [];
        for (var k = 0; k < total; k++) idx.push(Math.min(Math.round(k * step * hz), Math.round(duration * hz)));
        if (idx[idx.length - 1] !== Math.round(duration * hz)) idx.push(Math.round(duration * hz));
        return { delayCs: delayCs, indices: idx };
    }

    var api = {
        DEFAULT_PROPS: DEFAULT_PROPS,
        parseProps: parseProps,
        formatProps: formatProps,
        frame: frame,
        parseDescription: parseDescription,
        effectOf: effectOf,
        useAppearance: useAppearance,
        buildScene: buildScene,
        buildApplySpec: buildApplySpec,
        parseBounds: parseBounds,
        boundsMatch: boundsMatch,
        detectPose: detectPose,
        parseSprites: parseSprites,
        spriteLocal: spriteLocal,
        gifFrameSchedule: gifFrameSchedule
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.AutoPhysicsBridge = api;
})(this);
