# Orbit: introspeccao SOMENTE LEITURA de um .blend (Blender 3.6+). Executado pelo app com
# `blender -b --factory-startup -Y <arquivo> --python orbit_inspect.py -- <json>`; nunca salva nem altera arquivos.
# Saida: um JSON (ASCII) entre marcadores com nonce; o texto e compacto, limitado e com dicas de detalhamento.
import bpy, sys, os, re, json, fnmatch, difflib, struct

ARGS = json.loads(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else {}
ROOT = os.path.realpath(ARGS.get('root') or os.getcwd())
CAP = 150  # linhas de objetos/itens por listagem
EX = 8  # exemplos por verificacao de auditoria
POLY_BUDGET = 5_000_000  # poligonos iterados para contar n-gons


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
            with open(p, 'rb') as fh:
                head = fh.read(65536)
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
        fc = g(act, 'fcurves')
        if fc is None:  # actions em camadas (4.4+/5.x)
            n = 0
            for layer in g(act, 'layers', []):
                for st in g(layer, 'strips', []):
                    for cb in g(st, 'channelbags', []):
                        n += len(g(cb, 'fcurves', []))
        else:
            n = len(fc)
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
    elif o.type == 'LIGHT' and o.data:
        bits.append(o.data.type)
    elif o.type == 'EMPTY' and g(o, 'instance_collection'):
        bits.append('instancia ' + o.instance_collection.name)
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
    orphan = sum(1 for o in D.objects if not o.users_scene)
    out.append('dados: meshes %d · materiais %d · imagens %d%s · bibliotecas %d%s · actions %d · node groups %d · armatures %d%s' % (
        len(D.meshes), len(D.materials), len(D.images), ' (AUSENTES %d)' % miss_i if miss_i else '', len(D.libraries),
        ' (AUSENTES %d)' % miss_l if miss_l else '', len(D.actions), len(D.node_groups), len(D.armatures),
        ' · %d objetos fora de cenas' % orphan if orphan else ''))
    tv = tf = tt = 0
    meshes = []
    for o in objs:
        if o.type == 'MESH' and o.data:
            v, fc, t = mesh_counts(o.data)
            tv += v; tf += fc; tt += t
            meshes.append((t, o.name))
    out.append('malha na cena (base, sem modificadores; instancias contadas por objeto): v%s f%s t%s' % (k(tv), k(tf), k(tt)))
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
                me = sc.objects[n].data.name
                per.setdefault(me, [t, n, 0, me])[2] += 1
            top = sorted(per.values(), reverse=True)[:10]
            out.append('malhas mais pesadas: ' + ', '.join('%s t%s' % (n, k(t)) if c == 1 else 'malha %s t%s x%d obj (%s...)' % (me, k(t), c, n) for t, n, c, me in top))
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
        if len(o.modifiers) and o.users_scene and len(o.users_scene[0].objects) <= 2000:
            # Avaliacao so para este caso (modificadores e cena moderada): custo do depsgraph cresce com a cena.
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
        out.append('shape keys (%d): %s' % (len(sk.key_blocks), ', '.join(more([b.name for b in sk.key_blocks], 30))))
    props = [(kk, o[kk]) for kk in o.keys() if not kk.startswith('_')] if hasattr(o, 'keys') else []
    if props:
        out.append('propriedades custom: ' + ', '.join(more(['%s=%s' % (kk, str(vv)[:40]) for kk, vv in props], 20)))
    an = action_info(g(o, 'animation_data'))
    if an:
        out.append('animacao: ' + an)
    if o.type == 'ARMATURE' and data:
        out.append('ossos (%d): %s' % (len(data.bones), ', '.join(more([b.name for b in data.bones], 40))))
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
    add('ERRO', 'imagens ausentes', ['%s -> %s' % (i.name, img_state(i)[1]) for i in D.images if img_state(i)[2] == 'AUSENTE'], 'corrija o caminho (relativo //) ou empacote')
    add('ERRO', 'bibliotecas ausentes', ['%s -> %s' % (l.name, rel(l.filepath)) for l in D.libraries if not os.path.isfile(absp(l.filepath))])
    add('ERRO', 'dados vinculados ausentes', [x.name for c in ('objects', 'meshes', 'materials', 'collections') for x in getattr(D, c) if g(x, 'is_missing')])
    add('AVISO', 'escala negativa (normais invertidas na exportacao)', [o.name for o in meshes if any(x < 0 for x in o.scale)], 'aplique a escala (Ctrl+A) e recalcule normais', names=True)
    add('AVISO', 'escala nao uniforme', ['%s %s' % (o.name, vec(o.scale)) for o in meshes if max(abs(x) for x in o.scale) - min(abs(x) for x in o.scale) > 1e-4], 'aplique antes de exportar/usar colisao')
    add('INFO', 'escala uniforme nao aplicada (!= 1)', ['%s %s' % (o.name, f(o.scale[0])) for o in meshes if all(abs(x - o.scale[0]) <= 1e-4 for x in o.scale) and abs(o.scale[0] - 1) > 1e-4])
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
    add('AVISO', 'malhas sem material', [o.name for o in meshes if not len(o.material_slots) and len(o.data.polygons)], names=True)
    used = set(s.material.name for o in D.objects for s in g(o, 'material_slots', []) if s.material)
    add('INFO', 'materiais sem objetos (so fake user ou orfaos; somem ao salvar sem fake user)', [m.name for m in D.materials if m.name not in used and not m.library and not g(m, 'is_grease_pencil')])
    add('INFO', 'imagens sem usuarios', [i.name for i in D.images if i.users == 0 or i.users == 1 and i.use_fake_user])
    add('AVISO', 'imagens com caminho absoluto (quebra ao mover o projeto)', [i.name for i in D.images if g(i, 'source') in ('FILE', 'TILED') and i.filepath and not i.filepath.startswith('//') and not g(i, 'packed_file') and not i.library])
    uvless = []
    for o in meshes:
        if not len(g(o.data, 'uv_layers', [])) and len(o.data.polygons):
            if any(s.material and g(s.material, 'node_tree') and any(n.type == 'TEX_IMAGE' for n in s.material.node_tree.nodes) for s in o.material_slots):
                uvless.append(o.name)
    add('AVISO', 'textura de imagem sem mapa UV', uvless, names=True)
    add('AVISO', 'shape keys + modificadores (exportadores nao aplicam modificadores com shape keys)', [o.name for o in meshes if g(o.data, 'shape_keys') and len(o.modifiers)], names=True)
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
    heavy = [(mesh_counts(o.data)[2], o.name) for o in meshes]
    add('INFO', 'malhas acima de 100k triangulos (base)', ['%s t%s' % (n, k(t)) for t, n in sorted(heavy, reverse=True) if t > 100_000])
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
    out.append('nao cobre: geometria nao-manifold, vertices soltos/duplicados, normais invertidas de faces, sobreposicao de UV, pesos de skin, resultado apos modificadores, texturas que so existem na engine. Detalhe: mode=object object=<nome>.')
    return out


def main():
    want = ARGS.get('file')
    if want and os.path.normcase(os.path.realpath(bpy.data.filepath or '')) != os.path.normcase(os.path.realpath(want)):
        raise Exception('Blender nao abriu o arquivo pedido (versao incompativel ou arquivo corrompido); veja o log.')
    mode = ARGS.get('mode', 'summary')
    fn = {'summary': summary, 'object': object_mode, 'materials': materials, 'images': images, 'audit': audit, 'libraries': libraries}.get(mode)
    if not fn:
        raise Exception('mode invalido')
    # Nomes com quebras/controles nao podem forjar linhas da resposta.
    text = '\n'.join(re.sub(r'[\x00-\x1f\x7f]', '?', line) for line in fn())
    return {'text': text[:400_000] + ('\n[saida truncada]' if len(text) > 400_000 else ''), 'deps': deps()}


try:
    res = main()
except Exception as e:  # erro legivel; o traceback fica no log do processo
    import traceback
    traceback.print_exc()
    res = {'error': str(e)[:1000]}
n = ARGS.get('nonce', '')
sys.stdout.write('\n<<ORBIT-%s>>%s<<END-%s>>\n' % (n, json.dumps(res), n))
sys.stdout.flush()
