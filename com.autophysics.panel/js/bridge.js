// AutoPhysics — tradução entre o que o host.jsx devolve (texto, coordenadas
// do documento com y para CIMA) e o que o motor de física usa (coordenadas
// locais da prancheta, em pt, com y para BAIXO), e de volta.
//
// Tudo aqui é lógica pura, sem DOM nem CEP, para poder ser testado no Node
// (test/autophysics/bridge.test.js).

(function (root) {
    "use strict";

    var Physics = root.AutoPhysics || (typeof require === "function" ? require("./physics.js") : null);

    var DEFAULT_PROPS = { e: 0.3, w: 1, o: 0 };

    // ===== Propriedades por objeto (Tag "AutoPhysics": "e=0.3;w=1;o=0") =====

    function parseProps(str) {
        var p = { e: DEFAULT_PROPS.e, w: DEFAULT_PROPS.w, o: DEFAULT_PROPS.o };
        String(str || "").split(";").forEach(function (kv) {
            var m = /^\s*([ewo])\s*=\s*(-?[\d.]+)\s*$/.exec(kv);
            if (m) p[m[1]] = parseFloat(m[2]);
        });
        p.e = Math.max(0, Math.min(1, p.e));
        p.w = Math.max(0.1, Math.min(10, p.w));
        p.o = Math.max(-100, Math.min(100, p.o));
        return p;
    }

    function formatProps(p) {
        return "e=" + round(p.e, 3) + ";w=" + round(p.w, 3) + ";o=" + round(p.o, 3);
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
            desc.items.push({
                uuid: f[0],
                name: f[1],
                typename: f[2],
                stroke: parseFloat(f[3]) || 0,
                color: f[4].split(",").map(function (v) { return parseInt(v, 10); }),
                bounds: f[5].split(",").map(parseFloat),
                props: f[6],
                paths: f[7] ? f[7].split(";").map(parsePath) : []
            });
        }
        return desc;
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
            scene.items.push({ shape: shape, restitution: p.e, weight: p.w, offset: p.o + it.stroke });
            meta.push({ uuid: it.uuid, bounds: it.bounds, color: it.color, props: p });
        });
        return { scene: scene, meta: meta, skipped: skipped, frame: fr };
    }

    function shapeCenter(shape) {
        if (shape.kind === "circle") return { x: shape.cx, y: shape.cy };
        var sx = 0, sy = 0;
        shape.verts.forEach(function (v) { sx += v.x; sy += v.y; });
        return { x: sx / shape.verts.length, y: sy / shape.verts.length };
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
