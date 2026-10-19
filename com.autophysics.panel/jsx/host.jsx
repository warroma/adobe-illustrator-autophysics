// AutoPhysics — motor ExtendScript chamado pelo painel CEP via evalScript.
// Mesma convenção dos projetos irmãos (AutoGrids/AutoLiquid): nada de JSON,
// os dados cruzam a ponte como texto com separadores simples, e todas as
// medidas estão em pontos (pt), nas coordenadas do documento (y para cima).
//
// O que roda aqui é só o que PRECISA do Illustrator:
//   - ler a seleção (contornos, cor, propriedades gravadas) — AutoPhysics_capture/read;
//   - gravar o estado final da simulação nos objetos — AutoPhysics_apply;
//   - exportar um PNG de cada objeto e do fundo para o GIF — AutoPhysics_exportSprites.
// A física em si roda no painel (js/physics.js), que é muito mais rápido.
//
// Identidade dos objetos: PageItem.uuid + Document.getPageItemFromUuid
// (Illustrator 24 / CC 2020 em diante). O uuid sobrevive a mover, girar e
// desfazer, então o painel pode guardar só ele entre uma chamada e outra.
//
// Propriedades de cada objeto (elasticidade, peso, offset) ficam numa Tag
// "AutoPhysics" do próprio objeto: invisível, salva no .ai e não mexe na
// nota (Atributos) do usuário. Só é gravada ao aplicar o estado final, junto
// com o movimento — um passo de desfazer só.

var TAG_NAME = "AutoPhysics";
var MAX_ITEMS = 300;
// Acima disso, caminhos extras de um mesmo objeto entram só pelo retângulo
// (cada ponto lido via ExtendScript custa caro numa ilustração complexa).
var MAX_DETAILED_PATHS = 300;

// ===== utilitários =====

function r3(v) {
    return Math.round(v * 1000) / 1000;
}

function cleanText(s) {
    return String(s || "").replace(/[|;\n\r]/g, " ");
}

function splitCSV(s) {
    var parts = String(s || "").split(",");
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i] !== "") out.push(parts[i]);
    return out;
}

function findByUuid(doc, uuid) {
    try {
        return doc.getPageItemFromUuid(uuid);
    } catch (e) {
        return null;
    }
}

// ===== cor aproximada (só para o desenho de prévia no painel) =====
// Mesma ideia do approxFillRGB do AutoLiquid.

function colorToRGB(c) {
    if (!c) return null;
    if (c.typename === "RGBColor") return [Math.round(c.red), Math.round(c.green), Math.round(c.blue)];
    if (c.typename === "GrayColor") {
        var g = Math.round(255 * (1 - c.gray / 100));
        return [g, g, g];
    }
    if (c.typename === "CMYKColor") {
        return [
            Math.round(255 * (1 - c.cyan / 100) * (1 - c.black / 100)),
            Math.round(255 * (1 - c.magenta / 100) * (1 - c.black / 100)),
            Math.round(255 * (1 - c.yellow / 100) * (1 - c.black / 100))
        ];
    }
    if (c.typename === "SpotColor") return colorToRGB(c.spot.color);
    if (c.typename === "GradientColor") {
        try { return colorToRGB(c.gradient.gradientStops[0].color); } catch (e) { return null; }
    }
    return null;
}

function approxColor(item, depth) {
    if (depth > 4) return null;
    try {
        var t = item.typename, rgb = null, i;
        if (t === "PathItem") {
            if (item.filled) rgb = colorToRGB(item.fillColor);
            if (!rgb && item.stroked) rgb = colorToRGB(item.strokeColor);
            return rgb;
        }
        if (t === "CompoundPathItem" && item.pathItems.length > 0) return approxColor(item.pathItems[0], depth + 1);
        if (t === "TextFrame") return colorToRGB(item.textRange.characterAttributes.fillColor);
        if (t === "GroupItem") {
            var clipped = safe(function () { return item.clipped; }, false);
            for (i = 0; i < item.pageItems.length && i < 20; i++) {
                if (clipped && item.pageItems[i].clipping) continue;
                rgb = approxColor(item.pageItems[i], depth + 1);
                if (rgb) return rgb;
            }
        }
    } catch (e) { /* cor exótica: cai no cinza */ }
    return null;
}

// ===== contorno =====
//
// Cada caminho vira "c:" (fechado) ou "o:" (aberto) + a lista
// ax,ay,lx,ly,rx,ry,... (âncora, alça esquerda, alça direita de cada ponto).
// O painel amostra as curvas e tira a envoltória convexa.

function pathToString(path) {
    var pts = path.pathPoints, out = [];
    for (var i = 0; i < pts.length; i++) {
        var p = pts[i], a = p.anchor, l = p.leftDirection, r = p.rightDirection;
        out.push(r3(a[0]), r3(a[1]), r3(l[0]), r3(l[1]), r3(r[0]), r3(r[1]));
    }
    return (path.closed ? "c:" : "o:") + out.join(",");
}

function boundsToString(gb) {
    var l = r3(gb[0]), t = r3(gb[1]), r = r3(gb[2]), b = r3(gb[3]);
    return "c:" + [l, t, l, t, l, t, r, t, r, t, r, t, r, b, r, b, r, b, l, b, l, b, l, b].join(",");
}

// Lê uma propriedade sem deixar o erro subir. Alguns objetos — texto em
// contornos com efeito 3D, por exemplo — respondem a leituras comuns (como
// GroupItem.clipped) com o erro genérico do Illustrator 1346458189 ('PARM').
// Uma leitura dessas não pode derrubar a captura inteira: quem chama cai num
// plano B (os limites do objeto).
function safe(read, fallback) {
    try {
        return read();
    } catch (e) {
        return fallback;
    }
}

function boundsOf(item) {
    return safe(function () { return item.geometricBounds; }, null) ||
        safe(function () { return item.visibleBounds; }, null);
}

function pushBounds(item, acc) {
    var gb = boundsOf(item);
    if (gb) acc.paths.push(boundsToString(gb));
}

// Junta em "acc" os contornos de um objeto. Grupo com máscara: só a máscara
// conta (o que está fora dela não aparece). Texto, imagem, símbolo etc.:
// retângulo dos limites. Qualquer parte que o Illustrator se recuse a
// descrever entra pelo retângulo dos limites dela.
function collectOutline(item, acc) {
    var t = safe(function () { return item.typename; }, ""), i;
    if (t === "PathItem") {
        if (safe(function () { return item.guides; }, false)) return;
        var half = safe(function () { return item.stroked && item.strokeWidth > 0 ? item.strokeWidth / 2 : 0; }, 0);
        acc.stroke = Math.max(acc.stroke, half);
        if (acc.detailed < MAX_DETAILED_PATHS) {
            var str = safe(function () { return item.pathPoints.length > 0 ? pathToString(item) : null; }, null);
            if (str) {
                acc.detailed++;
                acc.paths.push(str);
                return;
            }
        }
        pushBounds(item, acc);
        return;
    }
    if (t === "CompoundPathItem") {
        var parts = safe(function () { return item.pathItems; }, null);
        var n = parts ? safe(function () { return parts.length; }, 0) : 0;
        if (!n) { pushBounds(item, acc); return; }
        for (i = 0; i < n; i++) {
            var part = safe(function () { return parts[i]; }, null);
            if (part) collectOutline(part, acc);
        }
        return;
    }
    if (t === "GroupItem") {
        var children = safe(function () { return item.pageItems; }, null);
        var count = children ? safe(function () { return children.length; }, 0) : 0;
        if (!count) { pushBounds(item, acc); return; }
        var kids = [];
        for (i = 0; i < count; i++) {
            var kid = safe(function () { return children[i]; }, null);
            if (kid) kids.push(kid);
        }
        var usedClip = false;
        if (safe(function () { return item.clipped; }, false)) {
            for (i = 0; i < kids.length; i++) {
                var ch = kids[i];
                var isClip = safe(function () {
                    return ch.clipping || (ch.typename === "CompoundPathItem" && ch.pathItems.length > 0 && ch.pathItems[0].clipping);
                }, false);
                if (isClip) {
                    collectOutline(ch, acc);
                    usedClip = true;
                }
            }
        }
        if (!usedClip) {
            for (i = 0; i < kids.length; i++) {
                if (!safe(function () { return kids[i].hidden; }, false)) collectOutline(kids[i], acc);
            }
        }
        return;
    }
    pushBounds(item, acc);
}

// ===== propriedades (Tag) =====

function readProps(item) {
    try {
        var tags = item.tags;
        for (var i = 0; i < tags.length; i++) {
            if (tags[i].name === TAG_NAME) return cleanText(tags[i].value);
        }
    } catch (e) { /* tipo sem tags */ }
    return "";
}

function writeProps(item, value) {
    try {
        var tags = item.tags;
        for (var i = tags.length - 1; i >= 0; i--) {
            if (tags[i].name === TAG_NAME) {
                if (tags[i].value === value) return;
                tags[i].remove();
            }
        }
        var tag = tags.add();
        tag.name = TAG_NAME;
        tag.value = value;
    } catch (e) { /* tipo sem tags: só não lembra */ }
}

// ===== prancheta =====

function artboardRect(doc, i) {
    var r = doc.artboards[i].artboardRect;
    return [r[0], r[1], r[2], r[3]];
}

// Prancheta que contém o centro do conjunto de objetos; se nenhuma contém
// (ex.: tudo acima da prancheta, esperando para cair), a que mais se sobrepõe
// na horizontal; por último, a ativa.
function pickArtboard(doc, items) {
    var l = Infinity, t = -Infinity, r = -Infinity, b = Infinity, i;
    for (i = 0; i < items.length; i++) {
        var gb = boundsOf(items[i]);
        if (!gb) continue;
        l = Math.min(l, gb[0]); r = Math.max(r, gb[2]);
        t = Math.max(t, gb[1]); b = Math.min(b, gb[3]);
    }
    var cx = (l + r) / 2, cy = (t + b) / 2;
    var bestH = -1, bestHOverlap = 0;
    for (i = 0; i < doc.artboards.length; i++) {
        var ab = artboardRect(doc, i);
        var abL = Math.min(ab[0], ab[2]), abR = Math.max(ab[0], ab[2]);
        var abB = Math.min(ab[1], ab[3]), abT = Math.max(ab[1], ab[3]);
        if (cx >= abL && cx <= abR && cy >= abB && cy <= abT) return i;
        var ov = Math.min(r, abR) - Math.max(l, abL);
        if (ov > bestHOverlap && cy > abB) { bestHOverlap = ov; bestH = i; }
    }
    return bestH >= 0 ? bestH : doc.artboards.getActiveArtboardIndex();
}

// ===== descrição dos objetos =====
//
// Linha 1: "OK|índice da prancheta|nome|left,top,right,bottom|quantidade"
// Uma linha por objeto:
//   "uuid|nome|tipo|meio traço|r,g,b|limites geométricos|limites visíveis|props|contornos"
// (limites = left,top,right,bottom; contornos separados por ";"). Os limites
// visíveis incluem traço e efeitos (3D, sombra...): o painel compara com os
// geométricos para saber se a aparência é maior que o desenho.

function boundsField(b) {
    return b ? [r3(b[0]), r3(b[1]), r3(b[2]), r3(b[3])].join(",") : "";
}

function describe(doc, items) {
    var abIndex = pickArtboard(doc, items);
    var ab = artboardRect(doc, abIndex);
    var lines = ["OK|" + abIndex + "|" + cleanText(doc.artboards[abIndex].name) + "|" +
        [r3(ab[0]), r3(ab[1]), r3(ab[2]), r3(ab[3])].join(",") + "|" + items.length];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var acc = { paths: [], stroke: 0, detailed: 0 };
        collectOutline(it, acc);
        var gb = boundsOf(it);
        if (!acc.paths.length && gb) acc.paths.push(boundsToString(gb));
        var vb = safe(function () { return it.visibleBounds; }, null);
        var rgb = approxColor(it, 0) || [150, 150, 150];
        lines.push([
            it.uuid,
            cleanText(safe(function () { return it.name; }, "")),
            safe(function () { return it.typename; }, "PageItem"),
            r3(acc.stroke),
            rgb.join(","),
            boundsField(gb),
            boundsField(vb),
            readProps(it),
            acc.paths.join(";")
        ].join("|"));
    }
    return lines.join("\n");
}

function isAncestorIn(item, set) {
    var p = item.parent;
    while (p && p.typename !== "Layer" && p.typename !== "Document") {
        try { if (set[p.uuid]) return true; } catch (e) { return false; }
        p = p.parent;
    }
    return false;
}

// ===== Pontos de entrada chamados pelo painel =====

// Lê a seleção atual. Cada objeto selecionado vira um corpo (um grupo se
// move como um corpo só). Se um objeto e um grupo que o contém estão os dois
// selecionados, fica só o grupo.
function AutoPhysics_capture() {
    try {
        if (app.documents.length === 0) return "ERRO: Abra um documento no Illustrator.";
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.typename === "TextRange") return "ERRO: Saia da edição de texto e selecione os objetos.";
        if (sel.length === 0) return "ERRO: Selecione os objetos que vão cair.";
        var set = {}, i;
        for (i = 0; i < sel.length; i++) set[sel[i].uuid] = true;
        var items = [];
        for (i = 0; i < sel.length; i++) {
            if (!isAncestorIn(sel[i], set)) items.push(sel[i]);
        }
        if (items.length > MAX_ITEMS) return "ERRO: São " + items.length + " objetos — o limite é " + MAX_ITEMS + ". Agrupe partes que podem cair juntas.";
        return describe(doc, items);
    } catch (err) {
        return "ERRO: " + err.message + " (line " + err.line + ")";
    }
}

// Relê objetos já capturados (posição/forma ATUAIS — o painel chama isto
// antes de cada simulação, então mover um objeto depois de capturar não é
// problema).
function AutoPhysics_read(uuidsCSV) {
    try {
        if (app.documents.length === 0) return "ERRO: Abra um documento no Illustrator.";
        var doc = app.activeDocument;
        // Objetos apagados desde a captura simplesmente não voltam na lista
        // (o painel percebe pelos uuids que faltam).
        var uuids = splitCSV(uuidsCSV), items = [];
        for (var i = 0; i < uuids.length; i++) {
            var it = findByUuid(doc, uuids[i]);
            if (it) items.push(it);
        }
        if (items.length === 0) return "ERRO: Os objetos capturados não existem mais neste documento. Capture de novo.";
        return describe(doc, items);
    } catch (err) {
        return "ERRO: " + err.message + " (line " + err.line + ")";
    }
}

// Seleciona no Illustrator os objetos clicados na lista do painel.
function AutoPhysics_select(uuidsCSV) {
    try {
        if (app.documents.length === 0) return "OK";
        var doc = app.activeDocument;
        var uuids = splitCSV(uuidsCSV), items = [];
        for (var i = 0; i < uuids.length; i++) {
            var it = findByUuid(doc, uuids[i]);
            if (it && !it.locked && !it.hidden) items.push(it);
        }
        doc.selection = null;
        if (items.length) doc.selection = items;
        app.redraw();
        return "OK";
    } catch (err) {
        return "ERRO: " + err.message;
    }
}

function boundsLine(item) {
    var gb = item.geometricBounds;
    return item.uuid + "," + [r3(gb[0]), r3(gb[1]), r3(gb[2]), r3(gb[3])].join(",");
}

// Limites atuais (o painel compara para saber se o documento ainda está no
// início ou no fim da simulação antes de exportar o GIF).
function AutoPhysics_bounds(uuidsCSV) {
    try {
        if (app.documents.length === 0) return "ERRO: Abra um documento no Illustrator.";
        var doc = app.activeDocument;
        var uuids = splitCSV(uuidsCSV), out = [];
        for (var i = 0; i < uuids.length; i++) {
            var it = findByUuid(doc, uuids[i]);
            if (!it) return "ERRO: Um dos objetos não existe mais. Capture de novo.";
            out.push(boundsLine(it));
        }
        return "OK|" + out.join(";");
    } catch (err) {
        return "ERRO: " + err.message;
    }
}

// Grava o estado final. Uma linha por objeto:
//   "uuid|cx0,cy0|cx1,cy1|graus|props"
// cx0,cy0 = centro de massa ANTES (coordenadas do documento); cx1,cy1 = onde
// ele tem que parar; graus = rotação (positivo = anti-horário, como no
// Illustrator).
//
// O Illustrator só gira em torno de pontos de referência fixos (centro dos
// limites, cantos, origem do documento) — e o centro de massa não é nenhum
// deles. Então: gira em torno da ORIGEM DO DOCUMENTO e, para saber onde o
// centro de massa foi parar, gira junto um caminho-sonda posicionado nele
// (mesma chamada, mesma origem). Depois é só transladar a diferença. Isso
// independe de onde a origem está e da régua usada.
function AutoPhysics_apply(spec) {
    var probeLayer = null;
    try {
        if (app.documents.length === 0) return "ERRO: Abra um documento no Illustrator.";
        var doc = app.activeDocument;
        var prevLayer = doc.activeLayer;
        var lines = String(spec).split("\n");
        var jobs = [], i;
        for (i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var f = lines[i].split("|");
            var it = findByUuid(doc, f[0]);
            if (!it) return "ERRO: Um dos objetos não existe mais. Capture de novo.";
            if (it.locked || !it.editable) return "ERRO: \"" + (it.name || it.typename) + "\" está travado — destrave para aplicar.";
            var c0 = f[1].split(","), c1 = f[2].split(",");
            jobs.push({
                item: it,
                c0x: parseFloat(c0[0]), c0y: parseFloat(c0[1]),
                c1x: parseFloat(c1[0]), c1y: parseFloat(c1[1]),
                deg: parseFloat(f[3]), props: f[4] || ""
            });
        }

        probeLayer = doc.layers.add();
        probeLayer.name = "AutoPhysics (temporário)";
        var probe = probeLayer.pathItems.add();
        probe.stroked = false;
        probe.filled = false;

        var out = [];
        for (i = 0; i < jobs.length; i++) {
            var j = jobs[i], cx = j.c0x, cy = j.c0y;
            if (Math.abs(j.deg) > 1e-6) {
                j.item.rotate(j.deg, true, true, true, true, Transformation.DOCUMENTORIGIN);
                probe.setEntirePath([[j.c0x, j.c0y], [j.c0x + 1, j.c0y]]);
                probe.rotate(j.deg, true, false, false, false, Transformation.DOCUMENTORIGIN);
                var a = probe.pathPoints[0].anchor;
                cx = a[0]; cy = a[1];
            }
            j.item.translate(j.c1x - cx, j.c1y - cy);
            if (j.props) writeProps(j.item, j.props);
            out.push(boundsLine(j.item));
        }

        probeLayer.remove();
        probeLayer = null;
        try { doc.activeLayer = prevLayer; } catch (e1) { /* camada anterior sumiu */ }
        app.redraw();
        return "OK|" + out.join(";");
    } catch (err) {
        if (probeLayer) {
            try { probeLayer.remove(); } catch (e2) { /* já foi */ }
        }
        return "ERRO: " + err.message + " (line " + err.line + ")";
    }
}

// ===== Exportação para o GIF =====

function findExported(folder, base) {
    var direct = new File(folder.fsName + "/" + base + ".png");
    if (direct.exists) return direct;
    var files = folder.getFiles(base + "*.png");
    return files.length ? files[0] : null;
}

function exportPNG(doc, folder, base, scalePct, transparent) {
    var opts = new ExportOptionsPNG24();
    opts.antiAliasing = true;
    opts.transparency = transparent;
    opts.artBoardClipping = true;
    opts.horizontalScale = scalePct;
    opts.verticalScale = scalePct;
    doc.exportFile(new File(folder.fsName + "/" + base), ExportType.PNG24, opts);
    var f = findExported(folder, base);
    if (!f) throw new Error("o Illustrator não gerou o PNG " + base);
    return f;
}

// Exporta, numa pasta temporária:
//   - o fundo (a prancheta inteira SEM os objetos simulados), se withBackground;
//   - um PNG transparente de cada objeto, do jeito que ele está agora.
// Cada objeto vai para um documento temporário com a prancheta do tamanho
// dele (+ folga para sombras e efeitos), então o PNG sai com a aparência
// exata do Illustrator — gradiente, efeitos, texto, imagem.
//
// Retorna "OK|pasta|arquivo do fundo (ou vazio)" + uma linha por objeto:
//   "arquivo|left,top,right,bottom" = área do PNG no documento original.
function AutoPhysics_exportSprites(uuidsCSV, abIndex, bgScalePct, spriteScalePct, withBackground) {
    var doc = null, tmp = null, hidden = [], prevUIL = null, prevAB = -1, i;
    try {
        if (app.documents.length === 0) return "ERRO: Abra um documento no Illustrator.";
        doc = app.activeDocument;
        var uuids = splitCSV(uuidsCSV), items = [];
        for (i = 0; i < uuids.length; i++) {
            var it = findByUuid(doc, uuids[i]);
            if (!it) return "ERRO: Um dos objetos não existe mais. Capture de novo.";
            items.push(it);
        }
        prevUIL = app.userInteractionLevel;
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

        var folder = new Folder(Folder.temp.fsName + "/AutoPhysics_" + new Date().getTime());
        folder.create();
        var bgPath = "";

        if (withBackground) {
            var prevSel = doc.selection;
            prevAB = doc.artboards.getActiveArtboardIndex();
            doc.artboards.setActiveArtboardIndex(abIndex);
            for (i = 0; i < items.length; i++) {
                if (!items[i].hidden) { items[i].hidden = true; hidden.push(items[i]); }
            }
            bgPath = exportPNG(doc, folder, "fundo", bgScalePct, false).fsName;
            for (i = 0; i < hidden.length; i++) hidden[i].hidden = false;
            hidden = [];
            doc.artboards.setActiveArtboardIndex(prevAB);
            prevAB = -1;
            // Esconder tira os objetos da seleção; devolve como estava.
            try { if (prevSel && prevSel.length) doc.selection = prevSel; } catch (e0) { /* seleção mudou */ }
        }

        var src = [];
        for (i = 0; i < items.length; i++) src.push(items[i].visibleBounds);

        tmp = app.documents.add(doc.documentColorSpace, 100, 100);
        var home = tmp.artboards[0].artboardRect;
        var lines = [];
        for (i = 0; i < items.length; i++) {
            var dup = items[i].duplicate(tmp.layers[0], ElementPlacement.PLACEATEND);
            dup.hidden = false;
            // A cópia chega nas mesmas coordenadas do original, que podem
            // cair fora da área de trabalho do documento novo (e aí a
            // prancheta não pode ir até lá). Encosta ela na prancheta inicial.
            var vb0 = dup.visibleBounds;
            dup.translate(home[0] - vb0[0], home[1] - vb0[1]);
            var vb = dup.visibleBounds;
            var w = vb[2] - vb[0], h = vb[1] - vb[3];
            var pad = Math.max(12, 0.15 * Math.max(w, h));
            var L = Math.floor(vb[0] - pad), T = Math.ceil(vb[1] + pad);
            var R = Math.ceil(vb[2] + pad), B = Math.floor(vb[3] - pad);
            tmp.artboards[0].artboardRect = [L, T, R, B];
            var file = exportPNG(tmp, folder, "obj" + i, spriteScalePct, true);
            dup.remove();
            // Mesma folga, agora medida a partir dos limites do original.
            var s = src[i];
            var oL = s[0] - (vb[0] - L), oT = s[1] + (T - vb[1]);
            lines.push(file.fsName + "|" + [r3(oL), r3(oT), r3(oL + (R - L)), r3(oT - (T - B))].join(","));
        }
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        tmp = null;
        doc.activate();
        app.userInteractionLevel = prevUIL;
        return "OK|" + folder.fsName + "|" + bgPath + "\n" + lines.join("\n");
    } catch (err) {
        for (i = 0; i < hidden.length; i++) {
            try { hidden[i].hidden = false; } catch (e1) { /* nada */ }
        }
        if (doc && prevAB >= 0) {
            try { doc.artboards.setActiveArtboardIndex(prevAB); } catch (e2) { /* nada */ }
        }
        if (tmp) {
            try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e3) { /* nada */ }
        }
        if (doc) {
            try { doc.activate(); } catch (e4) { /* nada */ }
        }
        if (prevUIL !== null) app.userInteractionLevel = prevUIL;
        return "ERRO: " + err.message + " (line " + err.line + ")";
    }
}

// Apaga a pasta temporária de PNGs depois que o painel já os carregou.
function AutoPhysics_cleanup(folderPath) {
    try {
        var folder = new Folder(folderPath);
        if (!folder.exists || folder.name.indexOf("AutoPhysics_") !== 0) return "OK";
        var files = folder.getFiles();
        for (var i = 0; i < files.length; i++) files[i].remove();
        folder.remove();
        return "OK";
    } catch (err) {
        return "OK";
    }
}
