var csInterface = new CSInterface();
var Physics = window.AutoPhysics;
var Bridge = window.AutoPhysicsBridge;
var Gif = window.AutoPhysicsGif;

// Fluxo (igual em espírito ao AutoLiquid: trabalha em cima da SELEÇÃO):
//   1. "Capturar seleção" guarda QUAIS objetos participam (pelo uuid).
//   2. Cada objeto tem a sua elasticidade, peso e offset; gravidade, ar e
//      atrito valem para todos.
//   3. "Simular" relê a posição ATUAL dos objetos, roda a física inteira aqui
//      no painel (sem tocar no documento) e mostra a prévia.
//   4. "Aplicar estado final" move os objetos para onde a simulação terminou
//      — um passo só de desfazer.
//   5. "Exportar GIF" usa a simulação já calculada; o Illustrator só exporta
//      um PNG de cada objeto e do fundo, e os quadros são montados aqui.
// Nada roda em tempo real: o documento só muda quando você pede.

var PT_PER_MM = 2.8346456693;

var state = {
    unit: "mm",
    objects: [],        // [{ uuid, name, typename, color, props: { e, w, o } }] — ordem da seleção (frente -> trás)
    selected: {},       // uuid -> true (linhas marcadas na lista)
    lastClicked: -1,
    world: { gravity: 1, air: 0.25, friction: 0.5, maxSeconds: 8, walls: { floor: true, sides: true, ceiling: false } },
    sim: null,          // última simulação (ver runSimulation)
    busy: false
};
// Lembra os ajustes de cada objeto entre capturas (enquanto o painel estiver aberto).
var propsMemory = {};

var els = {};
["objCount", "abName", "abInfo", "captureBtn", "selectAllBtn", "objList", "objControls", "objCaption",
    "elasticity", "elasticityVal", "weight", "weightVal", "offset", "offsetVal", "offsetUnit", "unitToggle",
    "gravity", "gravityVal", "gravityHint", "air", "airVal", "friction", "frictionVal", "maxSeconds", "maxSecondsVal",
    "wallToggles", "simulateBtn", "previewWrap", "preview", "playBtn", "scrub", "timeLabel", "applyBtn",
    "gifWidth", "gifFps", "gifSpeed", "gifHold", "gifBackground", "gifLoop", "gifBtn", "status"
].forEach(function (id) { els[id] = document.getElementById(id); });

// ===== utilidades =====

function fmt(n, d) {
    var k = Math.pow(10, d === undefined ? 2 : d);
    return (Math.round(n * k) / k).toString();
}
function fmtBR(n, d) { return fmt(n, d).replace(".", ","); }
function ptToUnit(pt) { return state.unit === "mm" ? pt / PT_PER_MM : pt; }
function unitToPt(v) { return state.unit === "mm" ? v * PT_PER_MM : v; }
function parseNum(s) { return parseFloat(String(s).replace(",", ".")); }

function setStatus(msg, kind) {
    els.status.textContent = msg || "";
    els.status.className = kind || "";
}

function evalHost(call, cb) {
    csInterface.evalScript(call, function (result) { cb(result === undefined || result === null ? "" : String(result)); });
}

function fail(msg) {
    setBusy(false);
    setStatus(String(msg).replace(/^ERRO:\s*/, ""), "error");
}

function uuids() {
    return state.objects.map(function (o) { return o.uuid; });
}

var TYPE_LABELS = {
    PathItem: "Caminho", CompoundPathItem: "Caminho composto", GroupItem: "Grupo", TextFrame: "Texto",
    PlacedItem: "Imagem vinculada", RasterItem: "Imagem", SymbolItem: "Símbolo", MeshItem: "Malha", PluginItem: "Objeto"
};
function displayName(o, i) {
    return o.name || ((TYPE_LABELS[o.typename] || o.typename) + " " + (i + 1));
}

// ===== estado dos botões =====

function setBusy(b) {
    state.busy = b;
    refreshButtons();
}

function refreshButtons() {
    var has = state.objects.length > 0;
    var simOk = !!state.sim && !state.sim.stale;
    els.captureBtn.disabled = state.busy;
    els.simulateBtn.disabled = state.busy || !has;
    // Aplicar continua clicável depois de aplicado: com Ctrl+Z o documento
    // volta ao início e dá para aplicar de novo (o clique confere a pose).
    els.applyBtn.disabled = state.busy || !simOk;
    els.gifBtn.disabled = state.busy || !simOk;
    els.applyBtn.textContent = simOk && state.sim.finalBounds ? "Estado final aplicado ✓" : "Aplicar estado final";
}

// Qualquer ajuste depois de simular torna a simulação velha: o que se aplica
// ou exporta tem que ser o que os controles mostram.
function markStale() {
    if (state.sim && !state.sim.stale) {
        state.sim.stale = true;
        setStatus("Os ajustes mudaram — clique em Simular de novo.", "");
    }
    refreshButtons();
}

// ===== lista de objetos =====

function propsSummary(p) {
    return "E " + Math.round(p.e * 100) + "% · P " + fmtBR(p.w, 2) + "× · O " + fmtBR(ptToUnit(p.o), 1);
}

function renderList() {
    var list = els.objList;
    list.innerHTML = "";
    if (!state.objects.length) {
        list.innerHTML = '<div class="obj-empty">Nada capturado ainda.</div>';
        renderControls();
        return;
    }
    var skipped = state.sim && !state.sim.stale ? state.sim.skippedSet : {};
    state.objects.forEach(function (o, i) {
        var row = document.createElement("div");
        row.className = "obj-row" + (state.selected[o.uuid] ? " selected" : "") + (skipped[o.uuid] ? " skipped" : "");
        row.setAttribute("data-index", i);
        row.title = skipped[o.uuid] ? "Ficou de fora da simulação: " + skipped[o.uuid] : "";
        var sw = document.createElement("span");
        sw.className = "obj-swatch";
        sw.style.background = "rgb(" + o.color.join(",") + ")";
        var name = document.createElement("span");
        name.className = "obj-name";
        name.textContent = displayName(o, i);
        var meta = document.createElement("span");
        meta.className = "obj-meta";
        meta.textContent = propsSummary(o.props);
        row.appendChild(sw); row.appendChild(name); row.appendChild(meta);
        list.appendChild(row);
    });
    renderControls();
}

function selectedObjects() {
    return state.objects.filter(function (o) { return state.selected[o.uuid]; });
}

function renderControls() {
    var sel = selectedObjects();
    els.objControls.classList.toggle("disabled", sel.length === 0);
    if (!sel.length) {
        els.objCaption.textContent = state.objects.length ? "Clique num objeto da lista para ajustar." : "Capture objetos para ajustar.";
        return;
    }
    var p = sel[0].props;
    function same(key) { return sel.every(function (o) { return o.props[key] === p[key]; }); }
    els.objCaption.textContent = sel.length === 1
        ? "Ajustes de: " + displayName(sel[0], state.objects.indexOf(sel[0]))
        : "Ajustes de " + sel.length + " objetos" + (same("e") && same("w") && same("o") ? "" : " (valores diferentes — mexer iguala)");
    els.elasticity.value = Math.round(p.e * 100);
    els.elasticityVal.value = Math.round(p.e * 100);
    els.weight.value = Math.log(p.w) / Math.LN10;
    els.weightVal.value = fmt(p.w, 2);
    els.offset.value = p.o;
    els.offsetVal.value = fmt(ptToUnit(p.o), 2);
    els.offsetUnit.textContent = state.unit;
}

els.objList.addEventListener("click", function (e) {
    var row = e.target.closest(".obj-row");
    if (!row) return;
    var i = parseInt(row.getAttribute("data-index"), 10);
    var uuid = state.objects[i].uuid;
    if (e.shiftKey && state.lastClicked >= 0) {
        var a = Math.min(i, state.lastClicked), b = Math.max(i, state.lastClicked);
        for (var k = a; k <= b; k++) state.selected[state.objects[k].uuid] = true;
    } else if (e.ctrlKey || e.metaKey) {
        if (state.selected[uuid]) delete state.selected[uuid]; else state.selected[uuid] = true;
    } else {
        state.selected = {};
        state.selected[uuid] = true;
    }
    state.lastClicked = i;
    renderList();
    // Seleciona também no Illustrator, para ver qual é qual.
    evalHost("AutoPhysics_select(" + JSON.stringify(Object.keys(state.selected).join(",")) + ")", function () {});
});

els.selectAllBtn.addEventListener("click", function () {
    state.selected = {};
    state.objects.forEach(function (o) { state.selected[o.uuid] = true; });
    renderList();
    evalHost("AutoPhysics_select(" + JSON.stringify(uuids().join(",")) + ")", function () {});
});

function setSelectedProp(key, value) {
    selectedObjects().forEach(function (o) {
        o.props[key] = value;
        propsMemory[o.uuid] = o.props;
    });
    // Só o resumo das linhas muda: atualiza o texto sem recriar a lista.
    Array.prototype.forEach.call(els.objList.querySelectorAll(".obj-row"), function (row) {
        var o = state.objects[parseInt(row.getAttribute("data-index"), 10)];
        row.querySelector(".obj-meta").textContent = propsSummary(o.props);
    });
    markStale();
}

els.elasticity.addEventListener("input", function () {
    els.elasticityVal.value = els.elasticity.value;
    setSelectedProp("e", parseInt(els.elasticity.value, 10) / 100);
});
els.elasticityVal.addEventListener("change", function () {
    var v = parseNum(els.elasticityVal.value);
    if (isNaN(v)) return;
    v = Math.max(0, Math.min(100, v));
    setSelectedProp("e", v / 100);
    renderControls();
});
els.weight.addEventListener("input", function () {
    var w = Math.pow(10, parseFloat(els.weight.value));
    els.weightVal.value = fmt(w, 2);
    setSelectedProp("w", Math.round(w * 100) / 100);
});
els.weightVal.addEventListener("change", function () {
    var v = parseNum(els.weightVal.value);
    if (isNaN(v)) return;
    setSelectedProp("w", Math.max(0.1, Math.min(10, v)));
    renderControls();
});
els.offset.addEventListener("input", function () {
    var pt = parseFloat(els.offset.value);
    els.offsetVal.value = fmt(ptToUnit(pt), 2);
    setSelectedProp("o", pt);
});
els.offsetVal.addEventListener("change", function () {
    var v = parseNum(els.offsetVal.value);
    if (isNaN(v)) return;
    setSelectedProp("o", Math.max(-100, Math.min(100, unitToPt(v))));
    renderControls();
});

els.unitToggle.addEventListener("click", function (e) {
    if (e.target.tagName !== "BUTTON") return;
    Array.prototype.forEach.call(els.unitToggle.children, function (b) { b.classList.remove("active"); });
    e.target.classList.add("active");
    state.unit = e.target.getAttribute("data-unit");
    renderList();
});

// ===== mundo =====

function bindWorld(range, box, key, toValue, fromValue, decimals) {
    function show() {
        box.value = fmt(fromValue(state.world[key]), decimals);
        range.value = fromValue(state.world[key]);
        if (key === "gravity") els.gravityHint.textContent = fmtBR(9.81 * state.world.gravity, 1) + " m/s²";
    }
    range.addEventListener("input", function () {
        state.world[key] = toValue(parseFloat(range.value));
        show();
        markStale();
    });
    box.addEventListener("change", function () {
        var v = parseNum(box.value);
        if (isNaN(v)) { show(); return; }
        v = Math.max(parseFloat(range.min), Math.min(parseFloat(range.max), v));
        state.world[key] = toValue(v);
        show();
        markStale();
    });
    show();
}
function pct(v) { return v / 100; }
function toPct(v) { return Math.round(v * 100); }
function same(v) { return v; }
bindWorld(els.gravity, els.gravityVal, "gravity", pct, toPct, 0);
bindWorld(els.air, els.airVal, "air", pct, toPct, 0);
bindWorld(els.friction, els.frictionVal, "friction", pct, toPct, 0);
bindWorld(els.maxSeconds, els.maxSecondsVal, "maxSeconds", same, same, 1);

els.wallToggles.addEventListener("click", function (e) {
    if (e.target.tagName !== "BUTTON") return;
    var w = e.target.getAttribute("data-wall");
    state.world.walls[w] = !state.world.walls[w];
    e.target.classList.toggle("active", state.world.walls[w]);
    markStale();
});

function worldParams() {
    var w = state.world;
    return {
        gravity: w.gravity, air: w.air, friction: w.friction, maxSeconds: w.maxSeconds,
        walls: { floor: w.walls.floor, left: w.walls.sides, right: w.walls.sides, ceiling: w.walls.ceiling }
    };
}

// ===== capturar =====

function renderHeader(desc) {
    if (!state.objects.length) {
        els.objCount.textContent = "";
        els.abName.textContent = "Nenhum objeto capturado";
        els.abInfo.textContent = "Selecione os objetos que vão cair e clique em \"Capturar seleção\".";
        return;
    }
    els.objCount.textContent = state.objects.length + (state.objects.length === 1 ? " objeto" : " objetos");
    if (desc) {
        els.abName.textContent = desc.abName || "Prancheta " + (desc.abIndex + 1);
        els.abName.title = els.abName.textContent;
        var r = desc.abRect;
        els.abInfo.textContent = "Os objetos caem dentro desta prancheta (" +
            fmtBR(ptToUnit(Math.abs(r[2] - r[0])), 0) + " × " + fmtBR(ptToUnit(Math.abs(r[3] - r[1])), 0) + " " + state.unit + ").";
    }
}

els.captureBtn.addEventListener("click", function () {
    setBusy(true);
    setStatus("Lendo a seleção…");
    evalHost("AutoPhysics_capture()", function (text) {
        var desc = Bridge.parseDescription(text);
        if (desc.error) { fail(desc.error); return; }
        state.objects = desc.items.map(function (it) {
            return {
                uuid: it.uuid, name: it.name, typename: it.typename, color: it.color,
                props: propsMemory[it.uuid] || Bridge.parseProps(it.props)
            };
        });
        state.objects.forEach(function (o) { propsMemory[o.uuid] = o.props; });
        state.selected = {};
        state.objects.forEach(function (o) { state.selected[o.uuid] = true; });
        state.lastClicked = -1;
        state.sim = null;
        stopPlayback();
        els.previewWrap.classList.remove("visible");
        renderHeader(desc);
        renderList();
        setBusy(false);
        setStatus(state.objects.length + (state.objects.length === 1 ? " objeto capturado." : " objetos capturados.") + " Ajuste e clique em Simular.", "ok");
    });
});

// ===== simular =====
//
// Roda em fatias (setTimeout) para o painel não congelar numa simulação
// longa, mostrando o progresso.

els.simulateBtn.addEventListener("click", runSimulation);

function runSimulation() {
    if (!state.objects.length || state.busy) return;
    setBusy(true);
    stopPlayback();
    setStatus("Lendo a posição atual dos objetos…");
    evalHost("AutoPhysics_read(" + JSON.stringify(uuids().join(",")) + ")", function (text) {
        var desc = Bridge.parseDescription(text);
        if (desc.error) { fail(desc.error); return; }
        var present = {};
        desc.items.forEach(function (it) { present[it.uuid] = true; });
        var removed = state.objects.length - desc.items.length;
        if (removed > 0) state.objects = state.objects.filter(function (o) { return present[o.uuid]; });

        var propsBy = {};
        state.objects.forEach(function (o) { propsBy[o.uuid] = o.props; });
        var built = Bridge.buildScene(desc, propsBy);
        var skippedSet = {};
        built.skipped.forEach(function (s) { skippedSet[s.uuid] = s.reason; });
        if (!built.scene.items.length) {
            state.sim = null;
            renderList();
            fail("Nenhum objeto está sobre a prancheta \"" + desc.abName + "\" — eles precisam estar dentro dela na horizontal (podem começar acima dela).");
            return;
        }
        renderHeader(desc);

        var sim = new Physics.Simulation(built.scene, worldParams());
        var t0 = Date.now();
        (function chunk() {
            var done = sim.advance(250);
            if (!done) {
                setStatus("Simulando… " + Math.round(sim.progress() * 100) + "%");
                setTimeout(chunk, 0);
                return;
            }
            var result = sim.result();
            state.sim = {
                frame: built.frame, meta: built.meta, result: result,
                abIndex: desc.abIndex, skippedSet: skippedSet,
                finalBounds: null, stale: false
            };
            renderList();
            setBusy(false);
            var msg = result.settled
                ? "Assentou em " + fmtBR(result.duration, 1) + " s"
                : "Ainda em movimento no tempo máximo (" + fmtBR(result.duration, 1) + " s) — o estado final é esse instante";
            msg += " · calculado em " + fmtBR((Date.now() - t0) / 1000, 1) + " s.";
            var outCount = result.out.filter(Boolean).length;
            if (outCount) msg += " " + outCount + " objeto(s) saíram da prancheta.";
            if (built.skipped.length) msg += " " + built.skipped.length + " objeto(s) ficaram de fora (riscados na lista).";
            if (removed > 0) msg += " " + removed + " objeto(s) capturados não existem mais.";
            setStatus(msg, "ok");
            showPreview();
        })();
    });
}

// ===== prévia (formas de colisão, no painel) =====

var playback = { playing: false, start: 0, from: 0, raf: 0 };

function showPreview() {
    var res = state.sim.result;
    els.previewWrap.classList.add("visible");
    els.scrub.max = res.frames.length - 1;
    els.scrub.value = 0;
    startPlayback(0);
}

function drawPreview(fi) {
    var sim = state.sim;
    if (!sim) return;
    var res = sim.result, fr = sim.frame;
    var canvas = els.preview, dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var k = Math.min((cssW - 8) / fr.width, (cssH - 8) / fr.height);
    var ox = (cssW - fr.width * k) / 2, oy = (cssH - fr.height * k) / 2;
    ctx.fillStyle = "#f4f4f4";
    ctx.fillRect(ox, oy, fr.width * k, fr.height * k);

    // Paredes ativas em destaque.
    var w = state.world.walls;
    ctx.strokeStyle = "#4a9eff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (w.floor) { ctx.moveTo(ox, oy + fr.height * k); ctx.lineTo(ox + fr.width * k, oy + fr.height * k); }
    if (w.sides) {
        ctx.moveTo(ox, oy); ctx.lineTo(ox, oy + fr.height * k);
        ctx.moveTo(ox + fr.width * k, oy); ctx.lineTo(ox + fr.width * k, oy + fr.height * k);
    }
    if (w.ceiling) { ctx.moveTo(ox, oy); ctx.lineTo(ox + fr.width * k, oy); }
    ctx.stroke();

    var f = res.frames[fi];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cssW, cssH);
    ctx.clip();
    // De trás para a frente (a lista vem da seleção: frente primeiro).
    for (var i = res.bodies.length - 1; i >= 0; i--) {
        var b = res.bodies[i], col = sim.meta[i].color;
        ctx.save();
        ctx.translate(ox + f[i * 3] * k, oy + f[i * 3 + 1] * k);
        ctx.rotate(f[i * 3 + 2]);
        ctx.fillStyle = "rgba(" + col.join(",") + ",0.85)";
        ctx.strokeStyle = "rgba(" + col.map(function (c) { return Math.round(c * 0.6); }).join(",") + ",1)";
        ctx.beginPath();
        var o = b.outline;
        if (o.kind === "circle") {
            ctx.arc(0, 0, o.radius * k, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.stroke();
            // Raio marcado para dar para ver a bola girando.
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(o.radius * k, 0);
            ctx.stroke();
        } else {
            o.verts.forEach(function (v, j) {
                if (j === 0) ctx.moveTo(v.x * k, v.y * k); else ctx.lineTo(v.x * k, v.y * k);
            });
            ctx.closePath();
            // O offset positivo é um "raio" em volta do polígono: traço
            // grosso com cantos redondos desenha exatamente essa área.
            if (o.radius * k > 0.75) {
                ctx.lineJoin = "round";
                ctx.lineWidth = 2 * o.radius * k;
                ctx.strokeStyle = ctx.fillStyle;
                ctx.stroke();
            }
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(" + col.map(function (c) { return Math.round(c * 0.6); }).join(",") + ",1)";
            ctx.stroke();
        }
        ctx.restore();
    }
    ctx.restore();
    els.timeLabel.textContent = fmtBR(fi / res.hz, 2) + " s";
}

function startPlayback(fromFrame) {
    stopPlayback();
    var res = state.sim.result;
    if (fromFrame >= res.frames.length - 1) fromFrame = 0;
    playback.playing = true;
    playback.from = fromFrame;
    playback.start = performance.now();
    els.playBtn.textContent = "❚❚";
    (function tick(now) {
        if (!playback.playing || !state.sim) return;
        // O carimbo de tempo do requestAnimationFrame é o início do quadro e
        // pode vir um pouco ANTES do performance.now() guardado em start.
        var elapsed = Math.max(0, now - playback.start);
        var fi = Math.min(res.frames.length - 1, playback.from + Math.floor(elapsed / 1000 * res.hz));
        els.scrub.value = fi;
        drawPreview(fi);
        if (fi >= res.frames.length - 1) { stopPlayback(); return; }
        playback.raf = requestAnimationFrame(tick);
    })(playback.start);
}

function stopPlayback() {
    playback.playing = false;
    if (playback.raf) cancelAnimationFrame(playback.raf);
    playback.raf = 0;
    els.playBtn.textContent = "▶";
}

els.playBtn.addEventListener("click", function () {
    if (!state.sim) return;
    if (playback.playing) stopPlayback();
    else startPlayback(parseInt(els.scrub.value, 10));
});
els.scrub.addEventListener("input", function () {
    stopPlayback();
    drawPreview(parseInt(els.scrub.value, 10));
});
window.addEventListener("resize", function () {
    if (state.sim && !playback.playing) drawPreview(parseInt(els.scrub.value, 10));
});

// ===== aplicar estado final =====
//
// Só aplica se o documento ainda está exatamente como na simulação (confere
// os limites de cada objeto) — senão a física seria aplicada sobre posições
// que não são as que ela calculou.

els.applyBtn.addEventListener("click", function () {
    var sim = state.sim;
    if (!sim || sim.stale || state.busy) return;
    setBusy(true);
    setStatus("Aplicando…");
    currentPose(function (pose) {
        if (pose === "final") { setBusy(false); setStatus("O estado final já está aplicado.", "ok"); return; }
        if (pose !== "start") { fail("Os objetos mudaram desde a simulação — clique em Simular de novo."); return; }
        var spec = Bridge.buildApplySpec(sim, sim.result.frames.length - 1);
        evalHost("AutoPhysics_apply(" + JSON.stringify(spec) + ")", function (r) {
            if (r.indexOf("OK|") !== 0) { fail(r || "ERRO: o Illustrator não respondeu."); return; }
            sim.finalBounds = Bridge.parseBounds(r);
            setBusy(false);
            setStatus("Estado final aplicado. Ctrl+Z (Cmd+Z no Mac) volta tudo ao início, num passo só.", "ok");
        });
    });
});

function currentPose(cb) {
    var sim = state.sim;
    evalHost("AutoPhysics_bounds(" + JSON.stringify(sim.meta.map(function (m) { return m.uuid; }).join(",")) + ")", function (t) {
        var cur = Bridge.parseBounds(t);
        if (!cur) { fail(t || "ERRO: o Illustrator não respondeu."); return; }
        var pose = Bridge.detectPose(sim, cur);
        // Ctrl+Z depois de aplicar: o painel volta a saber que está no início.
        if (pose === "start" && sim.finalBounds) sim.finalBounds = null;
        refreshButtons();
        cb(pose);
    });
}

// ===== exportar GIF =====

els.gifBtn.addEventListener("click", function () {
    var sim = state.sim;
    if (!sim || sim.stale || state.busy) return;
    setBusy(true);
    setStatus("Conferindo os objetos…");
    currentPose(function (pose) {
        if (!pose) { fail("Os objetos mudaram desde a simulação — clique em Simular de novo."); return; }
        exportGif(sim, pose);
    });
});

function exportGif(sim, pose) {
    var fr = sim.frame;
    var opts = {
        width: parseInt(els.gifWidth.value, 10),
        fps: parseInt(els.gifFps.value, 10),
        speed: parseFloat(els.gifSpeed.value),
        hold: parseFloat(els.gifHold.value),
        loop: els.gifLoop.checked,
        background: els.gifBackground.value
    };
    var scale = opts.width / fr.width;              // px por pt
    var gifW = opts.width, gifH = Math.max(1, Math.round(fr.height * scale));
    if (gifH > 1600) { scale = 1600 / fr.height; gifH = 1600; gifW = Math.max(1, Math.round(fr.width * scale)); }
    // Sprites com o dobro da resolução: ficam nítidos mesmo girados.
    var spriteScale = Math.min(scale * 2, 7.7);

    setStatus("Exportando a aparência dos objetos do Illustrator…");
    var call = "AutoPhysics_exportSprites(" + [
        JSON.stringify(sim.meta.map(function (m) { return m.uuid; }).join(",")),
        sim.abIndex, scale * 100, spriteScale * 100, opts.background === "art" ? "true" : "false"
    ].join(",") + ")";
    evalHost(call, function (text) {
        var sp = Bridge.parseSprites(text);
        if (sp.error) { fail(sp.error); return; }
        loadImages(sp, function (err, bg, imgs) {
            evalHost("AutoPhysics_cleanup(" + JSON.stringify(sp.folder) + ")", function () {});
            if (err) { fail(err); return; }
            var sprites = sp.sprites.map(function (s, i) {
                var loc = Bridge.spriteLocal(sim, i, s.rect, pose);
                loc.img = imgs[i];
                return loc;
            });
            encodeFrames(sim, opts, gifW, gifH, gifW / fr.width, bg, sprites);
        });
    });
}

function loadImages(sp, cb) {
    var paths = sp.sprites.map(function (s) { return s.path; });
    if (sp.background) paths.push(sp.background);
    var imgs = [], pending = paths.length, failed = null;
    if (!pending) { cb(null, null, []); return; }
    paths.forEach(function (p, i) {
        var r = window.cep.fs.readFile(p, window.cep.encoding.Base64);
        if (r.err !== 0) { failed = "ERRO: não consegui ler o PNG exportado (" + p + ")."; done(); return; }
        var img = new Image();
        img.onload = done;
        img.onerror = function () { failed = "ERRO: PNG inválido (" + p + ")."; done(); };
        img.src = "data:image/png;base64," + r.data;
        imgs[i] = img;
    });
    function done() {
        if (--pending > 0) return;
        if (failed) { cb(failed); return; }
        var bg = sp.background ? imgs.pop() : null;
        cb(null, bg, imgs);
    }
}

function encodeFrames(sim, opts, gifW, gifH, k, bg, sprites) {
    var res = sim.result;
    var schedule = Bridge.gifFrameSchedule(res.duration, res.hz, opts.fps, opts.speed);
    var canvas = document.createElement("canvas");
    canvas.width = gifW;
    canvas.height = gifH;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    function compose(fi) {
        var f = res.frames[fi];
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, gifW, gifH);
        if (bg) ctx.drawImage(bg, 0, 0, gifW, gifH);
        // De trás para a frente: a seleção vem na ordem de empilhamento,
        // da frente para trás.
        for (var i = sprites.length - 1; i >= 0; i--) {
            var s = sprites[i];
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.translate(f[i * 3] * k, f[i * 3 + 1] * k);
            ctx.rotate(f[i * 3 + 2] - s.angle);
            ctx.drawImage(s.img, (s.x - s.cx) * k, (s.y - s.cy) * k, s.w * k, s.h * k);
        }
        return ctx.getImageData(0, 0, gifW, gifH).data;
    }

    // Paleta a partir de alguns quadros espalhados pela animação.
    setStatus("Montando a paleta de cores…");
    var palette = new Gif.Palette();
    var idx = schedule.indices;
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
        palette.addPixels(compose(idx[Math.round(t * (idx.length - 1))]), 2);
    });
    palette.build(Gif.MAX_COLORS);

    var enc = new Gif.GifEncoder(gifW, gifH, { loop: opts.loop });
    enc.setPalette(palette);
    var n = 0;
    (function chunk() {
        var t0 = Date.now();
        while (n < idx.length && Date.now() - t0 < 60) {
            enc.addFrame(compose(idx[n]), schedule.delayCs);
            n++;
        }
        if (n < idx.length) {
            setStatus("Gerando GIF… quadro " + n + " de " + idx.length);
            setTimeout(chunk, 0);
            return;
        }
        if (opts.hold > 0) enc.addFrame(compose(idx[idx.length - 1]), Math.round(opts.hold * 100));
        var bytes = enc.finish();
        saveGif(bytes, gifW, gifH, idx.length);
    })();
}

function saveGif(bytes, w, h, frames) {
    var fs = window.cep.fs;
    var chosen = fs.showSaveDialogEx("Salvar GIF", "", ["gif"], "AutoPhysics.gif");
    var target = chosen && chosen.data;
    if (!target) { setBusy(false); setStatus("Exportação cancelada.", ""); return; }
    if (!/\.gif$/i.test(target)) target += ".gif";
    var r = fs.writeFile(target, Gif.bytesToBase64(bytes), window.cep.encoding.Base64);
    setBusy(false);
    if (r.err !== 0) { setStatus("Não consegui gravar o arquivo (erro " + r.err + ").", "error"); return; }
    setStatus("GIF salvo: " + w + "×" + h + " px, " + frames + " quadros, " + fmtBR(bytes.length / 1024, 0) + " KB.", "ok");
}

// ===== inicialização =====

renderHeader(null);
renderList();
refreshButtons();
