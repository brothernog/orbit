# Orbit: introspeccao SOMENTE LEITURA de um .blend (Blender 3.6+). Executado pelo app com
# `blender -b --factory-startup -Y --python orbit_inspect.py -- <json>`: o proprio script abre o arquivo (use_scripts=False)
# para desligar, so em memoria, modificadores pesados antes da avaliacao do depsgraph ao carregar; nunca salva nem altera arquivos.
# Saida: um JSON (ASCII) entre marcadores com nonce; o texto e compacto, limitado e com dicas de detalhamento.
import bpy, sys, os, re, json, fnmatch, difflib, struct, signal

ARGS = json.loads(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else {}
ROOT = os.path.realpath(ARGS.get('root') or os.getcwd())
CAP = 150  # linhas de objetos/itens por listagem
EX = 8  # exemplos por verificacao de auditoria
POLY_BUDGET = 5_000_000  # poligonos iterados para contar n-gons
VERT_BUDGET = 2_000_000  # vertices iterados para conferir pesos de ossos
EVAL_BUDGET = 200_000  # faces estimadas apos modificadores avaliadas ao abrir (~3 s); acima disso, os mais pesados ficam so com a malha base
COLLIDER = re.compile(r'^(?:UCX|UBX|UCP|USP|UMM)_|[-_.](?:col|colonly|convcol|convcolonly)$', re.I)  # convencoes Unreal/Godot


def g(o, a, d=None):
    try:
        return getattr(o, a, d)
    except Exception:
        return d


def f(v):
    try:
        v = float(v)
    except Exception:
        return str(v)
    r = round(v, 3)
    return ('%g' % r) if r != 0 else '0'


def vec(v):
    return '(' + ', '.join(f(x) for x in v) + ')'


def k(n):
    return str(n) if n < 10_000 else ('%.1fk' % (n / 1000) if n < 1_000_000 else '%.2fM' % (n / 1_000_000))


def more(items, cap, hint=''):
    return items[:cap] + (['+%d mais%s' % (len(items) - cap, '; ' + hint if hint else '')] if len(items) > cap else [])


def nat(o):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', o.name)]


def stem(n):
    return re.sub(r'[\d._-]+$', '', n) or n


def collapse(names, min_group=4):
    """Nomes em serie (Tree001..Tree999) viram "Tree* (n)"; preserva a ordem."""
    groups = {}
    for n in names:
        groups.setdefault(stem(n), []).append(n)
    out = []
    for key, ns in groups.items():
        out += ['%s* (%d)' % (key, len(ns))] if len(ns) >= min_group else ns
    return out


def rel(p, lib=None):
    if not p:
        return ''
    try:
        a = os.path.realpath(bpy.path.abspath(p, library=lib))
    except Exception:
        return p
    try:
        r = os.path.relpath(a, ROOT)
        if not r.startswith('..') and not os.path.isabs(r):
            return r.replace(os.sep, '/')
    except ValueError:
        pass
    return a  # absoluto fora do workspace: o app oculta


def absp(p, lib=None):
    try:
        return os.path.realpath(bpy.path.abspath(p, library=lib))
    except Exception:
        return p


def img_state(img):
    """(fonte, caminho relativo, estado) sem carregar pixels."""
    src = g(img, 'source', '?')
    if g(img, 'packed_file') or g(img, 'packed_files') and len(img.packed_files):
        return src, rel(img.filepath, img.library), 'empacotada'
    if src not in ('FILE', 'SEQUENCE', 'MOVIE', 'TILED'):
        return src, '', 'gerada' if src == 'GENERATED' else src.lower()
    p = absp(img.filepath, img.library)
    if src == 'TILED' and '<UDIM>' in p:
        ok = any(os.path.isfile(p.replace('<UDIM>', str(t.number))) for t in g(img, 'tiles', []))
    else:
        ok = os.path.isfile(p)
    return src, rel(img.filepath, img.library), 'ok' if ok else 'AUSENTE'


def img_dims(img):
    """Dimensoes lidas do cabecalho PNG/JPEG (arquivo ou empacotado) ou do buffer ja carregado; nunca carrega pixels."""
    try:
        if g(img, 'has_data'):
            return '%dx%d' % tuple(img.size)
        pf = g(img, 'packed_file')
        if pf and pf.size > 64 * 1024 * 1024:
            return ''
        if pf:
            head = bytes(pf.data[:65536])
        else:
            p = absp(img.filepath, img.library)
            if not os.path.isfile(p):
                return ''
            with open(p, 'rb') as fh:  # PNG so precisa de 24 bytes; JPEG pode ter EXIF antes do SOF
                head = fh.read(24)
                if head[:2] == b'\xff\xd8':
                    head += fh.read(65536 - 24)
        if head[:8] == b'\x89PNG\r\n\x1a\n':
            return '%dx%d' % struct.unpack('>II', head[16:24])
        if head[:2] == b'\xff\xd8':
            i = 2
            while i + 9 < len(head):
                if head[i] != 0xFF:
                    i += 1
                    continue
                m = head[i + 1]
                if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack('>HH', head[i + 5:i + 9])
                    return '%dx%d' % (w, h)
                i += 2 + struct.unpack('>H', head[i + 2:i + 4])[0]
    except Exception:
        pass
    return ''


def colls_of(o):
    return [c.name for c in g(o, 'users_collection', [])]


def face_sizes(me, budget):
    """(tris, quads, ngons) por loop_total com orcamento global de poligonos; None se a malha exceder o orcamento."""
    n = len(me.polygons)
    if n == 0:
        return 0, 0, 0
    if n > budget[0]:
        return None
    budget[0] -= n
    try:
        import numpy as np
        a = np.empty(n, dtype=np.int32)
        me.polygons.foreach_get('loop_total', a)
        return int(np.count_nonzero(a == 3)), int(np.count_nonzero(a == 4)), int(np.count_nonzero(a > 4))
    except ImportError:
        import array
        a = array.array('i', bytes(4 * n))
        me.polygons.foreach_get('loop_total', a)
        t = q = 0
        for x in a:
            if x == 3:
                t += 1
            elif x == 4:
                q += 1
        return t, q, n - t - q


def mesh_counts(me):
    v, fc, lp = len(me.vertices), len(me.polygons), len(me.loops)
    return v, fc, lp - 2 * fc  # triangulos = loops - 2*faces


SKIPPED = {}  # as_pointer() do objeto -> nomes dos modificadores desligados so em memoria (pesados)


def mod_on(o, m):
    return m.show_viewport or m.name in SKIPPED.get(o.as_pointer(), ())


def estimate(o):
    """(faces, triangulos, incerto) apos modificadores de viewport que multiplicam geometria; None se nenhum muda a contagem.
    Estimativa aritmetica (subsurf/multires, array, mirror, solidify, decimate), sem avaliar; nos/geometria desconhecidos = incerto."""
    if o.type != 'MESH' or not o.data or not len(o.modifiers):
        return None
    fc, lp = len(o.data.polygons), len(o.data.loops)
    unsure = touched = False
    for m in o.modifiers:
        if not mod_on(o, m):
            continue
        t = m.type
        if t in ('SUBSURF', 'MULTIRES'):
            lv = g(m, 'levels', 0)
            if lv > 0:
                fc, lp = lp * 4 ** (lv - 1), lp * 4 ** lv
                touched = True
        elif t == 'ARRAY':
            n = g(m, 'count', 1) if g(m, 'fit_type') == 'FIXED_COUNT' else 1
            unsure |= g(m, 'fit_type') != 'FIXED_COUNT'
            fc, lp, touched = fc * n, lp * n, True
        elif t == 'MIRROR':
            n = 2 ** sum(1 for a in g(m, 'use_axis', ()) if a)
            fc, lp, touched = fc * n, lp * n, True
        elif t == 'SOLIDIFY':
            fc, lp, touched, unsure = fc * 2, lp * 2, True, True
        elif t == 'DECIMATE':
            r = g(m, 'ratio', 1) if g(m, 'decimate_type') == 'COLLAPSE' else 0.25 ** g(m, 'iterations', 0) if g(m, 'decimate_type') == 'UNSUBDIV' else 1
            fc, lp, touched, unsure = int(fc * r), int(lp * r), True, unsure or g(m, 'decimate_type') == 'DISSOLVE'
        elif t in ('NODES', 'SCREW', 'REMESH', 'SKIN', 'PARTICLE_INSTANCE'):  # podem gerar/trocar toda a geometria
            unsure = True
    if not touched and not unsure:
        return None
    return fc, lp - 2 * fc, unsure, touched


def est_text(o):
    e = estimate(o)
    if not e:
        return ''
    return ('~t%s%s apos mods' % (k(e[1]), '?' if e[2] else '') if e[3] else 'apos mods: ? (nos/remesh)') + (' (nao avaliados: pesado)' if o.as_pointer() in SKIPPED else '')


def throttle_heavy():
    """load_post: antes da avaliacao do depsgraph ao abrir, desliga (em memoria) os modificadores dos objetos com mais faces
    estimadas ate o total avaliado caber em EVAL_BUDGET; senao abrir uma cena com subsurf alto leva minutos."""
    cands = []
    for o in bpy.data.objects:
        e = estimate(o) if not o.library else None
        if e and e[3] and e[0] > len(o.data.polygons):
            cands.append((e[0], o))
    total = 0
    for est, o in sorted(cands, key=lambda c: c[0]):
        total += est
        if total <= EVAL_BUDGET:
            continue
        names = [m.name for m in o.modifiers if m.show_viewport]
        try:
            for m in o.modifiers:
                m.show_viewport = False
            SKIPPED[o.as_pointer()] = names
        except Exception:
            pass


def restore(o):
    for n in SKIPPED.pop(o.as_pointer(), ()):
        m = o.modifiers.get(n)
        if m:
            m.show_viewport = True


_DEF = {}


def defaults(item):
    """Instancia padrao do mesmo tipo (modificador/constraint) num objeto temporario em memoria, removido em seguida; nunca salvo."""
    key = (item.bl_rna.identifier, g(item, 'type'))
    if key not in _DEF:
        _DEF[key] = None
        tmp = None
        try:
            me = bpy.data.meshes.new('.orbit_tmp')
            tmp = bpy.data.objects.new('.orbit_tmp', me)
            col = tmp.modifiers if isinstance(item, bpy.types.Modifier) else tmp.constraints
            d = col.new('d', item.type) if isinstance(item, bpy.types.Modifier) else col.new(item.type)
            _DEF[key] = {p.identifier: (tuple(getattr(d, p.identifier)) if g(p, 'is_array', False) or p.type == 'ENUM' and g(p, 'is_enum_flag', False) else getattr(d, p.identifier))
                         for p in d.bl_rna.properties if p.type in ('BOOLEAN', 'INT', 'FLOAT', 'ENUM', 'STRING')}
        except Exception:
            pass
        finally:
            if tmp:
                bpy.data.objects.remove(tmp)
                bpy.data.meshes.remove(me)
    return _DEF[key]


def changed(rna_obj, cap=8):
    """Propriedades RNA diferentes do padrao real do tipo (generico para modificadores/constraints)."""
    out = []
    base = defaults(rna_obj) or {}
    skip = {'rna_type', 'name', 'type', 'show_viewport', 'show_render', 'show_in_editmode', 'show_on_cage', 'show_expanded',
            'is_active', 'is_override_data', 'use_apply_on_spline', 'persistent_uid', 'execution_time', 'is_valid', 'active',
            'show_pin', 'use_pin_to_last', 'is_override_data_editable', 'error_location', 'influence', 'mute', 'enabled'}
    for p in rna_obj.bl_rna.properties:
        idn = p.identifier
        if idn in skip or p.is_readonly and p.type != 'POINTER':
            continue
        try:
            val = getattr(rna_obj, idn)
            if p.type == 'POINTER':
                if val is not None and hasattr(val, 'name') and p.fixed_type and isinstance(val, bpy.types.ID):
                    out.append('%s=%s' % (idn, val.name))
                continue
            if p.type == 'COLLECTION':
                continue
            if g(p, 'is_array', False) and g(p, 'array_length', 0):
                d = list(base.get(idn, p.default_array))
                v = list(val)
                if len(v) == len(d) and any(abs(float(a) - float(b)) > 1e-6 if isinstance(a, float) else a != b for a, b in zip(v, d)):
                    out.append('%s=%s' % (idn, vec(v) if isinstance(v[0], float) else ''.join('1' if x else '0' for x in v) if isinstance(v[0], bool) else str(v)))
                continue
            if p.type == 'ENUM' and g(p, 'is_enum_flag', False):
                if set(val) != set(base.get(idn, p.default_flag)):
                    out.append('%s={%s}' % (idn, ','.join(sorted(val))))
                continue
            if p.type == 'STRING':
                if val and val != base.get(idn, ''):
                    out.append('%s=%s' % (idn, val[:40]))
                continue
            d = base.get(idn, p.default)
            if (abs(val - d) > 1e-6) if p.type == 'FLOAT' else val != d:
                out.append('%s=%s' % (idn, f(val) if p.type == 'FLOAT' else val))
        except Exception:
            continue
        if len(out) >= cap:
            out.append('...')
            break
    return out


def action_info(ad):
    if not ad:
        return ''
    parts = []
    act = g(ad, 'action')
    if act:
        n = len(fcurves(act))
        fr = g(act, 'frame_range')
        parts.append('action %s (%d fcurves%s)' % (act.name, n, ', frames %s-%s' % (f(fr[0]), f(fr[1])) if fr else ''))
    dr = len(g(ad, 'drivers', []))
    if dr:
        parts.append('%d drivers' % dr)
    nla = g(ad, 'nla_tracks', [])
    if len(nla):
        parts.append('NLA %d trilhas' % len(nla))
    return ', '.join(parts)


def pick_scene():
    name = ARGS.get('scene')
    if name:
        sc = bpy.data.scenes.get(name)
        if not sc:
            raise Exception('Cena "%s" inexistente. Cenas: %s' % (name, ', '.join(s.name for s in bpy.data.scenes)[:500]))
        return sc
    return bpy.context.scene or bpy.data.scenes[0]


def eng(sc):
    return {'BLENDER_EEVEE': 'EEVEE', 'BLENDER_EEVEE_NEXT': 'EEVEE', 'BLENDER_WORKBENCH': 'Workbench', 'CYCLES': 'Cycles'}.get(sc.render.engine, sc.render.engine)


def scene_line(sc, active):
    r = sc.render
    cam = sc.camera.name if sc.camera else 'nenhuma'
    fps = r.fps / (r.fps_base or 1)
    return 'cena %s%s · %s · %dx%d@%d%% · %s fps · frames %d-%d · camera %s · %d objetos' % (
        sc.name, ' (ativa)' if active else '', eng(sc), r.resolution_x, r.resolution_y, r.resolution_percentage, f(fps),
        sc.frame_start, sc.frame_end, cam, len(sc.objects))


def obj_line(o, depth=0, show_parent=False, colls=True):
    bits = ['%s%s · %s' % (' ' * min(depth, 8), o.name, o.type)]
    if show_parent and o.parent:
        bits.append('pai ' + o.parent.name)
    cs = colls_of(o)
    if cs and colls and not (o.parent and colls_of(o.parent) == cs and not show_parent):
        bits.append(','.join(cs[:2]) + ('+%d' % (len(cs) - 2) if len(cs) > 2 else ''))
    if o.type == 'MESH' and o.data:
        v, fc, t = mesh_counts(o.data)
        bits.append('v%s f%s t%s' % (k(v), k(fc), k(t)))
        if est_text(o):
            bits.append(est_text(o))
    elif o.type == 'LIGHT' and o.data:
        bits.append(o.data.type)
    elif o.type == 'EMPTY' and g(o, 'instance_collection') and o.instance_type == 'COLLECTION':
        bits.append('instancia %s (t%s)' % (o.instance_collection.name, k(coll_tris(o.instance_collection))))
    if o.type in ('MESH', 'CURVE', 'FONT', 'SURFACE', 'META', 'ARMATURE', 'GPENCIL', 'GREASEPENCIL', 'CURVES', 'POINTCLOUD', 'VOLUME'):
        bits.append('dim ' + 'x'.join(f(x) for x in o.dimensions))
    if len(o.modifiers):
        bits.append('mods ' + ','.join(m.type.lower() for m in o.modifiers[:4]) + ('+%d' % (len(o.modifiers) - 4) if len(o.modifiers) > 4 else ''))
    if len(g(o, 'material_slots', [])):
        ms = [s.material.name if s.material else '[vazio]' for s in o.material_slots]
        bits.append('mats ' + ','.join(ms[:3]) + ('+%d' % (len(ms) - 3) if len(ms) > 3 else ''))
    s = o.scale
    if o.type == 'MESH' and any(abs(x - 1) > 1e-4 for x in s):
        bits.append('escala ' + vec(s))
    flags = []
    try:
        if o.hide_get():
            flags.append('oculto')
    except Exception:
        pass
    if g(o, 'hide_render'):
        flags.append('sem render')
    if o.library:
        flags.append('vinculado')
    if flags:
        bits.append(' '.join(flags))
    return ' · '.join(bits)


_CT = {}


def coll_tris(c):
    """Triangulos (estimados apos modificadores) de uma colecao instanciada, incluindo instancias aninhadas."""
    if c.name_full not in _CT:
        _CT[c.name_full] = 0
        t = 0
        for o in g(c, 'all_objects', c.objects):
            if o.type == 'MESH' and o.data:
                e = estimate(o)
                t += e[1] if e else mesh_counts(o.data)[2]
            elif o.type == 'EMPTY' and g(o, 'instance_collection') and o.instance_type == 'COLLECTION':
                t += coll_tris(o.instance_collection)
        _CT[c.name_full] = t
    return _CT[c.name_full]


def instanced():
    return set(o.instance_collection.name_full for o in bpy.data.objects if o.instance_type == 'COLLECTION' and g(o, 'instance_collection'))


def fcurves(act):
    fc = g(act, 'fcurves')
    if fc is not None:
        return list(fc)
    out = []  # actions em camadas (4.4+/5.x)
    for layer in g(act, 'layers', []):
        for st in g(layer, 'strips', []):
            for cb in g(st, 'channelbags', []):
                out += list(g(cb, 'fcurves', []))
    return out


def key_owner(key):
    """Nome do objeto (ou da malha) dono de um datablock de shape keys."""
    u = g(key, 'user')
    return next((o.name for o in bpy.data.objects if u is not None and o.data == u), g(u, 'name', key.name))


def action_users():
    """action -> ['Rig', 'Rig (NLA)'] a partir de animation_data de objetos e shape keys."""
    use = {}
    for idb in list(bpy.data.objects) + list(bpy.data.shape_keys):
        ad = g(idb, 'animation_data')
        if not ad:
            continue
        who = key_owner(idb) if isinstance(idb, bpy.types.Key) else idb.name
        if ad.action:
            use.setdefault(ad.action.name, []).append(who)
        for tr in ad.nla_tracks:
            for st in tr.strips:
                if st.action:
                    use.setdefault(st.action.name, []).append(who + ' (NLA)')
    return use


def coll_tree(sc, out):
    lines = []
    lcs = {}

    def walk_lc(lc):
        lcs[lc.collection.name] = lc
        for ch in lc.children:
            walk_lc(ch)
    try:
        for vl in sc.view_layers[:1]:
            walk_lc(vl.layer_collection)
    except Exception:
        pass

    def walk(c, d):
        if len(lines) >= 60:
            return
        total = len(g(c, 'all_objects', c.objects))
        lc = lcs.get(c.name)
        fl = []
        if lc is not None and g(lc, 'exclude'):
            fl.append('excluida')
        if g(c, 'hide_render'):
            fl.append('sem render')
        if g(c, 'hide_viewport'):
            fl.append('desativada')
        lines.append('%s%s [%d direto, %d total]%s' % (' ' * min(d, 8), c.name, len(c.objects), total, ' (' + ', '.join(fl) + ')' if fl else ''))
        for ch in c.children:
            walk(ch, d + 1)
    walk(sc.collection, 0)
    nc = len(sc.collection.children_recursive) + 1 if hasattr(sc.collection, 'children_recursive') else len(lines)
    out.append('colecoes (%d):' % nc)
    out.extend(lines)
    if nc > len(lines):
        out.append('+%d colecoes' % (nc - len(lines)))


def deps():
    """Arquivos externos que mudam a resposta (imagens nao empacotadas, bibliotecas): o app invalida o cache se mudarem."""
    out = [absp(l.filepath) for l in bpy.data.libraries]
    for i in bpy.data.images:
        if g(i, 'source') in ('FILE', 'SEQUENCE', 'MOVIE', 'TILED') and not g(i, 'packed_file'):
            p = absp(i.filepath, i.library)
            out += [p.replace('<UDIM>', str(t.number)) for t in g(i, 'tiles', [])] if '<UDIM>' in p else [p]
    return sorted(set(out))[:5000]


def summary():
    out = []
    sc = pick_scene()
    us = sc.unit_settings
    fv = g(bpy.data, 'version')
    out.append('salvo em Blender %s · unidades %s · escala %s · comprimento %s' % ('.'.join(str(x) for x in fv[:2]) if fv else '?', us.system, f(us.scale_length), g(us, 'length_unit', '?')))
    active = bpy.context.scene
    out.append(scene_line(sc, sc == active))
    others = [s for s in bpy.data.scenes if s != sc]
    if others:
        out.append('outras cenas: ' + ', '.join(more(['%s (%d obj)' % (s.name, len(s.objects)) for s in others], 10)))
    coll_tree(sc, out)
    objs = list(sc.objects)
    types = {}
    for o in objs:
        types[o.type] = types.get(o.type, 0) + 1
    out.append('tipos: ' + ' · '.join('%s %d' % kv for kv in sorted(types.items(), key=lambda kv: -kv[1])))
    D = bpy.data
    miss_i = sum(1 for i in D.images if img_state(i)[2] == 'AUSENTE')
    miss_l = sum(1 for l in D.libraries if not os.path.isfile(absp(l.filepath)))
    inst = instanced()
    orphan = sum(1 for o in D.objects if not o.users_scene and not o.library and not any(c.name_full in inst for c in o.users_collection))
    out.append('dados: meshes %d · materiais %d · imagens %d%s · bibliotecas %d%s · actions %d · node groups %d · armatures %d%s' % (
        len(D.meshes), len(D.materials), len(D.images), ' (AUSENTES %d)' % miss_i if miss_i else '', len(D.libraries),
        ' (AUSENTES %d)' % miss_l if miss_l else '', len(D.actions), len(D.node_groups), len(D.armatures),
        ' · %d objetos fora de cenas' % orphan if orphan else ''))
    tv = tf = tt = te = ti = 0
    meshes = []
    unsure = False
    for o in objs:
        if o.type == 'MESH' and o.data:
            v, fc, t = mesh_counts(o.data)
            e = estimate(o)
            tv += v; tf += fc; tt += t; te += e[1] if e else t
            unsure |= bool(e and e[2])
            meshes.append((e[1] if e else t, o.name))
        elif o.type == 'EMPTY' and g(o, 'instance_collection') and o.instance_type == 'COLLECTION':
            ti += coll_tris(o.instance_collection)
    out.append('malha na cena (base, sem modificadores; instancias contadas por objeto): v%s f%s t%s%s%s' % (
        k(tv), k(tf), k(tt), ' · ~t%s%s apos modificadores (estimado)' % (k(te), '?' if unsure else '') if te != tt or unsure else '',
        ' · +t%s em instancias de colecao' % k(ti) if ti else ''))
    if SKIPPED:
        out.append('modificadores NAO avaliados ao abrir (pesados; dimensoes desses objetos sao da malha base): ' + ', '.join(more(sorted(o.name for o in D.objects if o.as_pointer() in SKIPPED), 10)))
    au = action_users()
    if len(D.actions):
        out.append('actions (%d): %s' % (len(D.actions), ', '.join(more(['%s %s-%s%s%s' % (a.name, f(a.frame_range[0]), f(a.frame_range[1]), ' (fake)' if a.use_fake_user else '',
                                                                                    ' -> ' + '/'.join(au[a.name][:2]) if a.name in au else ' sem usuario') for a in sorted(D.actions, key=lambda a: a.name)], 20))))
    pat = ARGS.get('object')
    if pat:
        sel = [o for o in objs if fnmatch.fnmatchcase(o.name, pat)]
        out.append('objetos com "%s" (%d de %d):' % (pat, len(sel), len(objs)))
        out.extend(more([obj_line(o, show_parent=True) for o in sorted(sel, key=nat)], CAP, 'refine o filtro'))
        return out
    grouped = set()
    if len(objs) > CAP:
        if meshes:
            per = {}
            for t, n in meshes:
                me = sc.objects[n].data.name_full
                per.setdefault(me, [t, n, 0, me])[2] += 1
            top = sorted(per.values(), reverse=True)[:10]
            out.append('malhas mais pesadas (triangulos apos modificadores, estimados): ' + ', '.join('%s t%s' % (n, k(t)) if c == 1 else 'malha %s t%s x%d obj (%s...)' % (me, k(t), c, n) for t, n, c, me in top))
        series = {}
        for o in objs:
            series.setdefault((stem(o.name), o.type), []).append(o)
        big = sorted(((key, os_) for key, os_ in series.items() if len(os_) >= 10), key=lambda kv: -len(kv[1]))
        if big:
            out.append('series de objetos (nomes em sequencia, agregadas):')
            for (st, ty), os_ in big[:30]:
                datas = set(o.data.name for o in os_ if o.data)
                bits = ['%s* · %d x %s' % (st, len(os_), ty)]
                if ty == 'MESH':
                    tris = sum(mesh_counts(o.data)[2] for o in os_ if o.data)
                    bits.append('malha %s compartilhada' % next(iter(datas)) if len(datas) == 1 else '%d malhas' % len(datas))
                    bits.append('t%s total' % k(tris))
                cs = set(c for o in os_ for c in colls_of(o))
                bits.append(', '.join(sorted(cs)[:3]) + ('+%d' % (len(cs) - 3) if len(cs) > 3 else ''))
                out.append(' ' + ' · '.join(bits))
                grouped.update(o.name for o in os_)
            if len(big) > 30:
                out.append(' +%d series' % (len(big) - 30))
    rest = [o for o in objs if o.name not in grouped]
    out.append('objetos (%d%s; arvore por parentesco%s):' % (len(rest), ' fora das series' if grouped else '', '; primeiros %d' % CAP if len(rest) > CAP else ''))
    inscene = set(o.name for o in rest)
    lines = []

    def walk(o, d):
        if len(lines) >= CAP:
            return
        lines.append(obj_line(o, d, colls=multi))
        for ch in sorted(o.children, key=nat):
            if ch.name in inscene:
                walk(ch, d + 1)
    multi = len(sc.collection.children) > 0  # com uma so colecao o nome dela so repetiria
    for o in sorted((o for o in rest if not o.parent or o.parent.name not in inscene), key=nat):
        walk(o, 0)
    out.extend(lines)
    if len(rest) > len(lines):
        out.append('+%d objetos; use object=<glob> (ex.: "Tree*") para filtrar ou mode=object object=<nome>' % (len(rest) - len(lines)))
    return out


def object_mode():
    name = ARGS.get('object')
    if not name:
        raise Exception('Informe object=<nome> para mode=object.')
    o = bpy.data.objects.get(name)
    if not o:
        near = difflib.get_close_matches(name, [x.name for x in bpy.data.objects], 5)
        raise Exception('Objeto "%s" inexistente.%s' % (name, ' Parecidos: ' + ', '.join(near) if near else ''))
    out = []
    data = o.data
    heavy = o.as_pointer() in SKIPPED
    restore(o)  # so este objeto volta a ter modificadores; os demais pesados continuam desligados
    out.append('objeto %s · %s%s · dados %s (usuarios %d)%s' % (
        o.name, o.type, ' · vinculado de ' + rel(o.library.filepath) if o.library else '', data.name if data else '-',
        data.users if data else 0, ' · pai %s%s' % (o.parent.name, ' (osso %s)' % o.parent_bone if g(o, 'parent_bone') else '') if o.parent else ''))
    if o.children:
        out.append('filhos (%d): %s' % (len(o.children), ', '.join(more([c.name for c in o.children], 20))))
    out.append('colecoes: %s · cenas: %s' % (', '.join(colls_of(o)) or '-', ', '.join(s.name for s in g(o, 'users_scene', [])) or '-'))
    vis = []
    try:
        vis.append('oculto' if o.hide_get() else 'visivel')
    except Exception:
        pass
    vis += ['viewport desativado'] * bool(o.hide_viewport) + ['sem render'] * bool(o.hide_render)
    out.append('visibilidade: ' + ', '.join(vis))
    rm = o.rotation_mode
    rot = vec(o.rotation_quaternion) if rm == 'QUATERNION' else vec(o.rotation_axis_angle) if rm == 'AXIS_ANGLE' else vec(__import__('math').degrees(a) for a in o.rotation_euler) + ' graus'
    s = o.scale
    notes = []
    if any(x < 0 for x in s):
        notes.append('NEGATIVA (normais invertidas na exportacao)')
    if max(abs(x) for x in s) - min(abs(x) for x in s) > 1e-4:
        notes.append('nao uniforme')
    if any(abs(x - 1) > 1e-4 for x in s):
        notes.append('nao aplicada')
    out.append('loc %s · rot %s %s · escala %s%s' % (vec(o.location), rm, rot, vec(s), ' [' + ', '.join(notes) + ']' if notes else ''))
    out.append('dimensoes %s · world loc %s' % (vec(o.dimensions), vec(o.matrix_world.translation)))
    dl = [n for n, v, d in (('delta_loc', o.delta_location, 0), ('delta_rot', o.delta_rotation_euler, 0), ('delta_escala', o.delta_scale, 1)) if any(abs(x - d) > 1e-6 for x in v)]
    if dl:
        out.append('deltas nao nulos: ' + ', '.join(dl))
    if o.modifiers:
        out.append('modificadores (%d, em ordem):' % len(o.modifiers))
        for m in o.modifiers[:30]:
            st = ('' if m.show_viewport else ' [off viewport]') + ('' if m.show_render else ' [off render]')
            extra = ''
            if m.type == 'NODES' and g(m, 'node_group'):
                extra = ' grupo ' + m.node_group.name
            out.append(' %s %s%s%s: %s' % (m.name, m.type, extra, st, ', '.join(changed(m)) or 'padrao'))
    if len(g(o, 'constraints', [])):
        out.append('constraints (%d):' % len(o.constraints))
        for c in o.constraints[:20]:
            out.append(' %s %s%s: %s' % (c.name, c.type, ' [off]' if g(c, 'mute') or not g(c, 'enabled', True) else '', ', '.join(changed(c)) or 'padrao'))
    if len(g(o, 'material_slots', [])):
        out.append('materiais (%d slots): %s' % (len(o.material_slots), '; '.join(
            '%d %s%s' % (i, s.material.name if s.material else '[vazio]', ' (link OBJETO)' if s.link == 'OBJECT' else '') for i, s in enumerate(o.material_slots[:30]))))
    elif o.type in ('MESH', 'CURVE', 'FONT', 'SURFACE', 'META'):
        out.append('materiais: nenhum slot')
    if len(o.vertex_groups):
        out.append('grupos de vertices (%d): %s' % (len(o.vertex_groups), ', '.join(more([vg.name for vg in o.vertex_groups], 30))))
    if o.type == 'MESH' and data:
        me = data
        v, fc, t = mesh_counts(me)
        fs = face_sizes(me, [POLY_BUDGET])
        qt = ' (tris %s, quads %s, ngons %s)' % tuple(k(x) for x in fs) if fs else ' (tipos de face nao contados: malha grande)'
        out.append('malha base (sem modificadores): v%s · arestas %s · faces %s%s · triangulos %s' % (k(v), k(len(me.edges)), k(fc), qt, k(t)))
        e = estimate(o)
        if e and e[3]:
            out.append('apos modificadores (estimado): faces %s · triangulos %s%s' % (k(e[0]), k(e[1]), ' (incerto: nos/remesh/etc.)' if e[2] else ''))
        if heavy and e and not e[2]:
            out.append('(avaliacao real omitida: objeto pesado e estimativa exata para estes modificadores)')
        elif len(o.modifiers) and o.users_scene and len(o.users_scene[0].objects) <= 2000:
            # Avaliacao so para este caso (modificadores e cena moderada): custo do depsgraph cresce com a cena; os demais pesados seguem desligados.
            try:
                ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
                em = ev.to_mesh()
                ev_v, ev_f, ev_t = mesh_counts(em)
                ev.to_mesh_clear()
                out.append('apos modificadores (viewport): v%s · faces %s · triangulos %s' % (k(ev_v), k(ev_f), k(ev_t)))
            except Exception:
                pass
        uv = g(me, 'uv_layers', [])
        out.append('UV: %s · atributos de cor: %s' % (', '.join('%s%s' % (u.name, '*' if g(u, 'active_render') else '') for u in uv) or 'NENHUM',
                                                     ', '.join(a.name for a in g(me, 'color_attributes', [])) or '-'))
        known = set(u.name for u in uv) | set(a.name for a in g(me, 'color_attributes', [])) | {'position', 'sharp_face', 'sharp_edge', 'material_index'}
        attrs = [a.name for a in g(me, 'attributes', []) if not a.name.startswith('.') and a.name not in known]
        if attrs:
            out.append('atributos: ' + ', '.join(more(attrs, 20)))
        sm = []
        if g(me, 'use_auto_smooth'):
            sm.append('auto smooth %s graus' % f(__import__('math').degrees(me.auto_smooth_angle)))
        if g(me, 'has_custom_normals'):
            sm.append('normais custom')
        if sm:
            out.append('normais: ' + ', '.join(sm))
    sk = g(data, 'shape_keys') if data else None
    if sk:
        out.append('shape keys (%d%s): %s' % (len(sk.key_blocks), ', relativas' if sk.use_relative else ', ABSOLUTAS', ', '.join(more(
            ['%s%s' % (b.name, '=%s' % f(b.value) if b.value and b != sk.key_blocks[0] else '') for b in sk.key_blocks], 30))))
        an = action_info(g(sk, 'animation_data'))
        if an:
            out.append('animacao das shape keys: ' + an + ''.join(' · driver %s (%s)' % (d.data_path, d.driver.type) for d in list(sk.animation_data.drivers)[:5]))
    props = [(kk, o[kk]) for kk in o.keys() if not kk.startswith('_')] if hasattr(o, 'keys') else []
    if props:
        out.append('propriedades custom: ' + ', '.join(more(['%s=%s' % (kk, str(vv)[:40]) for kk, vv in props], 20)))
    an = action_info(g(o, 'animation_data'))
    if an:
        out.append('animacao: ' + an)
    if o.type == 'ARMATURE' and data:
        nd = sum(1 for b in data.bones if not b.use_deform)
        out.append('ossos (%d%s; raizes %s): %s' % (len(data.bones), ', %d sem deform' % nd if nd else '', ','.join(b.name for b in data.bones if not b.parent)[:80],
                                                    ', '.join(more([b.name for b in data.bones], 40))))
        skinned = [x.name for x in bpy.data.objects if any(m.type == 'ARMATURE' and g(m, 'object') == o for m in g(x, 'modifiers', []))]
        out.append('malhas deformadas: ' + (', '.join(more(skinned, 20)) or 'nenhuma'))
        bones, au = set(data.bones.keys()), action_users()
        acts = []
        for a in sorted(bpy.data.actions, key=lambda a: a.name):
            used = set(re.findall(r'pose\.bones\["([^"]+)"\]', ' '.join(c.data_path for c in fcurves(a))))
            if used:
                miss = sorted(used - bones)
                acts.append('%s %s-%s%s%s' % (a.name, f(a.frame_range[0]), f(a.frame_range[1]), '' if a.name in au else ' (sem usuario)',
                                             ' ossos inexistentes: ' + ','.join(miss[:5]) if miss else ''))
        if acts:
            out.append('actions de pose (%d): %s' % (len(acts), '; '.join(more(acts, 20))))
    if o.type == 'LIGHT' and data:
        out.append('luz %s · energia %s · cor %s' % (data.type, f(g(data, 'energy', 0)), vec(data.color)))
    if o.type == 'CAMERA' and data:
        out.append('camera %s · lente %smm · clip %s-%s' % (data.type, f(data.lens), f(data.clip_start), f(data.clip_end)))
    return out


def principled(nt):
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            vals = []
            for nm, lab in (('Base Color', 'base'), ('Metallic', 'metal'), ('Roughness', 'rough'), ('Alpha', 'alpha')):
                s = n.inputs.get(nm)
                if s is None:
                    continue
                if s.is_linked:
                    vals.append('%s<-%s' % (lab, s.links[0].from_node.type.lower()))
                else:
                    dv = s.default_value
                    vals.append('%s %s' % (lab, vec(dv) if hasattr(dv, '__len__') else f(dv)))
            s = n.inputs.get('Normal')
            if s is not None and s.is_linked:
                vals.append('normal<-' + s.links[0].from_node.type.lower())
            return 'bsdf ' + ' '.join(vals)
    return ''


def node_images(nt, seen=None, depth=0):
    imgs, kinds = [], {}
    seen = seen if seen is not None else set()
    for n in nt.nodes:
        kinds[n.type] = kinds.get(n.type, 0) + 1
        if n.type in ('TEX_IMAGE', 'TEX_ENVIRONMENT') and g(n, 'image'):
            imgs.append(n.image)
        if n.type == 'GROUP' and g(n, 'node_tree') and n.node_tree.name not in seen and depth < 4:
            seen.add(n.node_tree.name)
            i2, _ = node_images(n.node_tree, seen, depth + 1)
            imgs += i2
    return imgs, kinds


def materials():
    out = []
    used = set()
    for o in bpy.data.objects:
        for s in g(o, 'material_slots', []):
            if s.material:
                used.add(s.material.name)
    mats = sorted(bpy.data.materials, key=lambda m: m.name)
    pat = ARGS.get('object')
    if pat:
        mats = [m for m in mats if fnmatch.fnmatchcase(m.name, pat)]
    out.append('materiais (%d; contagem de usuarios inclui fake user):' % len(mats))
    lines = []
    for m in mats:
        bits = [m.name, 'usuarios %d%s' % (m.users, ' (fake)' if m.use_fake_user else '')]
        if m.name not in used:
            bits.append('SEM OBJETOS')
        if m.library:
            bits.append('vinculado')
        if g(m, 'is_grease_pencil'):
            bits.append('grease pencil')
        nt = g(m, 'node_tree')
        if nt and g(m, 'use_nodes', True):
            imgs, kinds = node_images(nt)
            bits.append('nos ' + ','.join('%s%s' % (t.lower(), '(%d)' % c if c > 1 else '') for t, c in sorted(kinds.items())))
            p = principled(nt)
            if p:
                bits.append(p)
            if imgs:
                bits.append('imagens ' + ','.join('%s%s' % (i.name, '[AUSENTE]' if img_state(i)[2] == 'AUSENTE' else '') for i in imgs[:6]) + ('+%d' % (len(imgs) - 6) if len(imgs) > 6 else ''))
        else:
            bits.append('sem nos, cor ' + vec(m.diffuse_color))
        bm = g(m, 'blend_method')
        if bm and bm != 'OPAQUE':
            bits.append('blend ' + bm)
        if g(m, 'use_backface_culling'):
            bits.append('backface culling')
        lines.append(' · '.join(bits))
    out.extend(more(lines, CAP, 'use object=<glob> para filtrar por nome de material'))
    return out


def images():
    out = []
    ims = sorted(bpy.data.images, key=lambda i: i.name)
    pat = ARGS.get('object')
    if pat:
        ims = [i for i in ims if fnmatch.fnmatchcase(i.name, pat)]
    out.append('imagens (%d; dimensoes lidas do cabecalho PNG/JPEG, sem carregar pixels):' % len(ims))
    lines = []
    for i in ims:
        src, p, st = img_state(i)
        cs = g(g(i, 'colorspace_settings'), 'name', '?')
        bits = [i.name, src, p or '-', st]
        d = img_dims(i) if st != 'AUSENTE' else ''
        if d:
            bits.append(d)
        if src in ('FILE', 'TILED', 'SEQUENCE', 'MOVIE') and i.filepath and not i.filepath.startswith('//') and not g(i, 'packed_file'):
            bits.append('caminho ABSOLUTO')
        bits += [cs, 'usuarios %d' % i.users]
        if i.library:
            bits.append('vinculada')
        lines.append(' · '.join(bits))
    out.extend(more(lines, CAP, 'use object=<glob> para filtrar por nome de imagem'))
    return out


def libraries():
    out = []
    counts = {}
    for coll in ('objects', 'collections', 'meshes', 'materials', 'node_groups', 'images', 'actions', 'armatures'):
        for idb in getattr(bpy.data, coll):
            if idb.library:
                c = counts.setdefault(idb.library.name, {})
                c[coll] = c.get(coll, 0) + 1
    libs = list(bpy.data.libraries)
    out.append('bibliotecas vinculadas (%d):' % len(libs))
    for l in libs[:CAP]:
        ok = os.path.isfile(absp(l.filepath))
        c = counts.get(l.name, {})
        out.append('%s · %s · %s%s · itens: %s' % (l.name, rel(l.filepath) or '-', 'ok' if ok else 'AUSENTE',
                                                  ' · caminho ABSOLUTO' if l.filepath and not l.filepath.startswith('//') else '',
                                                  ', '.join('%s %d' % kv for kv in sorted(c.items())) or 'nenhum'))
    miss = [idb.name for coll in ('objects', 'collections', 'meshes', 'materials') for idb in getattr(bpy.data, coll) if g(idb, 'is_missing')]
    if miss:
        out.append('itens vinculados ausentes (placeholders): ' + ', '.join(more(miss, 20)))
    if not libs:
        out.append('nenhuma biblioteca vinculada; overrides/assets externos nao existem neste arquivo.')
    return out


def rig_checks(objs, add):
    """Skin: grupos sem osso, vertices sem peso ou com >4 influencias (glTF/engines cortam em 4), actions com ossos inexistentes."""
    nobone, unweighted, over, skipped = [], [], [], []
    budget = [VERT_BUDGET]
    for o in objs:
        mods = [m for m in g(o, 'modifiers', []) if m.type == 'ARMATURE' and g(m, 'object') and g(m.object, 'type') == 'ARMATURE' and g(m, 'use_vertex_groups', True)]
        if o.type != 'MESH' or not mods or not len(o.vertex_groups):
            continue
        bones = set(b.name for m in mods for b in m.object.data.bones)
        deform = set(b.name for m in mods for b in m.object.data.bones if b.use_deform)
        extra = [vg.name for vg in o.vertex_groups if vg.name not in bones]
        if extra:
            nobone.append('%s: %s' % (o.name, ','.join(extra[:6]) + ('+%d' % (len(extra) - 6) if len(extra) > 6 else '')))
        n = len(o.data.vertices)
        if n > budget[0]:
            skipped.append(o.name)
            continue
        budget[0] -= n
        idx = set(vg.index for vg in o.vertex_groups if vg.name in deform)
        none = many = 0
        for v in o.data.vertices:
            c = 0
            for gw in v.groups:
                if gw.group in idx and gw.weight > 0:
                    c += 1
            if c == 0:
                none += 1
            elif c > 4:
                many += 1
        if none:
            unweighted.append('%s: %d de %d' % (o.name, none, n))
        if many:
            over.append('%s: %d' % (o.name, many))
    add('AVISO', 'grupos de vertices sem osso correspondente (nao deformam; nome errado?)', nobone, 'renomeie para o osso certo; ignore se for mascara')
    add('AVISO', 'vertices sem peso de osso deformante (ficam parados/presos a origem na engine)', unweighted, 'pinte pesos ou use Automatic Weights')
    add('AVISO', 'vertices com >4 ossos (glTF/engines mantem so 4; deformacao muda)', over, 'Limit Total (4) + Normalize All')
    add('INFO', 'malhas skinadas nao verificadas (orcamento de %s vertices)' % k(VERT_BUDGET), skipped)
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE' and o.data]
    owner = {}
    for o in arms:
        ad = g(o, 'animation_data')
        for a in ([ad.action] if ad and ad.action else []) + ([st.action for tr in ad.nla_tracks for st in tr.strips if st.action] if ad else []):
            owner.setdefault(a.name, set()).update(b.name for b in o.data.bones)
    bad = []
    for a in bpy.data.actions:
        bones = owner.get(a.name) or (set(b.name for b in arms[0].data.bones) if len(arms) == 1 else None)
        if bones is None:
            continue
        used = set(re.findall(r'pose\.bones\["([^"]+)"\]', ' '.join(c.data_path for c in fcurves(a))))
        miss = sorted(used - bones)
        if miss:
            bad.append('%s: %s' % (a.name, ','.join(miss[:5]) + ('+%d' % (len(miss) - 5) if len(miss) > 5 else '')))
    add('AVISO', 'actions com canais de ossos inexistentes (canais ignorados; action de outro rig?)', bad)


def audit():
    out = []
    sc = pick_scene()
    checks = []  # (sev, titulo, itens, dica)

    def add(sev, title, items, hint='', names=False):
        if items:
            checks.append((sev, '%s (%d)' % (title, len(items)), collapse(items) if names else items, hint))
    D = bpy.data
    pat = ARGS.get('object')
    objs = [o for o in sc.objects if not pat or fnmatch.fnmatchcase(o.name, pat)]
    meshes = [o for o in objs if o.type == 'MESH' and o.data]
    xf = [o for o in objs if o.type in ('MESH', 'ARMATURE') and o.data]  # escala de armature tambem vai para a engine (ossos/animacao)
    visual = [o for o in meshes if not COLLIDER.search(o.name)]  # colisores (UCX_, -col) nao precisam de material/UV
    wired, loose = set(), set()  # imagens em nos de textura ligados / sem nenhuma saida ligada
    for nt in [m.node_tree for m in D.materials if g(m, 'node_tree')] + list(D.node_groups) + [w.node_tree for w in D.worlds if g(w, 'node_tree')]:
        for n in nt.nodes:
            if n.type in ('TEX_IMAGE', 'TEX_ENVIRONMENT') and g(n, 'image'):
                (wired if any(o.is_linked for o in n.outputs) else loose).add(n.image.name)
    gone = [i for i in D.images if img_state(i)[2] == 'AUSENTE']
    add('ERRO', 'imagens ausentes', ['%s -> %s' % (i.name, img_state(i)[1]) for i in gone if i.name not in loose - wired], 'corrija o caminho (relativo //) ou empacote')
    add('INFO', 'imagens ausentes so em nos sem ligacao (nao afetam render/exportacao)', ['%s -> %s' % (i.name, img_state(i)[1]) for i in gone if i.name in loose - wired], 'remova o no ou corrija o caminho')
    add('ERRO', 'bibliotecas ausentes', ['%s -> %s' % (l.name, rel(l.filepath)) for l in D.libraries if not os.path.isfile(absp(l.filepath))])
    add('ERRO', 'dados vinculados ausentes', [x.name for c in ('objects', 'meshes', 'materials', 'collections') for x in getattr(D, c) if g(x, 'is_missing')])
    add('AVISO', 'escala negativa (normais invertidas na exportacao)', [o.name for o in xf if any(x < 0 for x in o.scale)], 'aplique a escala (Ctrl+A) e recalcule normais', names=True)
    add('AVISO', 'escala nao uniforme', ['%s %s' % (o.name, vec(o.scale)) for o in xf if max(abs(x) for x in o.scale) - min(abs(x) for x in o.scale) > 1e-4], 'aplique antes de exportar/usar colisao')
    uni = [o for o in xf if all(abs(x - o.scale[0]) <= 1e-4 for x in o.scale) and abs(o.scale[0] - 1) > 1e-4 and o.scale[0] > 0]
    add('AVISO', 'escala uniforme >=10x ou <=0.1x (tipico de unidades cm/m trocadas; o no exportado herda a escala)', ['%s %s' % (o.name, f(o.scale[0])) for o in uni if max(o.scale[0], 1 / o.scale[0]) >= 10],
        'aplique a escala (armature: aplique com os filhos e confira as actions)')
    add('INFO', 'escala uniforme nao aplicada (!= 1)', ['%s %s' % (o.name, f(o.scale[0])) for o in uni if max(o.scale[0], 1 / o.scale[0]) < 10])
    add('INFO', 'rotacao nao aplicada', [o.name for o in meshes if o.rotation_mode not in ('QUATERNION', 'AXIS_ANGLE') and any(abs(a) > 1e-5 for a in o.rotation_euler)], 'normal em objetos posicionados; aplique so em assets exportados isolados', names=True)
    budget = [POLY_BUDGET]
    users = {}
    for o in meshes:
        users.setdefault(o.data.name, []).append(o.name)
    ng, skipped = [], []
    for mn, os_ in users.items():
        fs = face_sizes(D.meshes[mn], budget) if mn in D.meshes else (0, 0, 0)
        if fs is None:
            skipped.append(mn)
        elif fs[2]:
            ng.append('%s: %d n-gon(s)%s' % (os_[0] if len(os_) == 1 else 'malha ' + mn, fs[2], '' if len(os_) == 1 else ' em %d objetos (%s)' % (len(os_), ', '.join(collapse(os_)[:3]))))
    add('AVISO', 'malhas com n-gons (faces >4 vertices; triangulacao imprevisivel na engine)', ng, 'triangule/quadrangule ou confira o resultado exportado')
    add('INFO', 'malhas nao verificadas para n-gons (orcamento de %s poligonos)' % k(POLY_BUDGET), skipped)
    add('AVISO', 'malhas sem faces', [o.name for o in meshes if len(o.data.polygons) == 0], 'ok se for guia/wire intencional', names=True)
    add('AVISO', 'slots de material vazios', ['%s[%d]' % (o.name, i) for o in objs for i, s in enumerate(g(o, 'material_slots', [])) if not s.material])
    add('AVISO', 'malhas sem material', [o.name for o in visual if not len(o.material_slots) and len(o.data.polygons)], names=True)
    used = set(s.material.name for o in D.objects for s in g(o, 'material_slots', []) if s.material)
    add('INFO', 'materiais sem objetos (so fake user ou orfaos; somem ao salvar sem fake user)', [m.name for m in D.materials if m.name not in used and not m.library and not g(m, 'is_grease_pencil')])
    add('INFO', 'imagens sem usuarios', [i.name for i in D.images if i.users == 0 or i.users == 1 and i.use_fake_user])
    add('AVISO', 'imagens com caminho absoluto (quebra ao mover o projeto)', [i.name for i in D.images if g(i, 'source') in ('FILE', 'TILED') and i.filepath and not i.filepath.startswith('//') and not g(i, 'packed_file') and not i.library])
    uvless = []
    for o in visual:
        if not len(g(o.data, 'uv_layers', [])) and len(o.data.polygons):
            if any(s.material and g(s.material, 'node_tree') and any(n.type == 'TEX_IMAGE' for n in s.material.node_tree.nodes) for s in o.material_slots):
                uvless.append(o.name)
    add('AVISO', 'textura de imagem sem mapa UV', uvless, names=True)
    add('AVISO', 'shape keys + modificadores alem de Armature (exportadores nao aplicam modificadores com shape keys)',
        [o.name for o in meshes if g(o.data, 'shape_keys') and any(m.type != 'ARMATURE' and m.show_viewport for m in o.modifiers)], names=True)
    rig_checks(objs, add)
    add('AVISO', 'modificador Armature sem grupos de vertices', [o.name for o in meshes if any(m.type == 'ARMATURE' for m in o.modifiers) and not len(o.vertex_groups)], names=True)
    add('AVISO', 'modificador Armature sem objeto', ['%s/%s' % (o.name, m.name) for o in objs for m in o.modifiers if m.type == 'ARMATURE' and not g(m, 'object')])
    add('AVISO', 'modificador Boolean sem objeto/colecao', ['%s/%s' % (o.name, m.name) for o in objs for m in o.modifiers if m.type == 'BOOLEAN' and not g(m, 'object') and not g(m, 'collection')])
    cs_bad = []
    for m in D.materials:
        nt = g(m, 'node_tree')
        if not nt:
            continue
        for l in nt.links:
            fn, tn = l.from_node, l.to_node
            if fn.type != 'TEX_IMAGE' or not g(fn, 'image'):
                continue
            csn = g(g(fn.image, 'colorspace_settings'), 'name', '')
            if tn.type == 'NORMAL_MAP' and csn in ('sRGB', 'Filmic sRGB', 'AgX Base sRGB'):
                cs_bad.append('%s: %s sRGB em Normal Map' % (m.name, fn.image.name))
            if tn.type == 'BSDF_PRINCIPLED' and l.to_socket.name in ('Metallic', 'Roughness') and csn == 'sRGB':
                cs_bad.append('%s: %s sRGB em %s' % (m.name, fn.image.name, l.to_socket.name))
    add('AVISO', 'espaco de cor suspeito (dados devem ser Non-Color)', cs_bad)
    dup = sorted(set(x.name for c in ('objects', 'materials', 'images') for x in getattr(D, c) if not x.library and len(x.name) > 4 and x.name[-4] == '.' and x.name[-3:].isdigit()))
    add('INFO', 'nomes com sufixo .001 (duplicatas; nomes viram nomes de no/material na engine)', dup)
    heavy = []
    for o in meshes:
        e, t = estimate(o), mesh_counts(o.data)[2]
        heavy.append((e[1] if e else t, o.name, t, bool(e and e[2])))
    add('INFO', 'malhas acima de 100k triangulos (apos modificadores, estimado)', ['%s t%s%s%s' % (n, k(t), '?' if u else '', '' if t == b else ' (base t%s)' % k(b))
                                                                               for t, n, b, u in sorted(heavy, reverse=True) if t > 100_000])
    pot, big = [], []
    for i in D.images:
        if i.users and g(i, 'source') in ('FILE', 'TILED') and i.name in wired | loose:
            d = img_dims(i)
            if d:
                w, h = map(int, d.split('x'))
                if w & (w - 1) or h & (h - 1):
                    pot.append('%s %s' % (i.name, d))
                if max(w, h) >= 4096:
                    big.append('%s %s' % (i.name, d))
    add('AVISO', 'texturas com lado nao potencia de 2 (sem compressao/mipmaps eficientes em algumas engines)', pot, 'redimensione para 2^n (512, 1024, 2048)')
    add('INFO', 'texturas >= 4096 px (memoria de GPU; confira o limite do alvo)', big)
    drv = []
    for c in ('objects', 'meshes', 'shape_keys', 'materials', 'armatures', 'node_groups'):
        for idb in getattr(D, c):
            ad = g(idb, 'animation_data')
            for d in (ad.drivers if ad else []):
                drv.append('%s: %s (%s)' % (key_owner(idb) if c == 'shape_keys' else idb.name, d.data_path, d.driver.type))
    add('INFO', 'drivers (engines nao importam drivers; expressoes Python nunca sao avaliadas aqui)', drv, 'asse em keyframes/shape keys se o efeito precisa ir para a engine')
    far = []
    for o in visual:
        bb = [tuple(c) for c in o.bound_box]
        lo, hi = [min(c[a] for c in bb) for a in range(3)], [max(c[a] for c in bb) for a in range(3)]
        size = max(hi[a] - lo[a] for a in range(3))
        if size > 0 and any(lo[a] - 0.25 * size > 0 or hi[a] + 0.25 * size < 0 for a in range(3)):
            far.append(o.name)
    add('INFO', 'origem fora da geometria (pivo deslocado na engine)', far, 'ok em cenas montadas; em asset isolado use Origin to Geometry/3D cursor', names=True)
    us = sc.unit_settings
    if abs(us.scale_length - 1) > 1e-6:
        add('INFO', 'escala de unidade da cena != 1', ['scale_length %s' % f(us.scale_length)], 'exportadores glTF/FBX podem aplicar ou ignorar; confira o importador')
    ne = sum(1 for c in checks if c[0] == 'ERRO')
    nw = sum(1 for c in checks if c[0] == 'AVISO')
    out.append('auditoria cena %s%s: %d objetos, %d malhas · %d erro(s), %d aviso(s), %d info(s)' % (sc.name, ' filtro "%s"' % pat if pat else '', len(objs), len(meshes), ne, nw, len(checks) - ne - nw))
    order = {'ERRO': 0, 'AVISO': 1, 'INFO': 2}
    for sev, title, items, hint in sorted(checks, key=lambda c: order[c[0]]):
        out.append('[%s] %s: %s%s' % (sev, title, '; '.join(more(items, EX)), ' -> ' + hint if hint else ''))
    if not checks:
        out.append('nenhum problema nas verificacoes cobertas.')
    out.append('nao cobre: geometria nao-manifold, vertices soltos/duplicados, normais invertidas de faces, sobreposicao de UV, qualidade dos pesos de skin, geometria real apos nos/booleanos, dimensoes de texturas fora de PNG/JPEG. Detalhe: mode=object object=<nome>.')
    return out


MODES = {'summary': summary, 'object': object_mode, 'materials': materials, 'images': images, 'audit': audit, 'libraries': libraries}


def render(mode):
    # Nomes com quebras/controles nao podem forjar linhas da resposta.
    text = '\n'.join(re.sub(r'[\x00-\x1f\x7f]', '?', line) for line in MODES[mode]())
    return text[:400_000] + ('\n[saida truncada]' if len(text) > 400_000 else '')


def main():
    want = ARGS.get('file')
    mode = ARGS.get('mode', 'summary')
    if mode not in MODES or not want:
        raise Exception('mode/arquivo invalido')
    bpy.app.handlers.load_post.append(bpy.app.handlers.persistent(lambda *a: throttle_heavy()))  # sem persistent o load limpa o handler
    try:
        # use_scripts=False reforca o -Y: drivers Python e text blocks registrados nao executam.
        bpy.ops.wm.open_mainfile(filepath=want, load_ui=False, use_scripts=False)
    except Exception as e:
        raise Exception('Blender nao abriu o arquivo pedido (versao incompativel ou arquivo corrompido): %s' % str(e).strip()[:300])
    finally:
        bpy.app.handlers.load_post.clear()
    if os.path.normcase(os.path.realpath(bpy.data.filepath or '')) != os.path.normcase(os.path.realpath(want)):
        raise Exception('Blender nao abriu o arquivo pedido (versao incompativel ou arquivo corrompido); veja o log.')
    res = {'text': render(mode)}
    # Companheiros: os outros modos com os mesmos filtros saem da mesma abertura (custo de ms) e vao para o cache do app.
    if ARGS.get('companions') and mode != 'object':
        res['more'] = {}
        for m in ('summary', 'audit', 'materials', 'images', 'libraries'):
            if m != mode and (m in ('summary', 'audit') or not ARGS.get('scene')):
                try:
                    res['more'][m] = render(m)
                except Exception:
                    pass
    res['deps'] = deps()
    return res


if hasattr(signal, 'alarm') and ARGS.get('deadline'):
    signal.alarm(int(ARGS['deadline']))  # POSIX: SIGALRM encerra o processo mesmo se o app morrer sem mata-lo (sem orfaos)
try:
    res = main()
except Exception as e:  # erro legivel; o traceback fica no log do processo
    import traceback
    traceback.print_exc()
    res = {'error': str(e)[:1000]}
n = ARGS.get('nonce', '')
sys.stdout.write('\n<<ORBIT-%s>>%s<<END-%s>>\n' % (n, json.dumps(res), n))
sys.stdout.flush()
