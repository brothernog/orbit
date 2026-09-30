---
name: blender
description: Fluxo economico para arquivos .blend no Orbit (blender_project, blender_scene, blender_diagnostics): entender cenas, objetos, materiais e texturas sem abrir o Blender na mao nem escrever scripts ad hoc, auditar assets antes de exportar e alterar .blend com seguranca via script headless. Use em qualquer tarefa numa pasta com arquivos .blend quando o organizador tem Blender ativo.
---

# Blender: perguntar antes de abrir

.blend e binario: nao tente le-lo como texto nem edita-lo a mao. As ferramentas `blender_*` respondem com fatos curtos, paginados (`offset` + `hash`) e sem chamada de IA. `blender_scene` abre o Blender local em segundo plano com scripts embutidos desativados (`-Y`), nunca salva e guarda o resultado em cache: repetir a mesma pergunta sobre o mesmo arquivo nao custa nada, e a primeira consulta ja deixa `summary`, `audit`, `materials`, `images` e `libraries` (com os mesmos filtros) no cache. Modificadores muito pesados (subsurf alto etc.) nao sao avaliados ao abrir: a resposta diz quais e traz a estimativa. Nao peca ao usuario o que as ferramentas respondem.

## Ordem recomendada

1. `blender_project` uma vez por tarefa: versao do Blender local, lista de .blend (tamanho, versao salva, compressao, backups). Nao abre arquivos. "MAIS NOVO que o Blender" = nao salve esse arquivo com o Blender local.
2. `blender_scene path=<arquivo>` (mode `summary`): cena, unidades, colecoes, tipos, actions (frames, fake user, quem usa), totais de malha e arvore de objetos. `t` = triangulos da malha base; `~t` = estimativa apos modificadores (o que a engine recebe; `?` = incerto por nos/remesh); instancias de colecao trazem os triangulos da colecao. Para reduzir poligonos, comece por "malhas mais pesadas" e pelos `~t`. Series (Tree001..Tree999) aparecem agregadas; listas longas terminam com "+N mais" e uma dica.
3. Desca so o necessario:
   - `mode=object object=<nome exato>`: transformacoes (escala/rotacao aplicadas?), modificadores com o que difere do padrao, constraints, slots de material, UV, grupos de vertices, shape keys (e drivers delas), props custom, animacao; em armature: ossos, malhas deformadas e actions de pose com ossos inexistentes;
   - `mode=materials` (nos, valores do Principled, texturas ligadas), `mode=images` (caminho, AUSENTE/ok/empacotada, dimensoes, espaco de cor), `mode=libraries` (links e ausentes);
   - `object=<glob>` filtra nomes em summary/audit/materials/images (ex.: `Tree*`, `*_LOD0`); `scene=<nome>` escolhe outra cena.
4. `mode=audit` ANTES de exportar ou entregar um asset, e de novo depois de corrigir. Cobre: arquivos/bibliotecas ausentes, escala (negativa, nao uniforme, 100x/0.01x de unidades), n-gons, UV, materiais, espaco de cor, texturas nao potencia de 2 e >= 4096, skin (grupos sem osso, vertices sem peso ou com >4 ossos), actions com ossos inexistentes, drivers, malhas >100k triangulos apos modificadores, origem fora da geometria. Colisores `UCX_`/`-col` nao exigem material/UV. "Personagem errado na engine" = audit + `mode=object` do armature.

## Alterar um .blend com seguranca

- Escreva um script bpy no repositorio (ex.: `tools/blender/fix_scale.py`), idempotente e explicito sobre os objetos alvo (nomes vindos do summary).
- Rode headless: `blender -b models/x.blend --python tools/blender/fix_scale.py` e salve em arquivo NOVO (`bpy.ops.wm.save_as_mainfile(filepath=..._fixed.blend)`) ou so depois de copiar o original. Nunca sobrescreva sem backup; o usuario pode ter o arquivo aberto.
- Capture o log (`> logs/fix.log 2>&1`) e leia com `blender_diagnostics path=logs/fix.log` (traceback com arquivo:linha do SEU script quando ele aparece na pilha e a causa de erros aninhados de operadores, erros, avisos, arquivos ausentes). Codigo de saida 0 nao prova sucesso.
- Verifique com `blender_scene` (object/audit) no arquivo resultante. Registre a evidencia com `test_evidence` quando disponivel.

## Exportar para engine (glTF/FBX)

- Aplique escala/rotacao (audit aponta escala nao aplicada, negativa ou nao uniforme); escala negativa inverte normais.
- glTF: +Y up e o padrao do exportador (`export_yup=True`); unidades em metros; confira `scale_length` da cena. FBX: use `apply_unit_scale` e `axis_forward='-Z', axis_up='Y'` para Unity/Godot, e confira a escala no importador.
- Modificadores (exceto Armature) com shape keys nao sao aplicados pelos exportadores: aplique antes ou remova. Aplique a escala do armature junto com os filhos (senao as actions saem em escala errada) e limite a 4 influencias por vertice.
- Texturas: caminhos relativos (`//`) ou empacotadas; normal/roughness/metallic em Non-Color. Imagem AUSENTE vira material sem textura na engine.
- N-gons sao triangulados de forma imprevisivel; triangule/quadrangule o que deforma. Nomes `.001` viram nomes de nos/materiais na engine.

## O que as ferramentas nao fazem

Nao salvam, nao exportam, nao renderizam e nao executam scripts do agente. `t` e da malha base; `~t` e estimativa aritmetica; so `mode=object` avalia de fato (exceto objetos pesados com estimativa exata). Nao verificam geometria nao-manifold, vertices duplicados, normais por face, sobreposicao de UV nem a qualidade dos pesos: para isso, escreva um script de verificacao e rode headless como acima. `blender_diagnostics` le so logs .log/.txt dentro do workspace.
