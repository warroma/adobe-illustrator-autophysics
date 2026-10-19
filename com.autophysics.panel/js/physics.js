// AutoPhysics — motor de física 2D de corpo rígido, usado pelo painel.
//
// Roda inteiro no lado HTML do painel (Chromium do CEP), não no ExtendScript:
// a simulação são milhares de passos de aritmética, e o ExtendScript (ES3,
// interpretado, na thread principal do Illustrator) é lento demais para isso.
// O Illustrator só entra duas vezes: para ler a geometria dos objetos e para
// gravar o estado final (ver host.jsx).
//
// O solver segue o Box2D 2.4 de Erin Catto ("sequential impulses"):
//   - colisão por SAT entre polígonos convexos + círculos, gerando até 2
//     pontos de contato por par (recorte da aresta incidente na de referência);
//   - impulsos acumulados com clamp + warm starting (os impulsos do passo
//     anterior são reaplicados no começo do passo seguinte — é isso que deixa
//     uma pilha parada em vez de tremendo);
//   - restituição como "velocity bias" calculado UMA vez por passo, só acima de
//     uma velocidade mínima de impacto (abaixo dela o choque é inelástico, senão
//     nada nunca para de quicar);
//   - correção de penetração em posição (Gauss-Seidel não linear), separada da
//     velocidade, para não injetar energia.
// Referências: Catto, "Fast and Simple Physics using Sequential Impulses"
// (GDC 2006) e o código do Box2D 2.4 (b2CollidePolygon, b2ContactSolver).
//
// Unidades: a cena chega em pontos (pt), em coordenadas LOCAIS da prancheta
// com y para BAIXO (como um canvas). Internamente tudo é dividido por um
// tamanho de referência S (raiz da área média dos objetos), para que um objeto
// típico meça ~1 unidade — as tolerâncias do Box2D foram afinadas para essa
// escala e assim valem igual numa prancheta de ícone ou num pôster.
//
// Funciona como script comum no painel (define window.AutoPhysics) e como
// módulo no Node (os testes em test/autophysics usam module.exports).

(function (root) {
    "use strict";

    // ===== Ajustes do solver (em unidades internas) =====

    var LINEAR_SLOP = 0.005;            // penetração tolerada (evita tremer)
    var POLYGON_RADIUS = 0.5 * LINEAR_SLOP; // "pele" mínima dos polígonos
    var BAUMGARTE = 0.2;                // fração da penetração corrigida por iteração
    var MAX_LINEAR_CORRECTION = 0.2;
    var MAX_TRANSLATION = 2.0;          // por passo — trava contra explosões numéricas
    var MAX_ROTATION = 0.5 * Math.PI;
    var MAX_CONDITION_NUMBER = 1000;    // bloco 2x2 mal condicionado -> resolve 1 ponto
    var AABB_MARGIN = 0.1;
    var VELOCITY_ITERATIONS = 8;
    var POSITION_ITERATIONS = 3;
    var ROLLING_RESISTANCE = 0.02;      // círculos param de rolar (senão rolariam para sempre)

    var POLYGON = 1, CIRCLE = 2;
    var M_CIRCLES = 1, M_FACE_A = 2, M_FACE_B = 3;
    var F_VERTEX = 0, F_FACE = 1;

    // ===== Transformações =====
    // xf = { px, py, c, s }: rotação (cos, sen) seguida de translação.

    function makeXf(px, py, angle) {
        return { px: px, py: py, c: Math.cos(angle), s: Math.sin(angle) };
    }
    function mulXf(xf, x, y) {
        return { x: xf.c * x - xf.s * y + xf.px, y: xf.s * x + xf.c * y + xf.py };
    }
    function mulTXf(xf, x, y) {
        var dx = x - xf.px, dy = y - xf.py;
        return { x: xf.c * dx + xf.s * dy, y: -xf.s * dx + xf.c * dy };
    }
    function rot(xf, x, y) {
        return { x: xf.c * x - xf.s * y, y: xf.s * x + xf.c * y };
    }
    function rotT(xf, x, y) {
        return { x: xf.c * x + xf.s * y, y: -xf.s * x + xf.c * y };
    }
    // A^-1 * B — leva coordenadas do referencial de B para o de A.
    function mulTXfXf(A, B) {
        var p = rotT(A, B.px - A.px, B.py - A.py);
        return { px: p.x, py: p.y, c: A.c * B.c + A.s * B.s, s: A.c * B.s - A.s * B.c };
    }

    // ===== Formas =====

    // Polígono convexo com vértices em ordem anti-horária (área algébrica
    // positiva), já centrado no centroide. As normais (e.y, -e.x) apontam
    // para fora.
    function makePolygon(verts, radius) {
        var n = verts.length;
        var vs = [], ns = [];
        for (var i = 0; i < n; i++) {
            var a = verts[i], b = verts[(i + 1) % n];
            var ex = b.x - a.x, ey = b.y - a.y;
            var len = Math.sqrt(ex * ex + ey * ey) || 1;
            vs.push({ x: a.x, y: a.y });
            ns.push({ x: ey / len, y: -ex / len });
        }
        return { type: POLYGON, count: n, v: vs, n: ns, radius: radius };
    }

    function makeCircle(radius) {
        return { type: CIRCLE, px: 0, py: 0, radius: radius };
    }

    // ===== Colisão (port do Box2D 2.4) =====

    function featureKey(indexA, indexB, typeA, typeB) {
        return indexA | (indexB << 8) | (typeA << 16) | (typeB << 24);
    }
    function flipKey(key) {
        var iA = key & 255, iB = (key >> 8) & 255, tA = (key >> 16) & 255, tB = (key >> 24) & 255;
        return featureKey(iB, iA, tB, tA);
    }

    function emptyManifold() {
        return { type: 0, lnx: 0, lny: 0, lpx: 0, lpy: 0, pointCount: 0, points: [] };
    }

    function collideCircles(circleA, xfA, circleB, xfB) {
        var m = emptyManifold();
        var pA = mulXf(xfA, circleA.px, circleA.py);
        var pB = mulXf(xfB, circleB.px, circleB.py);
        var dx = pB.x - pA.x, dy = pB.y - pA.y;
        var r = circleA.radius + circleB.radius;
        if (dx * dx + dy * dy > r * r) return m;
        m.type = M_CIRCLES;
        m.lpx = circleA.px; m.lpy = circleA.py;
        m.pointCount = 1;
        m.points.push({ lx: circleB.px, ly: circleB.py, key: 0, ni: 0, ti: 0 });
        return m;
    }

    function collidePolygonAndCircle(polyA, xfA, circleB, xfB) {
        var m = emptyManifold();
        var c = mulXf(xfB, circleB.px, circleB.py);
        var cl = mulTXf(xfA, c.x, c.y);
        var normalIndex = 0, separation = -Infinity;
        var radius = polyA.radius + circleB.radius;
        var count = polyA.count, vs = polyA.v, ns = polyA.n;
        for (var i = 0; i < count; i++) {
            var s = ns[i].x * (cl.x - vs[i].x) + ns[i].y * (cl.y - vs[i].y);
            if (s > radius) return m;
            if (s > separation) { separation = s; normalIndex = i; }
        }
        var i1 = normalIndex, i2 = i1 + 1 < count ? i1 + 1 : 0;
        var v1 = vs[i1], v2 = vs[i2];
        m.type = M_FACE_A;
        m.pointCount = 1;
        m.points.push({ lx: circleB.px, ly: circleB.py, key: 0, ni: 0, ti: 0 });
        if (separation < 1e-9) {
            // Centro do círculo dentro do polígono.
            m.lnx = ns[normalIndex].x; m.lny = ns[normalIndex].y;
            m.lpx = 0.5 * (v1.x + v2.x); m.lpy = 0.5 * (v1.y + v2.y);
            return m;
        }
        var u1 = (cl.x - v1.x) * (v2.x - v1.x) + (cl.y - v1.y) * (v2.y - v1.y);
        var u2 = (cl.x - v2.x) * (v1.x - v2.x) + (cl.y - v2.y) * (v1.y - v2.y);
        var dx, dy, len;
        if (u1 <= 0 || u2 <= 0) {
            var v = u1 <= 0 ? v1 : v2;
            dx = cl.x - v.x; dy = cl.y - v.y;
            if (dx * dx + dy * dy > radius * radius) { m.pointCount = 0; m.points = []; m.type = 0; return m; }
            len = Math.sqrt(dx * dx + dy * dy) || 1;
            m.lnx = dx / len; m.lny = dy / len;
            m.lpx = v.x; m.lpy = v.y;
        } else {
            var fx = 0.5 * (v1.x + v2.x), fy = 0.5 * (v1.y + v2.y);
            var sep = (cl.x - fx) * ns[i1].x + (cl.y - fy) * ns[i1].y;
            if (sep > radius) { m.pointCount = 0; m.points = []; m.type = 0; return m; }
            m.lnx = ns[i1].x; m.lny = ns[i1].y;
            m.lpx = fx; m.lpy = fy;
        }
        return m;
    }

    // Maior separação entre as arestas de poly1 e os vértices de poly2.
    function findMaxSeparation(poly1, xf1, poly2, xf2) {
        var xf = mulTXfXf(xf2, xf1);
        var best = 0, maxSep = -Infinity;
        var v2s = poly2.v, count2 = poly2.count;
        for (var i = 0; i < poly1.count; i++) {
            var n = rot(xf, poly1.n[i].x, poly1.n[i].y);
            var v1 = mulXf(xf, poly1.v[i].x, poly1.v[i].y);
            var si = Infinity;
            for (var j = 0; j < count2; j++) {
                var sij = n.x * (v2s[j].x - v1.x) + n.y * (v2s[j].y - v1.y);
                if (sij < si) si = sij;
            }
            if (si > maxSep) { maxSep = si; best = i; }
        }
        return { edge: best, separation: maxSep };
    }

    function findIncidentEdge(poly1, xf1, edge1, poly2, xf2) {
        var n1w = rot(xf1, poly1.n[edge1].x, poly1.n[edge1].y);
        var n1 = rotT(xf2, n1w.x, n1w.y);
        var index = 0, minDot = Infinity;
        for (var i = 0; i < poly2.count; i++) {
            var d = n1.x * poly2.n[i].x + n1.y * poly2.n[i].y;
            if (d < minDot) { minDot = d; index = i; }
        }
        var i1 = index, i2 = i1 + 1 < poly2.count ? i1 + 1 : 0;
        var a = mulXf(xf2, poly2.v[i1].x, poly2.v[i1].y);
        var b = mulXf(xf2, poly2.v[i2].x, poly2.v[i2].y);
        return [
            { x: a.x, y: a.y, iA: edge1, iB: i1, tA: F_FACE, tB: F_VERTEX },
            { x: b.x, y: b.y, iA: edge1, iB: i2, tA: F_FACE, tB: F_VERTEX }
        ];
    }

    // Sutherland-Hodgman de um segmento contra um semiplano.
    function clipSegmentToLine(vIn, nx, ny, offset, vertexIndexA) {
        var out = [];
        var d0 = nx * vIn[0].x + ny * vIn[0].y - offset;
        var d1 = nx * vIn[1].x + ny * vIn[1].y - offset;
        if (d0 <= 0) out.push(vIn[0]);
        if (d1 <= 0) out.push(vIn[1]);
        if (d0 * d1 < 0) {
            var t = d0 / (d0 - d1);
            out.push({
                x: vIn[0].x + t * (vIn[1].x - vIn[0].x),
                y: vIn[0].y + t * (vIn[1].y - vIn[0].y),
                iA: vertexIndexA, iB: vIn[0].iB, tA: F_VERTEX, tB: F_FACE
            });
        }
        return out;
    }

    function collidePolygons(polyA, xfA, polyB, xfB) {
        var m = emptyManifold();
        var totalRadius = polyA.radius + polyB.radius;
        var sa = findMaxSeparation(polyA, xfA, polyB, xfB);
        if (sa.separation > totalRadius) return m;
        var sb = findMaxSeparation(polyB, xfB, polyA, xfA);
        if (sb.separation > totalRadius) return m;

        var poly1, poly2, xf1, xf2, edge1, flip;
        if (sb.separation > sa.separation + 0.1 * LINEAR_SLOP) {
            poly1 = polyB; poly2 = polyA; xf1 = xfB; xf2 = xfA; edge1 = sb.edge;
            m.type = M_FACE_B; flip = true;
        } else {
            poly1 = polyA; poly2 = polyB; xf1 = xfA; xf2 = xfB; edge1 = sa.edge;
            m.type = M_FACE_A; flip = false;
        }

        var incident = findIncidentEdge(poly1, xf1, edge1, poly2, xf2);
        var iv1 = edge1, iv2 = edge1 + 1 < poly1.count ? edge1 + 1 : 0;
        var v11 = poly1.v[iv1], v12 = poly1.v[iv2];
        var tx = v12.x - v11.x, ty = v12.y - v11.y;
        var tl = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= tl; ty /= tl;
        var lnx = ty, lny = -tx;
        var ppx = 0.5 * (v11.x + v12.x), ppy = 0.5 * (v11.y + v12.y);

        var t = rot(xf1, tx, ty);
        var nx = t.y, ny = -t.x;
        var w11 = mulXf(xf1, v11.x, v11.y), w12 = mulXf(xf1, v12.x, v12.y);
        var frontOffset = nx * w11.x + ny * w11.y;
        var sideOffset1 = -(t.x * w11.x + t.y * w11.y) + totalRadius;
        var sideOffset2 = (t.x * w12.x + t.y * w12.y) + totalRadius;

        var clip1 = clipSegmentToLine(incident, -t.x, -t.y, sideOffset1, iv1);
        if (clip1.length < 2) return m;
        var clip2 = clipSegmentToLine(clip1, t.x, t.y, sideOffset2, iv2);
        if (clip2.length < 2) return m;

        m.lnx = lnx; m.lny = lny; m.lpx = ppx; m.lpy = ppy;
        for (var i = 0; i < 2; i++) {
            var sep = nx * clip2[i].x + ny * clip2[i].y - frontOffset;
            if (sep <= totalRadius) {
                var lp = mulTXf(xf2, clip2[i].x, clip2[i].y);
                var key = featureKey(clip2[i].iA, clip2[i].iB, clip2[i].tA, clip2[i].tB);
                m.points.push({ lx: lp.x, ly: lp.y, key: flip ? flipKey(key) : key, ni: 0, ti: 0 });
            }
        }
        m.pointCount = m.points.length;
        if (m.pointCount === 0) m.type = 0;
        return m;
    }

    // Pontos de contato e normal em coordenadas do mundo (b2WorldManifold).
    function worldManifold(m, xfA, radiusA, xfB, radiusB) {
        var out = { nx: 1, ny: 0, px: [], py: [], sep: [] };
        var i, cp, clip, cAx, cAy, cBx, cBy, d;
        if (m.type === M_CIRCLES) {
            var pA = mulXf(xfA, m.lpx, m.lpy);
            var pB = mulXf(xfB, m.points[0].lx, m.points[0].ly);
            var dx = pB.x - pA.x, dy = pB.y - pA.y, dl = Math.sqrt(dx * dx + dy * dy);
            if (dl > 1e-9) { out.nx = dx / dl; out.ny = dy / dl; }
            cAx = pA.x + radiusA * out.nx; cAy = pA.y + radiusA * out.ny;
            cBx = pB.x - radiusB * out.nx; cBy = pB.y - radiusB * out.ny;
            out.px.push(0.5 * (cAx + cBx)); out.py.push(0.5 * (cAy + cBy));
            out.sep.push((cBx - cAx) * out.nx + (cBy - cAy) * out.ny);
        } else if (m.type === M_FACE_A) {
            var n = rot(xfA, m.lnx, m.lny);
            var plane = mulXf(xfA, m.lpx, m.lpy);
            out.nx = n.x; out.ny = n.y;
            for (i = 0; i < m.pointCount; i++) {
                cp = m.points[i];
                clip = mulXf(xfB, cp.lx, cp.ly);
                d = (clip.x - plane.x) * n.x + (clip.y - plane.y) * n.y;
                cAx = clip.x + (radiusA - d) * n.x; cAy = clip.y + (radiusA - d) * n.y;
                cBx = clip.x - radiusB * n.x; cBy = clip.y - radiusB * n.y;
                out.px.push(0.5 * (cAx + cBx)); out.py.push(0.5 * (cAy + cBy));
                out.sep.push((cBx - cAx) * n.x + (cBy - cAy) * n.y);
            }
        } else if (m.type === M_FACE_B) {
            var nb = rot(xfB, m.lnx, m.lny);
            var planeB = mulXf(xfB, m.lpx, m.lpy);
            for (i = 0; i < m.pointCount; i++) {
                cp = m.points[i];
                clip = mulXf(xfA, cp.lx, cp.ly);
                d = (clip.x - planeB.x) * nb.x + (clip.y - planeB.y) * nb.y;
                cBx = clip.x + (radiusB - d) * nb.x; cBy = clip.y + (radiusB - d) * nb.y;
                cAx = clip.x - radiusA * nb.x; cAy = clip.y - radiusA * nb.y;
                out.px.push(0.5 * (cAx + cBx)); out.py.push(0.5 * (cAy + cBy));
                out.sep.push((cAx - cBx) * nb.x + (cAy - cBy) * nb.y);
            }
            out.nx = -nb.x; out.ny = -nb.y;
        }
        return out;
    }

    // ===== Corpos =====

    // Um corpo rígido pode ter várias formas convexas presas a ele (as
    // "fixtures" do Box2D) — é assim que uma letra côncava como "u" colide pelo
    // desenho de verdade: várias peças convexas que se movem juntas.
    function Body(def) {
        this.shapes = def.shapes || [def.shape];
        this.isStatic = !!def.isStatic;
        this.cx = def.x; this.cy = def.y; this.a = def.angle || 0;
        this.vx = 0; this.vy = 0; this.w = 0;
        this.restitution = def.restitution || 0;
        this.friction = def.friction === undefined ? 0.5 : def.friction;
        this.linearDamping = def.linearDamping || 0;
        this.angularDamping = def.angularDamping || 0;
        this.mass = this.isStatic ? 0 : def.mass;
        this.invMass = this.isStatic || !(def.mass > 0) ? 0 : 1 / def.mass;
        this.I = this.isStatic ? 0 : def.inertia;
        this.invI = this.isStatic || !(def.inertia > 0) ? 0 : 1 / def.inertia;
        this.frozen = false;
        this.index = -1;
        this.xf = makeXf(this.cx, this.cy, this.a);
        this.aabb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        this.updateAABB();
    }

    Body.prototype.syncXf = function () {
        this.xf = makeXf(this.cx, this.cy, this.a);
    };

    // Caixa de cada forma (para o narrowphase descartar pares de peças que nem
    // se tocam) e a do corpo inteiro (para o broadphase).
    Body.prototype.updateAABB = function () {
        var b = this.aabb;
        b.minX = Infinity; b.minY = Infinity; b.maxX = -Infinity; b.maxY = -Infinity;
        for (var k = 0; k < this.shapes.length; k++) {
            var s = this.shapes[k], r = s.radius + AABB_MARGIN;
            var sb = s.aabb || (s.aabb = { minX: 0, minY: 0, maxX: 0, maxY: 0 });
            if (s.type === CIRCLE) {
                var c = mulXf(this.xf, s.px, s.py);
                sb.minX = c.x - r; sb.maxX = c.x + r; sb.minY = c.y - r; sb.maxY = c.y + r;
            } else {
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (var i = 0; i < s.count; i++) {
                    var p = mulXf(this.xf, s.v[i].x, s.v[i].y);
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                }
                sb.minX = minX - r; sb.maxX = maxX + r; sb.minY = minY - r; sb.maxY = maxY + r;
            }
            if (sb.minX < b.minX) b.minX = sb.minX;
            if (sb.minY < b.minY) b.minY = sb.minY;
            if (sb.maxX > b.maxX) b.maxX = sb.maxX;
            if (sb.maxY > b.maxY) b.maxY = sb.maxY;
        }
    };

    // Maior distância do centro de massa até a borda (para medir giro).
    Body.prototype.reach = function () {
        if (this.br !== undefined) return this.br;
        var r = 0;
        for (var k = 0; k < this.shapes.length; k++) {
            var s = this.shapes[k];
            if (s.type === CIRCLE) {
                r = Math.max(r, Math.sqrt(s.px * s.px + s.py * s.py) + s.radius);
                continue;
            }
            for (var i = 0; i < s.count; i++) r = Math.max(r, Math.sqrt(s.v[i].x * s.v[i].x + s.v[i].y * s.v[i].y) + s.radius);
        }
        this.br = r;
        return r;
    };

    // ===== Mundo =====

    function World(opts) {
        this.gx = opts.gravityX || 0;
        this.gy = opts.gravityY || 0;
        this.velocityThreshold = opts.velocityThreshold || 1;
        this.bodies = [];
        this.contacts = {};
        this.order = [];
        this.stamp = 0;
        this.nextShapeId = 1;
    }

    World.prototype.addBody = function (def) {
        var b = new Body(def);
        for (var k = 0; k < b.shapes.length; k++) b.shapes[k].id = this.nextShapeId++;
        b.index = this.bodies.length;
        this.bodies.push(b);
        this.order.push(b.index);
        return b;
    };

    function collide(sA, xfA, sB, xfB) {
        if (sA.type === CIRCLE && sB.type === CIRCLE) return collideCircles(sA, xfA, sB, xfB);
        if (sA.type === POLYGON && sB.type === CIRCLE) return collidePolygonAndCircle(sA, xfA, sB, xfB);
        return collidePolygons(sA, xfA, sB, xfB);
    }

    function boxesOverlap(p, q) {
        return p.minX <= q.maxX && q.minX <= p.maxX && p.minY <= q.maxY && q.minY <= p.maxY;
    }

    // Broadphase "sort and sweep" no eixo x (a ordem do passo anterior quase
    // não muda, então a ordenação por inserção é praticamente linear) + o
    // narrowphase de cada par de PEÇAS dos dois corpos. Contatos que continuam
    // existindo herdam os impulsos do passo anterior pelo id da feature
    // (warm starting).
    World.prototype.updateContacts = function () {
        var bodies = this.bodies, order = this.order, i, j;
        for (i = 1; i < order.length; i++) {
            var cur = order[i], key = bodies[cur].aabb.minX;
            for (j = i - 1; j >= 0 && bodies[order[j]].aabb.minX > key; j--) order[j + 1] = order[j];
            order[j + 1] = cur;
        }
        var stamp = ++this.stamp;
        var contacts = this.contacts;
        for (i = 0; i < order.length; i++) {
            var a = bodies[order[i]];
            if (a.frozen) continue;
            for (j = i + 1; j < order.length; j++) {
                var b = bodies[order[j]];
                if (b.aabb.minX > a.aabb.maxX) break;
                if (b.frozen || (a.isStatic && b.isStatic)) continue;
                if (b.aabb.minY > a.aabb.maxY || b.aabb.maxY < a.aabb.minY) continue;

                for (var ia = 0; ia < a.shapes.length; ia++) {
                    for (var ib = 0; ib < b.shapes.length; ib++) {
                        if (!boxesOverlap(a.shapes[ia].aabb, b.shapes[ib].aabb)) continue;
                        this.touch(a, a.shapes[ia], b, b.shapes[ib], stamp);
                    }
                }
            }
        }
        var list = [];
        for (var k in contacts) {
            if (contacts[k].stamp !== stamp) delete contacts[k];
            else list.push(contacts[k]);
        }
        return list;
    };

    // Narrowphase de um par de peças (de corpos diferentes).
    World.prototype.touch = function (a, sa, b, sb, stamp) {
        // Polígono sempre como A no par polígono x círculo.
        var A = a, B = b, sA = sa, sB = sb;
        if ((sA.type === CIRCLE && sB.type === POLYGON) || (sA.type === sB.type && sA.id > sB.id)) {
            A = b; B = a; sA = sb; sB = sa;
        }
        var key = sA.id * 1048576 + sB.id;
        var m = collide(sA, A.xf, sB, B.xf);
        if (m.pointCount === 0) return;
        var c = this.contacts[key];
        if (c) {
            for (var p = 0; p < m.pointCount; p++) {
                for (var q = 0; q < c.manifold.pointCount; q++) {
                    if (c.manifold.points[q].key === m.points[p].key) {
                        m.points[p].ni = c.manifold.points[q].ni;
                        m.points[p].ti = c.manifold.points[q].ti;
                        break;
                    }
                }
            }
        } else {
            c = this.contacts[key] = {
                a: A, b: B, sa: sA, sb: sB,
                friction: Math.sqrt(A.friction * B.friction),
                restitution: Math.max(A.restitution, B.restitution),
                rolling: rollingResistance(sA, sB),
                rollingImpulse: 0
            };
        }
        c.manifold = m;
        c.stamp = stamp;
    };

    // Só pares com círculo: sem isso uma bola rola para sempre no chão.
    function rollingResistance(sA, sB) {
        var r = 0;
        if (sA.type === CIRCLE) r = Math.max(r, sA.radius);
        if (sB.type === CIRCLE) r = Math.max(r, sB.radius);
        return ROLLING_RESISTANCE * r;
    }

    function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

    World.prototype.initVelocityConstraints = function (list) {
        var vcs = [];
        for (var ci = 0; ci < list.length; ci++) {
            var c = list[ci], A = c.a, B = c.b, m = c.manifold;
            var wm = worldManifold(m, A.xf, c.sa.radius, B.xf, c.sb.radius);
            var mA = A.invMass, mB = B.invMass, iA = A.invI, iB = B.invI;
            var nx = wm.nx, ny = wm.ny, tx = ny, ty = -nx;
            var vc = {
                c: c, A: A, B: B, nx: nx, ny: ny, friction: c.friction,
                points: [], pointCount: m.pointCount, K: null, normalMass: null,
                rollingMass: (iA + iB) > 0 ? 1 / (iA + iB) : 0
            };
            for (var j = 0; j < m.pointCount; j++) {
                var cp = m.points[j];
                var rAx = wm.px[j] - A.cx, rAy = wm.py[j] - A.cy;
                var rBx = wm.px[j] - B.cx, rBy = wm.py[j] - B.cy;
                var rnA = cross(rAx, rAy, nx, ny), rnB = cross(rBx, rBy, nx, ny);
                var kN = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
                var rtA = cross(rAx, rAy, tx, ty), rtB = cross(rBx, rBy, tx, ty);
                var kT = mA + mB + iA * rtA * rtA + iB * rtB * rtB;
                var dvx = B.vx - B.w * rBy - A.vx + A.w * rAy;
                var dvy = B.vy + B.w * rBx - A.vy - A.w * rAx;
                var vRel = nx * dvx + ny * dvy;
                vc.points.push({
                    cp: cp, rAx: rAx, rAy: rAy, rBx: rBx, rBy: rBy,
                    ni: cp.ni, ti: cp.ti,
                    normalMass: kN > 0 ? 1 / kN : 0,
                    tangentMass: kT > 0 ? 1 / kT : 0,
                    bias: vRel < -this.velocityThreshold ? -c.restitution * vRel : 0
                });
            }
            if (vc.pointCount === 2) {
                var p1 = vc.points[0], p2 = vc.points[1];
                var rn1A = cross(p1.rAx, p1.rAy, nx, ny), rn1B = cross(p1.rBx, p1.rBy, nx, ny);
                var rn2A = cross(p2.rAx, p2.rAy, nx, ny), rn2B = cross(p2.rBx, p2.rBy, nx, ny);
                var k11 = mA + mB + iA * rn1A * rn1A + iB * rn1B * rn1B;
                var k22 = mA + mB + iA * rn2A * rn2A + iB * rn2B * rn2B;
                var k12 = mA + mB + iA * rn1A * rn2A + iB * rn1B * rn2B;
                var det = k11 * k22 - k12 * k12;
                if (k11 * k11 < MAX_CONDITION_NUMBER * det) {
                    vc.K = [k11, k12, k22];
                    var inv = det !== 0 ? 1 / det : 0;
                    vc.normalMass = [inv * k22, -inv * k12, inv * k11];
                } else {
                    vc.pointCount = 1; // pontos quase coincidentes: resolve um só
                }
            }
            vcs.push(vc);
        }
        return vcs;
    };

    function applyImpulse(vc, p, Px, Py) {
        var A = vc.A, B = vc.B;
        A.vx -= A.invMass * Px; A.vy -= A.invMass * Py;
        A.w -= A.invI * cross(p.rAx, p.rAy, Px, Py);
        B.vx += B.invMass * Px; B.vy += B.invMass * Py;
        B.w += B.invI * cross(p.rBx, p.rBy, Px, Py);
    }

    function warmStart(vcs) {
        for (var i = 0; i < vcs.length; i++) {
            var vc = vcs[i], tx = vc.ny, ty = -vc.nx;
            for (var j = 0; j < vc.pointCount; j++) {
                var p = vc.points[j];
                applyImpulse(vc, p, p.ni * vc.nx + p.ti * tx, p.ni * vc.ny + p.ti * ty);
            }
            if (vc.c.rolling > 0) {
                vc.A.w -= vc.A.invI * vc.c.rollingImpulse;
                vc.B.w += vc.B.invI * vc.c.rollingImpulse;
            }
        }
    }

    function relVel(vc, p) {
        var A = vc.A, B = vc.B;
        return {
            x: B.vx - B.w * p.rBy - A.vx + A.w * p.rAy,
            y: B.vy + B.w * p.rBx - A.vy - A.w * p.rAx
        };
    }

    function solveVelocity(vcs) {
        for (var i = 0; i < vcs.length; i++) {
            var vc = vcs[i], A = vc.A, B = vc.B;
            var nx = vc.nx, ny = vc.ny, tx = ny, ty = -nx;
            var j, p, dv, lambda, newImpulse;

            // Atrito primeiro (Coulomb: limitado por atrito x impulso normal).
            for (j = 0; j < vc.pointCount; j++) {
                p = vc.points[j];
                dv = relVel(vc, p);
                lambda = p.tangentMass * -(dv.x * tx + dv.y * ty);
                var maxF = vc.friction * p.ni;
                newImpulse = Math.max(-maxF, Math.min(p.ti + lambda, maxF));
                lambda = newImpulse - p.ti;
                p.ti = newImpulse;
                applyImpulse(vc, p, lambda * tx, lambda * ty);
            }

            // Resistência ao rolamento (círculos), limitada pelo impulso normal.
            if (vc.c.rolling > 0) {
                var totalN = 0;
                for (j = 0; j < vc.pointCount; j++) totalN += vc.points[j].ni;
                var maxR = vc.c.rolling * totalN;
                var dl = -vc.rollingMass * (B.w - A.w);
                var old = vc.c.rollingImpulse;
                vc.c.rollingImpulse = Math.max(-maxR, Math.min(old + dl, maxR));
                dl = vc.c.rollingImpulse - old;
                A.w -= A.invI * dl;
                B.w += B.invI * dl;
            }

            if (vc.pointCount === 1) {
                p = vc.points[0];
                dv = relVel(vc, p);
                lambda = -p.normalMass * (dv.x * nx + dv.y * ny - p.bias);
                newImpulse = Math.max(p.ni + lambda, 0);
                lambda = newImpulse - p.ni;
                p.ni = newImpulse;
                applyImpulse(vc, p, lambda * nx, lambda * ny);
                continue;
            }

            // Solver em bloco para 2 pontos (LCP 2x2 por enumeração dos 4
            // casos, como no Box2D) — é o que mantém caixas empilhadas sem
            // balançar de um canto para o outro.
            var p1 = vc.points[0], p2 = vc.points[1];
            var ax = p1.ni, ay = p2.ni;
            var dv1 = relVel(vc, p1), dv2 = relVel(vc, p2);
            var vn1 = dv1.x * nx + dv1.y * ny, vn2 = dv2.x * nx + dv2.y * ny;
            var K = vc.K, M = vc.normalMass;
            var bx = vn1 - p1.bias - (K[0] * ax + K[1] * ay);
            var by = vn2 - p2.bias - (K[1] * ax + K[2] * ay);
            var xx, xy;
            for (;;) {
                xx = -(M[0] * bx + M[1] * by);
                xy = -(M[1] * bx + M[2] * by);
                if (xx >= 0 && xy >= 0) break;
                xx = -p1.normalMass * bx; xy = 0;
                vn2 = K[1] * xx + by;
                if (xx >= 0 && vn2 >= 0) break;
                xx = 0; xy = -p2.normalMass * by;
                vn1 = K[1] * xy + bx;
                if (xy >= 0 && vn1 >= 0) break;
                xx = 0; xy = 0;
                if (bx >= 0 && by >= 0) break;
                xx = ax; xy = ay; // sem solução: mantém
                break;
            }
            var d1 = xx - ax, d2 = xy - ay;
            applyImpulse(vc, p1, d1 * nx, d1 * ny);
            applyImpulse(vc, p2, d2 * nx, d2 * ny);
            p1.ni = xx; p2.ni = xy;
        }
    }

    function storeImpulses(vcs) {
        for (var i = 0; i < vcs.length; i++) {
            var vc = vcs[i];
            for (var j = 0; j < vc.points.length; j++) {
                vc.points[j].cp.ni = vc.points[j].ni;
                vc.points[j].cp.ti = vc.points[j].ti;
            }
        }
    }

    // Correção de penetração direto nas posições (b2PositionSolverManifold).
    function solvePositions(list) {
        var minSep = 0;
        for (var ci = 0; ci < list.length; ci++) {
            var c = list[ci], A = c.a, B = c.b, m = c.manifold;
            var mA = A.invMass, mB = B.invMass, iA = A.invI, iB = B.invI;
            var rA = c.sa.radius, rB = c.sb.radius;
            for (var j = 0; j < m.pointCount; j++) {
                var xfA = makeXf(A.cx, A.cy, A.a), xfB = makeXf(B.cx, B.cy, B.a);
                var nx, ny, px, py, sep;
                if (m.type === M_CIRCLES) {
                    var pA = mulXf(xfA, m.lpx, m.lpy), pB = mulXf(xfB, m.points[0].lx, m.points[0].ly);
                    nx = pB.x - pA.x; ny = pB.y - pA.y;
                    var l = Math.sqrt(nx * nx + ny * ny);
                    if (l > 1e-9) { nx /= l; ny /= l; } else { nx = 1; ny = 0; }
                    px = 0.5 * (pA.x + pB.x); py = 0.5 * (pA.y + pB.y);
                    sep = (pB.x - pA.x) * nx + (pB.y - pA.y) * ny - rA - rB;
                } else if (m.type === M_FACE_A) {
                    var n = rot(xfA, m.lnx, m.lny), plane = mulXf(xfA, m.lpx, m.lpy);
                    var clip = mulXf(xfB, m.points[j].lx, m.points[j].ly);
                    nx = n.x; ny = n.y;
                    sep = (clip.x - plane.x) * nx + (clip.y - plane.y) * ny - rA - rB;
                    px = clip.x; py = clip.y;
                } else {
                    var nb = rot(xfB, m.lnx, m.lny), planeB = mulXf(xfB, m.lpx, m.lpy);
                    var clipA = mulXf(xfA, m.points[j].lx, m.points[j].ly);
                    sep = (clipA.x - planeB.x) * nb.x + (clipA.y - planeB.y) * nb.y - rA - rB;
                    px = clipA.x; py = clipA.y;
                    nx = -nb.x; ny = -nb.y;
                }
                var rAx = px - A.cx, rAy = py - A.cy, rBx = px - B.cx, rBy = py - B.cy;
                if (sep < minSep) minSep = sep;
                var C = Math.max(-MAX_LINEAR_CORRECTION, Math.min(BAUMGARTE * (sep + LINEAR_SLOP), 0));
                var rnA = cross(rAx, rAy, nx, ny), rnB = cross(rBx, rBy, nx, ny);
                var K = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
                var impulse = K > 0 ? -C / K : 0;
                var Px = impulse * nx, Py = impulse * ny;
                A.cx -= mA * Px; A.cy -= mA * Py; A.a -= iA * cross(rAx, rAy, Px, Py);
                B.cx += mB * Px; B.cy += mB * Py; B.a += iB * cross(rBx, rBy, Px, Py);
            }
        }
        return minSep >= -3 * LINEAR_SLOP;
    }

    World.prototype.step = function (h) {
        var bodies = this.bodies, i, b;
        var list = this.updateContacts();

        for (i = 0; i < bodies.length; i++) {
            b = bodies[i];
            if (b.isStatic || b.frozen) continue;
            b.vx = (b.vx + h * this.gx) / (1 + h * b.linearDamping);
            b.vy = (b.vy + h * this.gy) / (1 + h * b.linearDamping);
            b.w = b.w / (1 + h * b.angularDamping);
        }

        var vcs = this.initVelocityConstraints(list);
        warmStart(vcs);
        for (i = 0; i < VELOCITY_ITERATIONS; i++) solveVelocity(vcs);
        storeImpulses(vcs);

        for (i = 0; i < bodies.length; i++) {
            b = bodies[i];
            if (b.isStatic || b.frozen) continue;
            var tx = h * b.vx, ty = h * b.vy;
            var t2 = tx * tx + ty * ty;
            if (t2 > MAX_TRANSLATION * MAX_TRANSLATION) {
                var k = MAX_TRANSLATION / Math.sqrt(t2);
                b.vx *= k; b.vy *= k;
            }
            var ra = h * b.w;
            if (ra * ra > MAX_ROTATION * MAX_ROTATION) b.w *= MAX_ROTATION / Math.abs(ra);
            b.cx += h * b.vx; b.cy += h * b.vy; b.a += h * b.w;
        }

        for (i = 0; i < POSITION_ITERATIONS; i++) {
            if (solvePositions(list)) break;
        }

        for (i = 0; i < bodies.length; i++) {
            b = bodies[i];
            if (b.isStatic) continue;
            b.syncXf();
            b.updateAABB();
        }
    };

    // ===== Geometria: do contorno do Illustrator até a forma de colisão =====

    // paths: [{ closed, pts: [ax, ay, lx, ly, rx, ry, ...] }] — âncora + alças
    // esquerda/direita de cada ponto, como o Illustrator guarda. Amostra cada
    // trecho bezier em "steps" partes.
    function sampleBezierPaths(paths, steps) {
        var out = [];
        steps = steps || 8;
        for (var pi = 0; pi < paths.length; pi++) {
            var pts = paths[pi].pts, n = Math.floor(pts.length / 6);
            for (var i = 0; i < n; i++) {
                var o = i * 6;
                out.push({ x: pts[o], y: pts[o + 1] });
                if (n < 2 || (i === n - 1 && !paths[pi].closed)) continue;
                var q = ((i + 1) % n) * 6;
                var x0 = pts[o], y0 = pts[o + 1], x1 = pts[o + 4], y1 = pts[o + 5];
                var x2 = pts[q + 2], y2 = pts[q + 3], x3 = pts[q], y3 = pts[q + 1];
                if (Math.abs(x1 - x0) + Math.abs(y1 - y0) + Math.abs(x2 - x3) + Math.abs(y2 - y3) < 1e-6) continue;
                for (var s = 1; s < steps; s++) {
                    var t = s / steps, u = 1 - t;
                    var a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
                    out.push({ x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 });
                }
            }
        }
        return out;
    }

    // Envoltória convexa (cadeia monótona de Andrew), anti-horária, sem
    // pontos colineares.
    function convexHull(points) {
        var pts = points.slice().sort(function (p, q) { return p.x === q.x ? p.y - q.y : p.x - q.x; });
        if (pts.length < 3) return pts;
        function turn(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
        var lower = [], upper = [], i;
        for (i = 0; i < pts.length; i++) {
            while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
            lower.push(pts[i]);
        }
        for (i = pts.length - 1; i >= 0; i--) {
            while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
            upper.push(pts[i]);
        }
        lower.pop(); upper.pop();
        return lower.concat(upper);
    }

    function polygonArea(vs) {
        var a = 0;
        for (var i = 0; i < vs.length; i++) {
            var p = vs[i], q = vs[(i + 1) % vs.length];
            a += p.x * q.y - q.x * p.y;
        }
        return 0.5 * a;
    }

    // Centroide e momento de inércia (densidade 1, em torno do centroide).
    function polygonMassData(vs) {
        var sx = vs[0].x, sy = vs[0].y;
        var area = 0, cx = 0, cy = 0, I = 0;
        for (var i = 0; i < vs.length; i++) {
            var p = vs[i], q = vs[(i + 1) % vs.length];
            var e1x = p.x - sx, e1y = p.y - sy, e2x = q.x - sx, e2y = q.y - sy;
            var D = e1x * e2y - e1y * e2x;
            var tri = 0.5 * D;
            area += tri;
            cx += tri * (e1x + e2x) / 3;
            cy += tri * (e1y + e2y) / 3;
            var intx2 = e1x * e1x + e2x * e1x + e2x * e2x;
            var inty2 = e1y * e1y + e2y * e1y + e2y * e2y;
            I += (0.25 / 3 * D) * (intx2 + inty2);
        }
        cx /= area; cy /= area;
        return { area: area, cx: cx + sx, cy: cy + sy, I: I - area * (cx * cx + cy * cy) };
    }

    // Reduz a envoltória a no máximo maxCount vértices tirando, um a um, o
    // vértice que menos área "corta" (Visvalingam). Num polígono convexo isso
    // continua convexo e só arredonda cantos de forma imperceptível.
    function simplifyHull(vs, maxCount, minEdge) {
        vs = vs.slice();
        function triArea(i) {
            var a = vs[(i - 1 + vs.length) % vs.length], b = vs[i], c = vs[(i + 1) % vs.length];
            return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        }
        var i;
        for (i = vs.length - 1; i >= 0 && vs.length > 3; i--) {
            var n = vs[(i + 1) % vs.length];
            if (Math.abs(vs[i].x - n.x) + Math.abs(vs[i].y - n.y) < minEdge) vs.splice(i, 1);
        }
        while (vs.length > maxCount) {
            var best = 0, bestA = Infinity;
            for (i = 0; i < vs.length; i++) {
                var ar = triArea(i);
                if (ar < bestA) { bestA = ar; best = i; }
            }
            vs.splice(best, 1);
        }
        return vs;
    }

    function clipPolygonHalfPlane(vs, nx, ny, d) {
        var out = [];
        for (var i = 0; i < vs.length; i++) {
            var p = vs[i], q = vs[(i + 1) % vs.length];
            var dp = nx * p.x + ny * p.y - d, dq = nx * q.x + ny * q.y - d;
            if (dp <= 0) out.push(p);
            if (dp * dq < 0) {
                var t = dp / (dp - dq);
                out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
            }
        }
        return out;
    }

    // Offset negativo: empurra cada aresta para dentro e recorta (interseção
    // de semiplanos). Se o polígono sumir, tenta um recuo menor.
    function insetConvex(vs, dist) {
        var area0 = polygonArea(vs);
        for (var attempt = 0; attempt < 12; attempt++) {
            var poly = vs.slice();
            for (var i = 0; i < vs.length && poly.length >= 3; i++) {
                var a = vs[i], b = vs[(i + 1) % vs.length];
                var ex = b.x - a.x, ey = b.y - a.y, len = Math.sqrt(ex * ex + ey * ey);
                if (len < 1e-9) continue;
                var nx = ey / len, ny = -ex / len;
                poly = clipPolygonHalfPlane(poly, nx, ny, nx * a.x + ny * a.y - dist);
            }
            if (poly.length >= 3 && polygonArea(poly) > 0.1 * area0) return { verts: poly, inset: dist };
            dist *= 0.7;
        }
        return { verts: vs, inset: 0 };
    }

    // Círculo se TODOS os pontos da envoltória estão (quase) à mesma distância
    // do centroide — bolas rolam de verdade em vez de virar um polígono de 32 lados.
    function detectCircle(hull) {
        if (hull.length < 12) return null;
        var md = polygonMassData(hull);
        var min = Infinity, max = 0, sum = 0;
        for (var i = 0; i < hull.length; i++) {
            var dx = hull[i].x - md.cx, dy = hull[i].y - md.cy, d = Math.sqrt(dx * dx + dy * dy);
            if (d < min) min = d;
            if (d > max) max = d;
            sum += d;
        }
        var mean = sum / hull.length;
        if (mean > 0 && (max - min) / mean < 0.02) return { cx: md.cx, cy: md.cy, r: mean };
        return null;
    }

    // ----- decomposição convexa (para formas côncavas como "u", "h", "C") -----

    function turn(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

    function dist2(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

    // Cada subcaminho amostrado separado (um "O" tem dois: fora e miolo).
    function sampleSubpaths(paths, steps) {
        return paths.map(function (p) {
            return { closed: p.closed, pts: sampleBezierPaths([p], steps) };
        });
    }

    // Douglas-Peucker: tira pontos que se desviam menos de "tol" da reta.
    function simplifyOpen(pts, tol) {
        if (pts.length < 3) return pts.slice();
        var keep = [], stack = [[0, pts.length - 1]], i;
        keep[0] = keep[pts.length - 1] = true;
        while (stack.length) {
            var seg = stack.pop(), a = seg[0], b = seg[1], maxD = -1, idx = -1;
            var ax = pts[a].x, ay = pts[a].y, dx = pts[b].x - ax, dy = pts[b].y - ay;
            var len = Math.sqrt(dx * dx + dy * dy);
            for (i = a + 1; i < b; i++) {
                var d = len > 1e-12 ? Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len : Math.sqrt(dist2(pts[i], pts[a]));
                if (d > maxD) { maxD = d; idx = i; }
            }
            if (maxD > tol) {
                keep[idx] = true;
                stack.push([a, idx], [idx, b]);
            }
        }
        return pts.filter(function (p, k) { return keep[k]; });
    }

    function simplifyRing(pts, tol) {
        if (pts.length < 4) return pts.slice();
        var far = 0, fd = -1;
        for (var i = 1; i < pts.length; i++) {
            var d = dist2(pts[0], pts[i]);
            if (d > fd) { fd = d; far = i; }
        }
        var first = simplifyOpen(pts.slice(0, far + 1), tol);
        var second = simplifyOpen(pts.slice(far).concat([pts[0]]), tol);
        return first.concat(second.slice(1, -1));
    }

    // Tira pontos repetidos e colineares (atrapalham a triangulação).
    function cleanRing(pts, eps) {
        var out = pts.slice();
        for (var i = 0; i < out.length && out.length > 3; i++) {
            var a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
            var ac = Math.sqrt(dist2(a, c));
            if (dist2(a, b) < eps * eps || Math.abs(turn(a, b, c)) <= eps * ac) {
                out.splice(i, 1);
                i = Math.max(-1, i - 2);
            }
        }
        return out;
    }

    function isConvexRing(pts, eps) {
        for (var i = 0; i < pts.length; i++) {
            if (turn(pts[(i - 1 + pts.length) % pts.length], pts[i], pts[(i + 1) % pts.length]) < -eps) return false;
        }
        return true;
    }

    function pointInPolygon(p, poly) {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var a = poly[i], b = poly[j];
            if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
    }

    // Quão "gordo" é um triângulo: 1 = equilátero, perto de 0 = lasca.
    function triQuality(a, b, c) {
        var area2 = Math.abs(turn(a, b, c));
        var l = dist2(a, b) + dist2(b, c) + dist2(c, a);
        return l > 0 ? 3.4641 * area2 / l : 0; // 2·√3·área / soma dos lados²
    }

    // Triangulação por "ear clipping" de um polígono simples anti-horário.
    // A cada passo corta a orelha mais bem formada (não a primeira que
    // aparece): menos lascas finas, que viram peças instáveis na colisão.
    // Devolve índices dos triângulos, ou null se o polígono se cruza.
    function triangulate(poly) {
        var n = poly.length, idx = [], tris = [], i;
        if (n < 3) return null;
        for (i = 0; i < n; i++) idx.push(i);
        while (idx.length > 3) {
            var m = idx.length, best = -1, bestQ = -1;
            for (var k = 0; k < m; k++) {
                var ia = idx[(k + m - 1) % m], ib = idx[k], ic = idx[(k + 1) % m];
                var a = poly[ia], b = poly[ib], c = poly[ic];
                if (turn(a, b, c) <= 0) continue; // vértice côncavo: não é orelha
                var empty = true;
                for (var j = 0; j < m && empty; j++) {
                    var q = poly[idx[j]];
                    if (idx[j] === ia || idx[j] === ib || idx[j] === ic) continue;
                    if (turn(a, b, q) >= 0 && turn(b, c, q) >= 0 && turn(c, a, q) >= 0) empty = false;
                }
                if (!empty) continue;
                var qual = triQuality(a, b, c);
                if (qual > bestQ) { bestQ = qual; best = k; }
            }
            if (best < 0) return null;
            tris.push([idx[(best + m - 1) % m], idx[best], idx[(best + 1) % m]]);
            idx.splice(best, 1);
        }
        tris.push([idx[0], idx[1], idx[2]]);
        return tris;
    }

    // Junta dois polígonos (índices, anti-horários) que dividem uma aresta, se
    // o resultado continua convexo e com até maxVerts vértices.
    function tryMerge(A, B, poly, maxVerts, eps) {
        if (A.length + B.length - 2 > maxVerts) return null;
        for (var i = 0; i < A.length; i++) {
            var a0 = A[i], a1 = A[(i + 1) % A.length];
            for (var j = 0; j < B.length; j++) {
                if (B[j] !== a1 || B[(j + 1) % B.length] !== a0) continue;
                var M = [], k;
                for (k = 0; k < A.length; k++) M.push(A[(i + 1 + k) % A.length]);          // a1 ... a0
                for (k = 2; k < B.length; k++) M.push(B[(j + k) % B.length]);              // resto de B
                var pts = M.map(function (ix) { return poly[ix]; });
                return isConvexRing(pts, eps) ? M : null;
            }
        }
        return null;
    }

    // Hertel-Mehlhorn: parte dos triângulos e remove diagonais (das mais longas
    // para as mais curtas) enquanto as peças continuarem convexas. No máximo
    // 4x o número ótimo de peças — na prática, poucas peças por letra.
    function mergeTriangles(poly, tris, maxVerts, eps) {
        var pieces = tris.map(function (t) { return t.slice(); });
        var parent = pieces.map(function (x, i) { return i; });
        function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
        var firstTri = {}, diagonals = [];
        tris.forEach(function (t, ti) {
            for (var e = 0; e < 3; e++) {
                var u = t[e], v = t[(e + 1) % 3], key = Math.min(u, v) + "_" + Math.max(u, v);
                if (firstTri[key] === undefined) firstTri[key] = ti;
                else diagonals.push({ t1: firstTri[key], t2: ti, len: dist2(poly[u], poly[v]) });
            }
        });
        diagonals.sort(function (p, q) { return q.len - p.len; });
        diagonals.forEach(function (d) {
            var pa = find(d.t1), pb = find(d.t2);
            if (pa === pb) return;
            var m = tryMerge(pieces[pa], pieces[pb], poly, maxVerts, eps);
            if (!m) return;
            pieces[pa] = m;
            pieces[pb] = null;
            parent[pb] = pa;
        });
        return pieces.filter(Boolean).map(function (ixs) { return ixs.map(function (ix) { return poly[ix]; }); });
    }

    // ----- Bayazit (como a poly-decomp do Matter.js) -----
    // Para cada vértice côncavo, corta até o lado oposto do polígono — no
    // vértice visível mais próximo dentro da "cunha" do ângulo, ou num ponto
    // novo no meio da aresta quando não há vértice lá — e resolve as duas
    // metades recursivamente. Curvas côncavas longas (o miolo de um "c") viram
    // faixas, em vez do leque de lascas da triangulação.

    function at(poly, i) { var n = poly.length; return poly[((i % n) + n) % n]; }

    function lineIntersection(p1, p2, q1, q2) {
        var a1 = p2.y - p1.y, b1 = p1.x - p2.x, c1 = a1 * p1.x + b1 * p1.y;
        var a2 = q2.y - q1.y, b2 = q1.x - q2.x, c2 = a2 * q1.x + b2 * q1.y;
        var det = a1 * b2 - a2 * b1;
        if (Math.abs(det) < 1e-12) return { x: 0, y: 0 };
        return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det };
    }

    function segmentsIntersect(p1, p2, q1, q2) {
        var dx = p2.x - p1.x, dy = p2.y - p1.y, da = q2.x - q1.x, db = q2.y - q1.y;
        var den = da * dy - db * dx;
        if (den === 0) return false;
        var sP = (dx * (q1.y - p1.y) + dy * (p1.x - q1.x)) / den;
        var tP = (da * (p1.y - q1.y) + db * (q1.x - p1.x)) / -den;
        return sP >= 0 && sP <= 1 && tP >= 0 && tP <= 1;
    }

    function canSee(poly, a, b) {
        var n = poly.length;
        for (var i = 0; i < n; i++) {
            var i1 = (i + 1) % n;
            if (i === a || i === b || i1 === a || i1 === b) continue;
            if (segmentsIntersect(poly[a], poly[b], poly[i], poly[i1])) return false;
        }
        return true;
    }

    function slice(poly, from, to) { // poly[from..to-1]
        var out = [];
        for (var i = from; i < to; i++) out.push(poly[i]);
        return out;
    }

    function bayazit(poly, out, level) {
        var n = poly.length;
        if (n < 3) return true;
        if (level > 200) return false;
        for (var i = 0; i < n; i++) {
            if (!(turn(at(poly, i - 1), at(poly, i), at(poly, i + 1)) < 0)) continue; // só vértices côncavos
            var lowerDist = Infinity, upperDist = Infinity, lowerIndex = 0, upperIndex = 0;
            var lowerInt = { x: 0, y: 0 }, upperInt = { x: 0, y: 0 }, j, p, d;
            for (j = 0; j < n; j++) {
                if (turn(at(poly, i - 1), at(poly, i), at(poly, j)) > 0 && turn(at(poly, i - 1), at(poly, i), at(poly, j - 1)) <= 0) {
                    p = lineIntersection(at(poly, i - 1), at(poly, i), at(poly, j), at(poly, j - 1));
                    if (turn(at(poly, i + 1), at(poly, i), p) < 0) {
                        d = dist2(poly[i], p);
                        if (d < lowerDist) { lowerDist = d; lowerInt = p; lowerIndex = j; }
                    }
                }
                if (turn(at(poly, i + 1), at(poly, i), at(poly, j + 1)) > 0 && turn(at(poly, i + 1), at(poly, i), at(poly, j)) <= 0) {
                    p = lineIntersection(at(poly, i + 1), at(poly, i), at(poly, j), at(poly, j + 1));
                    if (turn(at(poly, i - 1), at(poly, i), p) > 0) {
                        d = dist2(poly[i], p);
                        if (d < upperDist) { upperDist = d; upperInt = p; upperIndex = j; }
                    }
                }
            }
            var lower = [], upper = [];
            if (lowerIndex === (upperIndex + 1) % n) {
                // Nenhum vértice para ligar: ponto novo no meio do caminho.
                p = { x: (lowerInt.x + upperInt.x) / 2, y: (lowerInt.y + upperInt.y) / 2 };
                if (i < upperIndex) {
                    lower = slice(poly, i, upperIndex + 1).concat([p]);
                    upper = [p].concat(lowerIndex !== 0 ? slice(poly, lowerIndex, n) : [], slice(poly, 0, i + 1));
                } else {
                    lower = (i !== 0 ? slice(poly, i, n) : []).concat(slice(poly, 0, upperIndex + 1), [p]);
                    upper = [p].concat(slice(poly, lowerIndex, i + 1));
                }
            } else {
                // Liga ao vértice visível mais próximo dentro da cunha.
                if (lowerIndex > upperIndex) upperIndex += n;
                var closest = -1, closestDist = Infinity;
                for (j = lowerIndex; j <= upperIndex; j++) {
                    var jj = ((j % n) + n) % n;
                    if (turn(at(poly, i - 1), at(poly, i), at(poly, j)) >= 0 && turn(at(poly, i + 1), at(poly, i), at(poly, j)) <= 0) {
                        d = dist2(poly[i], at(poly, j));
                        if (d < closestDist && jj !== i && canSee(poly, i, jj)) { closestDist = d; closest = jj; }
                    }
                }
                if (closest < 0) return false;
                if (i < closest) {
                    lower = slice(poly, i, closest + 1);
                    upper = (closest !== 0 ? slice(poly, closest, n) : []).concat(slice(poly, 0, i + 1));
                } else {
                    lower = (i !== 0 ? slice(poly, i, n) : []).concat(slice(poly, 0, closest + 1));
                    upper = slice(poly, closest, i + 1);
                }
            }
            if (lower.length >= n || upper.length >= n) return false; // não progrediu
            var first = lower.length < upper.length ? lower : upper, second = first === lower ? upper : lower;
            return bayazit(first, out, level + 1) && bayazit(second, out, level + 1);
        }
        out.push(poly);
        return true;
    }

    // Peças válidas = todas convexas e somando a área do contorno.
    function validPieces(pieces, ring, flat) {
        if (!pieces || !pieces.length) return false;
        var sum = 0;
        for (var i = 0; i < pieces.length; i++) {
            if (pieces[i].length < 3 || !isConvexRing(pieces[i], flat)) return false;
            sum += polygonArea(pieces[i]);
        }
        var area = polygonArea(ring);
        return Math.abs(sum - area) <= 0.005 * area;
    }

    // Um contorno fechado (qualquer sentido, côncavo ou não) -> peças convexas.
    function decomposeRing(ring, size) {
        var eps = size * 1e-4;          // distância (pt) abaixo da qual pontos são "o mesmo"
        var flat = size * size * 1e-7;  // tolerância de convexidade (área)
        if (polygonArea(ring) < 0) ring = ring.slice().reverse();
        ring = cleanRing(ring, eps);
        if (ring.length < 3 || polygonArea(ring) <= eps * eps) return [];
        if (isConvexRing(ring, flat)) return [simplifyHull(ring, 24, size * 0.002)];
        var pieces = [];
        if (bayazit(ring, pieces, 0)) {
            pieces = pieces.map(function (pt) { return cleanRing(pt, eps); }).filter(function (pt) { return pt.length >= 3; });
            if (validPieces(pieces, ring, flat)) {
                return pieces.map(function (pt) { return pt.length > 24 ? simplifyHull(pt, 24, size * 0.002) : pt; });
            }
        }
        // Plano B: triangulação + junção de triângulos (Hertel-Mehlhorn).
        var tris = triangulate(ring);
        if (!tris) return [convexHull(ring)]; // contorno que se cruza: fica a casca
        return mergeTriangles(ring, tris, 16, flat);
    }

    // Caminho aberto (traço solto) -> um retângulo fino por segmento; a
    // espessura de verdade vem do traço/offset (raio da forma).
    function segmentParts(pts, size) {
        var parts = [], h = size * 0.005;
        for (var i = 0; i + 1 < pts.length; i++) {
            var a = pts[i], b = pts[i + 1];
            var ex = b.x - a.x, ey = b.y - a.y, len = Math.sqrt(ex * ex + ey * ey);
            if (len < 1e-9) continue;
            var hx = -ey / len * h, hy = ex / len * h;
            parts.push(convexHull([
                { x: a.x + hx, y: a.y + hy }, { x: b.x + hx, y: b.y + hy },
                { x: b.x - hx, y: b.y - hy }, { x: a.x - hx, y: a.y - hy }
            ]));
        }
        return parts;
    }

    var MAX_PARTS = 40;

    // Do contorno (pt, coordenadas locais com y para baixo) para a forma de
    // colisão em pt, ANTES do offset:
    //   { kind: "circle", cx, cy, r }            — bolas rolam de verdade
    //   { kind: "parts", parts: [[{x,y}...]...] } — peças convexas de um corpo só
    // Miolos fechados (o de "O", "A", "B"...) não entram: nada consegue entrar
    // neles. Reentrâncias abertas ("u", "h", "C") ficam abertas.
    function shapeFromPaths(paths) {
        var subs = sampleSubpaths(paths, 8).filter(function (sp) { return sp.pts.length > 0; });
        if (!subs.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, all = [];
        subs.forEach(function (sp) {
            sp.pts.forEach(function (q) {
                all.push(q);
                if (q.x < minX) minX = q.x;
                if (q.x > maxX) maxX = q.x;
                if (q.y < minY) minY = q.y;
                if (q.y > maxY) maxY = q.y;
            });
        });
        var size = Math.max(maxX - minX, maxY - minY);
        if (!(size > 0)) return null;

        var rings = [], opens = [];
        subs.forEach(function (sp) {
            if (sp.closed && sp.pts.length >= 3 && Math.abs(polygonArea(sp.pts)) > 1e-5 * size * size) rings.push(sp.pts);
            else opens.push(sp.pts);
        });
        // Furo = contorno dentro de um número ímpar de contornos maiores.
        var areas = rings.map(function (r) { return Math.abs(polygonArea(r)); });
        var outers = rings.filter(function (r, i) {
            var depth = 0;
            for (var j = 0; j < rings.length; j++) {
                if (j !== i && areas[j] > areas[i] && pointInPolygon(r[0], rings[j])) depth++;
            }
            return depth % 2 === 0;
        });

        if (outers.length === 1 && opens.length === 0) {
            var hull = convexHull(outers[0]);
            if (Math.abs(polygonArea(outers[0])) > 0.97 * polygonArea(hull)) {
                var circle = detectCircle(hull);
                if (circle) return { kind: "circle", cx: circle.cx, cy: circle.cy, r: circle.r };
            }
        }

        // Simplificação: desvio de até 1% do tamanho (≈1 pt numa letra de
        // 90 pt). Menos vértices nas curvas = menos peças e menos lascas.
        var tol = size * 0.01, parts = [];
        for (var attempt = 0; attempt < 5; attempt++, tol *= 2) {
            parts = [];
            outers.forEach(function (r) { parts.push.apply(parts, decomposeRing(simplifyRing(r, tol), size)); });
            opens.forEach(function (o) { parts.push.apply(parts, segmentParts(simplifyOpen(o, tol), size)); });
            parts = parts.filter(function (pt) { return pt.length >= 3 && polygonArea(pt) > 1e-6 * size * size; });
            if (parts.length <= MAX_PARTS) break;
        }
        if (!parts.length || parts.length > MAX_PARTS) {
            // Último recurso: a casca convexa de tudo (como na versão 1.0.0).
            var h = convexHull(all);
            parts = h.length >= 3 && polygonArea(h) > 1e-6 * size * size ? [simplifyHull(h, 24, size * 0.002)] : segmentParts([all[0], all[all.length - 1]], size);
        }
        return { kind: "parts", parts: parts };
    }

    // Área total de uma forma (pt²), para massa e escala.
    function shapeArea(sh) {
        if (sh.kind === "circle") return Math.PI * sh.r * sh.r;
        var a = 0;
        sh.parts.forEach(function (pt) { a += Math.abs(polygonArea(pt)); });
        return a;
    }

    // ===== Simulação completa (o que o painel chama) =====
    //
    // scene = { width, height (pt), items: [{ shape (de shapeFromPaths),
    //           restitution 0..1, weight > 0, offset (pt, pode ser negativo) }] }
    // params = { gravity (1 = Terra), air 0..1, friction 0..1, maxSeconds,
    //            walls: { floor, left, right, ceiling } }
    //
    // Gravidade: a prancheta vale ~2 m (raiz de largura x altura), então em
    // 100% um objeto cai a altura de uma A4 em ~0,6 s, como cairia de 2 m.
    //
    // Massa: no vácuo, a massa NÃO muda a queda (Galileu) — só as colisões
    // (o mais pesado empurra o mais leve). Para o peso mudar a aceleração de
    // cada um, existe a resistência do ar: força de arrasto F = -k·L·v
    // (proporcional ao tamanho L e à velocidade), então a = g - (k·L/m)·v e a
    // velocidade terminal fica g·m/(k·L): mais peso = cai mais rápido.
    // m = peso x área (densidade uniforme), normalizada pela área média.

    var STEP_HZ = 200;
    var RECORD_HZ = 100;
    var AIR_MAX = 6;       // 1/s — com 100% de ar e peso 1, a terminal é g/6
    // "Assentado" = em REST_TIME segundos, nenhum objeto andou mais que
    // REST_DIST (unidades, ~2% de um objeto típico) nem girou mais que
    // REST_ANGLE, e ninguém está rápido agora. Medir deslocamento (e não só
    // velocidade) deixa terminar pilhas que escorregam imperceptivelmente
    // — letras encaixadas umas nas outras, por exemplo — em vez de correr
    // até o tempo máximo por causa de frações de ponto por segundo.
    var REST_TIME = 0.5;    // s
    var REST_DIST = 0.02;   // unidades
    var REST_ANGLE = 0.01;  // rad (~0,6°)
    var REST_SPEED = 0.5;   // unidades/s

    function Simulation(scene, params) {
        var items = scene.items, n = items.length, i;
        this.n = n;
        this.width = scene.width;
        this.height = scene.height;
        this.maxSeconds = params.maxSeconds || 8;

        // Escala interna: tamanho típico de um objeto = 1 unidade.
        var areas = [], sumArea = 0;
        for (i = 0; i < n; i++) {
            areas.push(Math.max(shapeArea(items[i].shape), 1e-6));
            sumArea += areas[i];
        }
        var aRef = n > 0 ? sumArea / n : 1;
        var S = Math.max(Math.sqrt(aRef), 1);
        this.S = S;

        var W = scene.width / S, H = scene.height / S;
        var gPt = (params.gravity === undefined ? 1 : params.gravity) * 9.81 * Math.sqrt(scene.width * scene.height) / 2;
        var g = gPt / S;
        this.world = new World({
            gravityX: 0, gravityY: g,
            velocityThreshold: Math.max(0.5, Math.sqrt(2 * g * 0.05))
        });
        var friction = params.friction === undefined ? 0.5 : params.friction;
        var air = (params.air || 0) * AIR_MAX;

        this.bodies = [];
        this.out = [];
        for (i = 0; i < n; i++) {
            var it = items[i], s = it.shape;
            var weight = Math.max(it.weight || 1, 0.01);
            var relArea = areas[i] / aRef;
            var mass = weight * relArea;
            var size = Math.sqrt(relArea);
            var offset = (it.offset || 0) / S;
            var shapes, cx, cy, inertia, outline;
            if (s.kind === "circle") {
                var r = s.r / S;
                var rc = Math.max(r + offset, 0.1 * r);
                shapes = [makeCircle(rc)];
                cx = s.cx / S; cy = s.cy / S;
                inertia = 0.5 * mass * r * r;
                outline = { kind: "circle", radius: rc * S };
            } else {
                // Centro de massa e inércia do conjunto de peças (eixos paralelos).
                var parts = s.parts.map(function (pt) { return pt.map(function (v) { return { x: v.x / S, y: v.y / S }; }); });
                var mds = parts.map(polygonMassData);
                var At = 0, mx = 0, my = 0, k;
                for (k = 0; k < mds.length; k++) { At += mds[k].area; mx += mds[k].area * mds[k].cx; my += mds[k].area * mds[k].cy; }
                cx = mx / At; cy = my / At;
                var Iu = 0;
                for (k = 0; k < mds.length; k++) {
                    Iu += mds[k].I + mds[k].area * ((mds[k].cx - cx) * (mds[k].cx - cx) + (mds[k].cy - cy) * (mds[k].cy - cy));
                }
                inertia = mass * Iu / At;
                var radius = POLYGON_RADIUS + Math.max(offset, 0);
                shapes = [];
                var outlineParts = [];
                parts.forEach(function (pv) {
                    var core = offset < 0 ? insetConvex(pv, -offset).verts : pv;
                    var local = core.map(function (v) { return { x: v.x - cx, y: v.y - cy }; });
                    shapes.push(makePolygon(local, radius));
                    outlineParts.push(local.map(function (v) { return { x: v.x * S, y: v.y * S }; }));
                });
                outline = { kind: "poly", parts: outlineParts, radius: radius * S };
            }
            var damp = air * size / mass; // = k·L/m
            this.world.addBody({
                shapes: shapes, x: cx, y: cy, mass: mass, inertia: inertia,
                restitution: Math.max(0, Math.min(1, it.restitution || 0)),
                friction: friction,
                linearDamping: damp,
                angularDamping: 0.05 + 0.5 * damp
            });
            this.bodies.push({ x: cx * S, y: cy * S, outline: outline });
            this.out.push(false);
        }

        // Paredes: caixas estáticas bem grossas (não deixam nada atravessar
        // mesmo numa queda rápida). O topo fica aberto por padrão para que
        // objetos acima da prancheta caiam para dentro dela.
        var walls = params.walls || { floor: true, left: true, right: true, ceiling: false };
        var T = Math.max(W, H);
        var self = this;
        function addWall(x0, y0, x1, y1) {
            self.world.addBody({
                isStatic: true, friction: friction, restitution: 0,
                x: (x0 + x1) / 2, y: (y0 + y1) / 2,
                shape: makePolygon([
                    { x: -(x1 - x0) / 2, y: -(y1 - y0) / 2 }, { x: (x1 - x0) / 2, y: -(y1 - y0) / 2 },
                    { x: (x1 - x0) / 2, y: (y1 - y0) / 2 }, { x: -(x1 - x0) / 2, y: (y1 - y0) / 2 }
                ], POLYGON_RADIUS)
            });
        }
        if (walls.floor) addWall(-T, H, W + T, H + T);
        if (walls.left) addWall(-T, -20 * H, 0, H + T);
        if (walls.right) addWall(W, -20 * H, W + T, H + T);
        if (walls.ceiling) addWall(-T, -T, W + T, 0);

        this.limits = { minX: -2 * W, maxX: 3 * W, maxY: 3 * H };
        this.dt = 1 / STEP_HZ;
        this.stepsPerFrame = STEP_HZ / RECORD_HZ;
        this.stepCount = 0;
        this.maxSteps = Math.round(this.maxSeconds * STEP_HZ);
        this.settled = false;
        this.done = n === 0;
        this.frames = [];
        this.record();
    }

    Simulation.prototype.record = function () {
        var f = new Float64Array(this.n * 3), S = this.S;
        for (var i = 0; i < this.n; i++) {
            var b = this.world.bodies[i];
            f[i * 3] = b.cx * S; f[i * 3 + 1] = b.cy * S; f[i * 3 + 2] = b.a;
        }
        this.frames.push(f);
    };

    // Avança até maxSteps passos (o painel chama em fatias para não travar a
    // interface). Devolve true quando terminou: tudo parado por REST_TIME, ou
    // tempo máximo, ou todos os objetos fora da caixa (sem chão).
    Simulation.prototype.advance = function (maxSteps) {
        var world = this.world, dt = this.dt;
        for (var s = 0; s < maxSteps && !this.done; s++) {
            world.step(dt);
            this.stepCount++;

            var fastest = 0, active = 0;
            for (var i = 0; i < this.n; i++) {
                var b = world.bodies[i];
                if (b.frozen) continue;
                if (b.cy > this.limits.maxY || b.cx < this.limits.minX || b.cx > this.limits.maxX) {
                    b.frozen = true; b.vx = b.vy = b.w = 0;
                    this.out[i] = true;
                    continue;
                }
                active++;
                var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.reach();
                if (sp > fastest) fastest = sp;
            }
            var recorded = this.stepCount % this.stepsPerFrame === 0;
            if (recorded) this.record();

            if (active === 0) { this.done = true; this.settled = true; break; }
            if (recorded && fastest < REST_SPEED && this.isResting()) {
                this.done = true; this.settled = true;
            } else if (this.stepCount >= this.maxSteps) {
                this.done = true;
            }
        }
        if (this.done && this.stepCount % this.stepsPerFrame !== 0) this.record();
        return this.done;
    };

    Simulation.prototype.isResting = function () {
        var back = Math.round(REST_TIME * RECORD_HZ), k = this.frames.length - 1;
        if (k < back) return false;
        var now = this.frames[k], then = this.frames[k - back], tol = REST_DIST * this.S;
        for (var i = 0; i < this.n; i++) {
            if (this.out[i]) continue;
            var dx = now[i * 3] - then[i * 3], dy = now[i * 3 + 1] - then[i * 3 + 1];
            if (dx * dx + dy * dy > tol * tol || Math.abs(now[i * 3 + 2] - then[i * 3 + 2]) > REST_ANGLE) return false;
        }
        return true;
    };

    Simulation.prototype.progress = function () {
        return Math.min(1, this.stepCount / this.maxSteps);
    };

    // frames[k][3i..3i+2] = centroide x, y (pt, local, y para baixo) e ângulo
    // (rad; positivo = horário na tela) do objeto i no tempo k / hz.
    Simulation.prototype.result = function () {
        return {
            hz: RECORD_HZ,
            frames: this.frames,
            duration: (this.frames.length - 1) / RECORD_HZ,
            settled: this.settled,
            out: this.out.slice(),
            bodies: this.bodies
        };
    };

    function simulate(scene, params) {
        var sim = new Simulation(scene, params);
        while (!sim.advance(1000)) { /* até terminar */ }
        return sim.result();
    }

    var api = {
        Simulation: Simulation,
        simulate: simulate,
        shapeFromPaths: shapeFromPaths,
        // expostos para os testes
        _internal: {
            World: World, makePolygon: makePolygon, makeCircle: makeCircle,
            collidePolygons: collidePolygons, collidePolygonAndCircle: collidePolygonAndCircle,
            collideCircles: collideCircles, makeXf: makeXf,
            convexHull: convexHull, polygonArea: polygonArea, polygonMassData: polygonMassData,
            sampleBezierPaths: sampleBezierPaths, insetConvex: insetConvex, detectCircle: detectCircle,
            simplifyHull: simplifyHull, sampleSubpaths: sampleSubpaths, triangulate: triangulate,
            decomposeRing: decomposeRing, pointInPolygon: pointInPolygon, shapeArea: shapeArea,
            bayazit: bayazit, validPieces: validPieces
        }
    };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.AutoPhysics = api;
})(this);
