"use strict";

// Testes do motor de física do AutoPhysics (com.autophysics.panel/js/physics.js).
// Rodar: node test/autophysics/physics.test.js

var assert = require("assert");
var P = require("../com.autophysics.panel/js/physics.js");
var I = P._internal;

// ---- helpers ----

function rectPaths(x, y, w, h) {
    // Retângulo como o host.jsx devolve: âncoras com alças coincidentes.
    var pts = [];
    [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach(function (p) {
        pts.push(p[0], p[1], p[0], p[1], p[0], p[1]);
    });
    return [{ closed: true, pts: pts }];
}

function circlePaths(cx, cy, r) {
    // Círculo bezier de 4 pontos, igual ao do Illustrator.
    var k = 0.5522847498 * r, pts = [];
    [[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(function (d) {
        var ax = cx + d[0] * r, ay = cy + d[1] * r;
        var tx = -d[1], ty = d[0]; // tangente
        pts.push(ax, ay, ax - tx * k, ay - ty * k, ax + tx * k, ay + ty * k);
    });
    return [{ closed: true, pts: pts }];
}

function item(paths, opts) {
    opts = opts || {};
    return {
        shape: P.shapeFromPaths(paths),
        restitution: opts.restitution || 0,
        weight: opts.weight || 1,
        offset: opts.offset || 0
    };
}

// Polígono (pt) do corpo i no quadro f, já com rotação/translação.
function worldPoly(res, i, f) {
    var fr = res.frames[f], x = fr[i * 3], y = fr[i * 3 + 1], a = fr[i * 3 + 2];
    var c = Math.cos(a), s = Math.sin(a), o = res.bodies[i].outline;
    return o.verts.map(function (v) { return { x: c * v.x - s * v.y + x, y: s * v.x + c * v.y + y }; });
}

// Penetração (pt) entre dois polígonos convexos pelo SAT; <= 0 = separados.
function penetration(A, B) {
    var minOverlap = Infinity;
    [A, B].forEach(function (poly) {
        for (var i = 0; i < poly.length; i++) {
            var p = poly[i], q = poly[(i + 1) % poly.length];
            var nx = q.y - p.y, ny = -(q.x - p.x), l = Math.sqrt(nx * nx + ny * ny);
            nx /= l; ny /= l;
            var a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
            A.forEach(function (v) { var d = v.x * nx + v.y * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); });
            B.forEach(function (v) { var d = v.x * nx + v.y * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); });
            minOverlap = Math.min(minOverlap, Math.min(a1, b1) - Math.max(a0, b0));
        }
    });
    return minOverlap;
}

function last(res) { return res.frames.length - 1; }

function bottomOf(poly) { return Math.max.apply(null, poly.map(function (v) { return v.y; })); }
function topOf(poly) { return Math.min.apply(null, poly.map(function (v) { return v.y; })); }

var WALLS = { floor: true, left: true, right: true, ceiling: false };

// ---- geometria ----

(function () {
    var hull = I.convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }, { x: 5, y: 0 }]);
    assert.strictEqual(hull.length, 4, "envoltória de um quadrado com pontos internos/colineares tem 4 vértices");
    assert.ok(I.polygonArea(hull) > 0, "envoltória anti-horária (área positiva)");

    var circ = P.shapeFromPaths(circlePaths(50, 60, 20));
    assert.strictEqual(circ.kind, "circle", "círculo bezier detectado como círculo");
    assert.ok(Math.abs(circ.cx - 50) < 0.01 && Math.abs(circ.cy - 60) < 0.01, "centro do círculo");
    assert.ok(Math.abs(circ.r - 20) < 0.1, "raio do círculo: " + circ.r);

    var rect = P.shapeFromPaths(rectPaths(0, 0, 40, 20));
    assert.strictEqual(rect.kind, "polygon");
    assert.strictEqual(rect.verts.length, 4);
    assert.ok(Math.abs(I.polygonArea(rect.verts) - 800) < 1e-6);

    var md = I.polygonMassData(rect.verts);
    assert.ok(Math.abs(md.cx - 20) < 1e-9 && Math.abs(md.cy - 10) < 1e-9, "centroide do retângulo");
    // Inércia de retângulo (densidade 1): A·(w²+h²)/12
    assert.ok(Math.abs(md.I - 800 * (1600 + 400) / 12) < 1e-6, "inércia do retângulo: " + md.I);

    var inset = I.insetConvex(rect.verts, 5);
    assert.ok(Math.abs(I.polygonArea(inset.verts) - 30 * 10) < 1e-6, "inset de 5 num 40x20 vira 30x10");

    // Linha reta (área zero) ainda vira uma forma com área.
    var line = P.shapeFromPaths([{ closed: false, pts: [0, 0, 0, 0, 0, 0, 100, 0, 100, 0, 100, 0] }]);
    assert.strictEqual(line.kind, "polygon");
    assert.ok(I.polygonArea(line.verts) > 0, "linha vira retângulo fino");

    // Elipse (não círculo) vira polígono com no máximo 24 vértices.
    var ell = P.shapeFromPaths([{ closed: true, pts: (function () {
        var k = 0.5522847498, pts = [];
        [[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(function (d) {
            var ax = d[0] * 40, ay = d[1] * 20, tx = -d[1] * 40 * k, ty = d[0] * 20 * k;
            pts.push(ax, ay, ax - tx, ay - ty, ax + tx, ay + ty);
        });
        return pts;
    })() }]);
    assert.strictEqual(ell.kind, "polygon", "elipse não é círculo");
    assert.ok(ell.verts.length <= 24 && ell.verts.length >= 12, "elipse simplificada: " + ell.verts.length);
    console.log("geometria: OK");
})();

// ---- colisão: manifold de caixa sobre caixa ----

(function () {
    var box = I.makePolygon([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], 0);
    var m = I.collidePolygons(box, I.makeXf(0, 0, 0), box, I.makeXf(0.5, 1.9, 0));
    assert.strictEqual(m.pointCount, 2, "caixa apoiada gera 2 pontos de contato");
    var none = I.collidePolygons(box, I.makeXf(0, 0, 0), box, I.makeXf(0, 2.5, 0));
    assert.strictEqual(none.pointCount, 0, "caixas separadas não colidem");
    var c = I.makeCircle(1);
    assert.strictEqual(I.collidePolygonAndCircle(box, I.makeXf(0, 0, 0), c, I.makeXf(0, 1.9, 0)).pointCount, 1);
    assert.strictEqual(I.collideCircles(c, I.makeXf(0, 0, 0), c, I.makeXf(1.9, 0, 0)).pointCount, 1);
    assert.strictEqual(I.collideCircles(c, I.makeXf(0, 0, 0), c, I.makeXf(2.1, 0, 0)).pointCount, 0);
    console.log("manifolds: OK");
})();

// ---- pilha de caixas assenta sem afundar ----

(function () {
    var items = [];
    for (var k = 0; k < 6; k++) items.push(item(rectPaths(175 + (k % 2) * 4, 40 + k * 55, 50, 50)));
    var res = P.simulate({ width: 400, height: 400, items: items }, { gravity: 1, air: 0, friction: 0.6, maxSeconds: 10, walls: WALLS });
    assert.ok(res.settled, "pilha assenta antes do tempo máximo (durou " + res.duration + " s)");
    var f = last(res), worst = 0;
    for (var i = 0; i < items.length; i++) {
        var A = worldPoly(res, i, f);
        assert.ok(bottomOf(A) <= 400.5, "caixa " + i + " não afunda no chão: " + bottomOf(A));
        for (var j = i + 1; j < items.length; j++) worst = Math.max(worst, penetration(A, worldPoly(res, j, f)));
    }
    assert.ok(worst < 0.5, "penetração máxima entre caixas < 0,5 pt (foi " + worst.toFixed(3) + ")");
    // As 6 caixas de 50 pt empilhadas: o topo da pilha fica a ~300 pt do chão.
    var tops = items.map(function (_, i) { return topOf(worldPoly(res, i, f)); });
    var highest = Math.min.apply(null, tops);
    assert.ok(Math.abs(highest - 100) < 3, "pilha de 6 x 50 pt fica em pé (topo em y=" + highest.toFixed(2) + ")");
    console.log("pilha de caixas: OK (assentou em " + res.duration.toFixed(2) + " s, penetração " + worst.toFixed(3) + " pt)");
})();

// ---- restituição: altura do quique ≈ e² da altura da queda ----

(function () {
    [0.5, 0.8].forEach(function (e) {
        var res = P.simulate({ width: 400, height: 400, items: [item(circlePaths(200, 120, 20), { restitution: e })] },
            { gravity: 1, air: 0, friction: 0.5, maxSeconds: 4, walls: WALLS });
        var drop = (400 - 20) - 120; // centro até o ponto de apoio
        // Impacto = primeiro máximo local de y (y cresce para baixo); ápice do
        // quique = o mínimo local seguinte.
        var ys = res.frames.map(function (fr) { return fr[1]; });
        var f = 1;
        while (f < ys.length - 1 && !(ys[f] >= ys[f - 1] && ys[f] > ys[f + 1])) f++;
        while (f < ys.length - 1 && !(ys[f] <= ys[f - 1] && ys[f] < ys[f + 1])) f++;
        var apex = ys[f];
        var ratio = ((400 - 20) - apex) / drop;
        assert.ok(Math.abs(ratio - e * e) < 0.06, "quique com e=" + e + ": razão " + ratio.toFixed(3) + " (esperado ~" + (e * e).toFixed(2) + ")");
        console.log("restituição e=" + e + ": OK (subiu " + (ratio * 100).toFixed(1) + "% da queda, esperado " + (e * e * 100).toFixed(0) + "%)");
    });
})();

// ---- massa: sem ar caem juntos (Galileu); com ar o mais pesado chega antes ----

(function () {
    function landing(air) {
        var res = P.simulate({
            width: 400, height: 400, items: [
                item(rectPaths(80, 20, 40, 40), { weight: 0.3 }),
                item(rectPaths(280, 20, 40, 40), { weight: 5 })
            ]
        }, { gravity: 1, air: air, friction: 0.5, maxSeconds: 6, walls: WALLS });
        var t = [-1, -1];
        for (var f = 0; f < res.frames.length; f++) {
            for (var i = 0; i < 2; i++) {
                if (t[i] < 0 && res.frames[f][i * 3 + 1] + 20 >= 399.5) t[i] = f / res.hz;
            }
        }
        return t;
    }
    var vac = landing(0);
    assert.ok(Math.abs(vac[0] - vac[1]) < 0.011, "no vácuo, leve e pesado chegam juntos: " + vac);
    var withAir = landing(0.6);
    assert.ok(withAir[1] < withAir[0] - 0.1, "com ar, o pesado chega antes: leve " + withAir[0] + " s, pesado " + withAir[1] + " s");
    console.log("massa x ar: OK (vácuo " + vac[0].toFixed(2) + "/" + vac[1].toFixed(2) + " s; ar 60% leve " + withAir[0].toFixed(2) + " s, pesado " + withAir[1].toFixed(2) + " s)");
})();

// ---- offset: positivo abre vão, negativo deixa sobrepor ----

(function () {
    function gap(offset) {
        var res = P.simulate({
            width: 300, height: 300, items: [
                item(rectPaths(125, 200, 50, 50), { offset: offset }),
                item(rectPaths(125, 100, 50, 50), { offset: offset })
            ]
        }, { gravity: 1, air: 0, friction: 0.6, maxSeconds: 6, walls: WALLS });
        // Distância entre os centros menos a altura da caixa (50): o vão (>0)
        // ou a sobreposição (<0) entre as artes de verdade.
        var f = last(res);
        return res.frames[f][1] - res.frames[f][4] - 50;
    }
    var g0 = gap(0), gPos = gap(8), gNeg = gap(-6);
    assert.ok(Math.abs(g0) < 0.5, "sem offset, caixas encostam: " + g0);
    assert.ok(Math.abs(gPos - 16) < 1, "offset +8 em cada uma abre ~16 pt: " + gPos);
    assert.ok(Math.abs(gNeg + 12) < 1, "offset -6 em cada uma sobrepõe ~12 pt: " + gNeg);
    console.log("offset: OK (0 -> " + g0.toFixed(2) + " pt, +8 -> " + gPos.toFixed(2) + " pt, -6 -> " + gNeg.toFixed(2) + " pt)");
})();

// ---- monte misto: nada explode, nada sai da caixa, nada vira NaN ----

(function () {
    var items = [], seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var k = 0; k < 40; k++) {
        var x = 40 + rnd() * 400, y = -300 + rnd() * 500, s = 18 + rnd() * 30;
        if (k % 3 === 0) items.push(item(circlePaths(x, y, s / 2), { restitution: rnd() * 0.7, weight: 0.5 + rnd() * 3 }));
        else if (k % 3 === 1) items.push(item(rectPaths(x, y, s, s * (0.5 + rnd())), { restitution: rnd() * 0.4, weight: 0.5 + rnd() * 3 }));
        else {
            // triângulo
            var pts = [];
            [[x, y + s], [x + s, y + s], [x + s / 2, y]].forEach(function (p) { pts.push(p[0], p[1], p[0], p[1], p[0], p[1]); });
            items.push(item([{ closed: true, pts: pts }], { restitution: 0.2 }));
        }
    }
    var t0 = Date.now();
    var res = P.simulate({ width: 480, height: 400, items: items }, { gravity: 1, air: 0.2, friction: 0.5, maxSeconds: 12, walls: WALLS });
    var ms = Date.now() - t0;
    var f = last(res);
    for (var i = 0; i < items.length; i++) {
        var fr = res.frames[f];
        assert.ok(isFinite(fr[i * 3]) && isFinite(fr[i * 3 + 1]) && isFinite(fr[i * 3 + 2]), "corpo " + i + " sem NaN");
        assert.ok(fr[i * 3] > 0 && fr[i * 3] < 480 && fr[i * 3 + 1] < 400, "corpo " + i + " dentro da prancheta");
        assert.ok(!res.out[i], "corpo " + i + " não escapou");
    }
    var worst = 0;
    for (i = 0; i < items.length; i++) {
        if (res.bodies[i].outline.kind !== "polygon") continue;
        for (var j = i + 1; j < items.length; j++) {
            if (res.bodies[j].outline.kind !== "polygon") continue;
            worst = Math.max(worst, penetration(worldPoly(res, i, f), worldPoly(res, j, f)));
        }
    }
    assert.ok(worst < 1.5, "penetração máxima no monte < 1,5 pt (foi " + worst.toFixed(3) + ")");
    console.log("monte de 40 formas: OK (" + res.duration.toFixed(2) + " s simulados em " + ms + " ms, assentou: " + res.settled + ", penetração " + worst.toFixed(3) + " pt)");
})();

// ---- sem chão: objetos saem e a simulação termina ----

(function () {
    var res = P.simulate({ width: 200, height: 200, items: [item(rectPaths(80, 20, 40, 40))] },
        { gravity: 1, air: 0, friction: 0.5, maxSeconds: 20, walls: { floor: false, left: true, right: true, ceiling: false } });
    assert.ok(res.out[0], "sem chão o objeto sai da caixa");
    assert.ok(res.duration < 5, "e a simulação para sozinha: " + res.duration);
    console.log("sem chão: OK");
})();

// ---- gravidade zero: nada se mexe ----

(function () {
    var res = P.simulate({ width: 200, height: 200, items: [item(rectPaths(80, 20, 40, 40))] },
        { gravity: 0, air: 0, friction: 0.5, maxSeconds: 5, walls: WALLS });
    assert.ok(res.settled && res.duration < 1, "gravidade zero assenta na hora");
    assert.ok(Math.abs(res.frames[last(res)][1] - 40) < 1e-9, "e não se move");
    console.log("gravidade zero: OK");
})();

console.log("\nphysics.test.js: todos os testes passaram");
