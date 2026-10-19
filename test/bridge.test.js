"use strict";

// Testa o caminho completo Illustrator -> física -> Illustrator, com o
// host.jsx de verdade rodando contra um Illustrator de mentira (só o pedaço do
// DOM que ele usa). O ponto delicado é a conversão de coordenadas (o
// Illustrator tem y para cima; o motor, y para baixo) e o giro em torno do
// centro de massa, que o Illustrator não oferece direto — o teste confere que
// cada vértice do objeto termina exatamente onde a física mandou.
//
// Rodar: node test/autophysics/bridge.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var P = require("../com.autophysics.panel/js/physics.js");
var B = require("../com.autophysics.panel/js/bridge.js");

// ---- Illustrator falso ----

var ORIGIN = { x: 137.5, y: -412.25 }; // "origem do documento" arbitrária: o host não pode depender dela

function rotatePts(pts, deg, ox, oy) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); // y para cima: positivo = anti-horário
    return pts.map(function (p) {
        var dx = p[0] - ox, dy = p[1] - oy;
        return [ox + c * dx - s * dy, oy + s * dx + c * dy];
    });
}

function boundsOf(pts) {
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    return [Math.min.apply(null, xs), Math.max.apply(null, ys), Math.max.apply(null, xs), Math.min.apply(null, ys)];
}

var uuidSeq = 1;
function FakePath(pts, layer) {
    this.typename = "PathItem";
    this.uuid = String(uuidSeq++);
    this.name = "";
    this.pts = pts; // [[x,y]] — retas (alças = âncoras)
    this.closed = true;
    this.stroked = false; this.strokeWidth = 0; this.filled = true; this.guides = false;
    this.locked = false; this.editable = true; this.hidden = false; this.clipping = false;
    this.parent = layer;
    this.fillColor = { typename: "RGBColor", red: 200, green: 40, blue: 60 };
    var tagList = [];
    tagList.add = function () { var t = { name: "", value: "", remove: function () { tagList.splice(tagList.indexOf(t), 1); } }; tagList.push(t); return t; };
    this.tags = tagList;
}
Object.defineProperty(FakePath.prototype, "pathPoints", {
    get: function () {
        return this.pts.map(function (p) { return { anchor: p.slice(), leftDirection: p.slice(), rightDirection: p.slice() }; });
    }
});
Object.defineProperty(FakePath.prototype, "geometricBounds", { get: function () { return boundsOf(this.pts); } });
Object.defineProperty(FakePath.prototype, "visibleBounds", { get: function () { return boundsOf(this.pts); } });
FakePath.prototype.setEntirePath = function (pts) { this.pts = pts.map(function (p) { return p.slice(); }); };
FakePath.prototype.rotate = function (deg, a, b, c, d, about) {
    assert.strictEqual(about, "DOCUMENTORIGIN", "o host gira sempre em torno da origem do documento");
    this.pts = rotatePts(this.pts, deg, ORIGIN.x, ORIGIN.y);
};
FakePath.prototype.translate = function (dx, dy) {
    this.pts = this.pts.map(function (p) { return [p[0] + dx, p[1] + dy]; });
};

var items = {};
var userLayer = { typename: "Layer", name: "Camada 1" };
var doc = {
    artboards: [{ name: "Prancheta 1", artboardRect: [0, 800, 600, 0] }],
    selection: [],
    activeLayer: userLayer,
    getPageItemFromUuid: function (u) { if (!items[u]) throw new Error("no item"); return items[u]; },
    layers: {
        add: function () {
            var layer = { typename: "Layer", name: "", removed: false };
            layer.pathItems = { add: function () { return new FakePath([], layer); } };
            layer.remove = function () { layer.removed = true; };
            doc.layers.last = layer;
            return layer;
        }
    }
};
doc.artboards.getActiveArtboardIndex = function () { return 0; };
var ctx = {
    app: { documents: { length: 1 }, activeDocument: doc, redraw: function () {} },
    Transformation: { DOCUMENTORIGIN: "DOCUMENTORIGIN", CENTER: "CENTER" }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../com.autophysics.panel/jsx/host.jsx"), "utf8"), ctx);

function addItem(pts) {
    var it = new FakePath(pts, userLayer);
    items[it.uuid] = it;
    return it;
}

// Uma "pilha" desarrumada: caixa caindo torta em cima de outra, um triângulo
// e uma caixa que começa ACIMA da prancheta (cai para dentro).
var boxA = addItem([[250, 120], [350, 120], [350, 40], [250, 40]]);            // no chão (y=0 é o pé da prancheta)
var boxB = addItem(rotatePts([[260, 400], [340, 400], [340, 330], [260, 330]], 20, 300, 365));
var tri = addItem([[80, 600], [160, 600], [120, 690]]);
var high = addItem([[420, 900], [480, 900], [480, 860], [420, 860]]);
doc.selection = [boxA, boxB, tri, high];

// ---- captura (host) -> descrição (bridge) ----

var text = ctx.AutoPhysics_capture();
var desc = B.parseDescription(text);
assert.ok(!desc.error, "capture sem erro: " + text.slice(0, 200));
assert.strictEqual(desc.items.length, 4);
assert.deepStrictEqual(desc.abRect, [0, 800, 600, 0]);
assert.strictEqual(desc.items[0].uuid, boxA.uuid);
assert.deepStrictEqual(desc.items[0].color, [200, 40, 60]);
console.log("captura: OK (" + desc.items.length + " objetos, prancheta \"" + desc.abName + "\")");

var props = {};
props[tri.uuid] = { e: 0.6, w: 2, o: 0 };
var built = B.buildScene(desc, props);
assert.strictEqual(built.scene.items.length, 4, "nenhum objeto descartado");
assert.strictEqual(built.scene.width, 600);
assert.strictEqual(built.scene.height, 800);
// Caixa A: y do documento 40..120 com topo da prancheta em 800 -> local 680..760.
var va = built.scene.items[0].shape.verts;
var ys = va.map(function (v) { return v.y; });
assert.ok(Math.abs(Math.min.apply(null, ys) - 680) < 1e-9 && Math.abs(Math.max.apply(null, ys) - 760) < 1e-9, "y convertido para baixo");
assert.strictEqual(built.scene.items[2].restitution, 0.6, "props do painel valem por cima da Tag");

// ---- simulação ----

var res = P.simulate(built.scene, { gravity: 1, air: 0.1, friction: 0.5, maxSeconds: 6, walls: { floor: true, left: true, right: true } });
var sim = { frame: built.frame, meta: built.meta, result: res };
var lastF = res.frames.length - 1;

// ---- aplicar (bridge -> host) e conferir cada vértice ----

var before = {};
[boxA, boxB, tri, high].forEach(function (it) { before[it.uuid] = it.pts.map(function (p) { return p.slice(); }); });
var spec = B.buildApplySpec(sim, lastF);
var applied = ctx.AutoPhysics_apply(spec);
assert.ok(applied.indexOf("OK|") === 0, "apply sem erro: " + applied);
assert.ok(doc.layers.last.removed, "camada da sonda removida");
assert.strictEqual(doc.activeLayer, userLayer, "camada ativa restaurada");

var worst = 0;
[boxA, boxB, tri, high].forEach(function (it, i) {
    var f = res.frames[lastF], a = f[i * 3 + 2], c = Math.cos(a), s = Math.sin(a);
    var b0 = res.bodies[i];
    before[it.uuid].forEach(function (p, k) {
        // Vértice original em coordenadas locais, relativo ao centroide inicial...
        var lx = built.frame.toLocalX(p[0]) - b0.x, ly = built.frame.toLocalY(p[1]) - b0.y;
        // ...levado pela pose final da física...
        var ex = f[i * 3] + c * lx - s * ly, ey = f[i * 3 + 1] + s * lx + c * ly;
        // ...tem que bater com onde o host deixou o vértice no "documento".
        var got = it.pts[k];
        var gx = built.frame.toLocalX(got[0]), gy = built.frame.toLocalY(got[1]);
        worst = Math.max(worst, Math.abs(gx - ex), Math.abs(gy - ey));
    });
});
assert.ok(worst < 1e-3, "vértices aplicados batem com a física (erro máx " + worst + " pt)");
console.log("aplicar estado final: OK (erro máximo " + worst.toExponential(2) + " pt; origem do documento em " + ORIGIN.x + "," + ORIGIN.y + ")");

// Nada abaixo do chão nem fora das paredes, no documento.
[boxA, boxB, tri, high].forEach(function (it) {
    var gb = it.geometricBounds;
    assert.ok(gb[3] >= -0.5 && gb[0] >= -0.5 && gb[2] <= 600.5, "objeto dentro da prancheta: " + gb);
});

// Tag gravada junto com o movimento.
assert.strictEqual(tri.tags.length, 1);
assert.strictEqual(tri.tags[0].name, "AutoPhysics");
assert.deepStrictEqual(B.parseProps(tri.tags[0].value), { e: 0.6, w: 2, o: 0 });
console.log("tags: OK (" + tri.tags[0].value + ")");

// ---- detecção de pose (para o GIF) ----

sim.finalBounds = B.parseBounds(applied);
var nowBounds = B.parseBounds(ctx.AutoPhysics_bounds([boxA, boxB, tri, high].map(function (i) { return i.uuid; }).join(",")));
assert.strictEqual(B.detectPose(sim, nowBounds), "final");
var startBounds = {};
built.meta.forEach(function (m) { startBounds[m.uuid] = m.bounds; });
assert.strictEqual(B.detectPose(sim, startBounds), "start");
boxA.translate(5, 0);
assert.strictEqual(B.detectPose(sim, B.parseBounds(ctx.AutoPhysics_bounds(boxA.uuid + "," + boxB.uuid + "," + tri.uuid + "," + high.uuid))), null, "objeto mexido depois = nenhuma pose");
console.log("detecção de pose: OK");

// ---- cronograma de quadros do GIF ----

var sch = B.gifFrameSchedule(2.0, 100, 25, 1);
assert.strictEqual(sch.delayCs, 4);
assert.strictEqual(sch.indices[0], 0);
assert.strictEqual(sch.indices[sch.indices.length - 1], 200);
assert.strictEqual(sch.indices.length, 51);
var slow = B.gifFrameSchedule(2.0, 100, 25, 0.5);
assert.strictEqual(slow.indices.length, 101, "câmera lenta = o dobro de quadros");
console.log("cronograma do GIF: OK");

// ---- props ----

assert.deepStrictEqual(B.parseProps(""), { e: 0.3, w: 1, o: 0 });
assert.deepStrictEqual(B.parseProps("e=0.9;w=20;o=-3"), { e: 0.9, w: 10, o: -3 });
assert.strictEqual(B.formatProps({ e: 0.5, w: 1.25, o: -2 }), "e=0.5;w=1.25;o=-2");

console.log("\nbridge.test.js: todos os testes passaram");
