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
// "extra" simula um efeito (3D, sombra) que deixa a aparência maior que o desenho.
Object.defineProperty(FakePath.prototype, "visibleBounds", {
    get: function () {
        var b = boundsOf(this.pts), e = this.extra;
        return e ? [b[0] - e[0], b[1] + e[1], b[2] + e[2], b[3] - e[3]] : b;
    }
});
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
var va = built.scene.items[0].shape.parts[0];
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
assert.deepStrictEqual(B.parseProps(tri.tags[0].value), { e: 0.6, w: 2, o: 0, a: -1 });
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

assert.deepStrictEqual(B.parseProps(""), { e: 0.3, w: 1, o: 0, a: -1 });
assert.deepStrictEqual(B.parseProps("e=0.9;w=20;o=-3;a=1"), { e: 0.9, w: 10, o: -3, a: 1 });
assert.strictEqual(B.formatProps({ e: 0.5, w: 1.25, o: -2, a: -1 }), "e=0.5;w=1.25;o=-2");
assert.strictEqual(B.formatProps({ e: 0.5, w: 1.25, o: -2, a: 0 }), "e=0.5;w=1.25;o=-2;a=0");

// ---- texto em contornos com efeito: grupo cujo "clipped" dá erro PARM ----
//
// Caso real (v1.0.0): "an Illustrator error occurred: 1346458189 ('PARM')"
// ao ler GroupItem.clipped de letras convertidas em contornos e extrudadas.
// A captura tem que seguir: o grupo é lido pelos filhos, e o "O" (caminho
// composto) entra só pelo contorno de fora.

function FakeContainer(typename, children) {
    this.typename = typename;
    this.uuid = String(uuidSeq++);
    this.name = "";
    this.locked = false; this.editable = true; this.hidden = false; this.clipping = false;
    this.parent = userLayer;
    this.kids = children;
    var self = this;
    children.forEach(function (c) { c.parent = self; });
    var tagList = [];
    tagList.add = function () { var t = { name: "", value: "" }; tagList.push(t); return t; };
    this.tags = tagList;
}
FakeContainer.prototype = {
    get pageItems() { return this.kids; },
    get pathItems() { return this.kids; },
    get geometricBounds() {
        function pts(n) { return n.kids ? [].concat.apply([], n.kids.map(pts)) : n.pts; }
        return boundsOf(pts(this));
    },
    get visibleBounds() {
        var b = this.geometricBounds, e = this.extra;
        return e ? [b[0] - e[0], b[1] + e[1], b[2] + e[2], b[3] - e[3]] : b;
    },
    get clipped() { throw new Error("an Illustrator error occurred: 1346458189 ('PARM')"); }
};

(function () {
    // "O" quadrado: contorno de fora + miolo, num caminho composto, dentro de um grupo.
    var outer = new FakePath([[100, 700], [160, 700], [160, 620], [100, 620]], null);
    var inner = new FakePath([[115, 685], [115, 635], [145, 635], [145, 685]], null);
    var O = new FakeContainer("CompoundPathItem", [outer, inner]);
    var group = new FakeContainer("GroupItem", [O]);
    items[group.uuid] = group;
    doc.selection = [group];
    var cap = ctx.AutoPhysics_capture();
    assert.ok(cap.indexOf("OK|") === 0, "captura não pode dar erro com o PARM: " + cap.slice(0, 160));
    var d = B.parseDescription(cap);
    assert.strictEqual(d.items.length, 1);
    assert.strictEqual(d.items[0].paths.length, 2, "os dois subcaminhos do O foram lidos");
    var sc = B.buildScene(d, {});
    var sh = sc.scene.items[0].shape;
    assert.strictEqual(sh.kind, "parts");
    assert.strictEqual(sh.parts.length, 1, "o miolo do O não vira peça");
    assert.ok(Math.abs(P._internal.shapeArea(sh) - 60 * 80) < 1e-6, "área = contorno de fora");
    assert.strictEqual(sc.meta[0].art.length, 2, "a prévia desenha o O com o miolo");
    console.log("grupo com PARM em .clipped: OK (O lido pelos filhos, miolo fora da colisão)");

    // Mesma coisa com "extrusão": a aparência passa 20 pt para a direita e 12 para baixo.
    group.extra = [0, 0, 20, 12];
    var capText = ctx.AutoPhysics_capture();
    d = B.parseDescription(capText);
    assert.ok(d.items[0].effect.active, "efeito detectado: " + capText.split("\n")[1].split("|").slice(5, 7).join(" | ") + " " + JSON.stringify(d.items[0].effect));
    assert.strictEqual(d.items[0].effect.dx, 20);
    assert.strictEqual(d.items[0].effect.dy, 12);
    sc = B.buildScene(d, {});
    var swept = sc.scene.items[0].shape.parts[0];
    var xs = swept.map(function (v) { return v.x; }), ys = swept.map(function (v) { return v.y; });
    // Local: x 100..160 (+20), y (800-700)=100..180 (+12)
    assert.ok(Math.abs(Math.max.apply(null, xs) - 180) < 1e-6 && Math.abs(Math.max.apply(null, ys) - 192) < 1e-6, "peça varrida até a face de trás");
    assert.ok(Math.abs(Math.min.apply(null, xs) - 100) < 1e-6 && Math.abs(Math.min.apply(null, ys) - 100) < 1e-6, "e começa na face da frente");
    assert.strictEqual(sc.meta[0].appearance, true);
    var off = {};
    off[group.uuid] = B.parseProps("a=0");
    sc = B.buildScene(d, off);
    assert.ok(Math.abs(P._internal.shapeArea(sc.scene.items[0].shape) - 60 * 80) < 1e-6, "com a aparência desligada, só o desenho");
    console.log("colisão pela aparência (extrusão): OK — automática, e dá para desligar por objeto");
})();

console.log("\nbridge.test.js: todos os testes passaram");
