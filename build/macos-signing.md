# Assinatura e notarização no macOS

O `electron-builder.yml` assina (Developer ID + Hardened Runtime) e notariza **só quando há credenciais no ambiente**. Sem elas o build segue como antes: o app sai com assinatura ad-hoc e o dmg não é aceito pelo Gatekeeper quando baixado da internet.

- Um dmg por arquitetura: `Orbita-<versão>-arm64.dmg` (Apple Silicon) e `Orbita-<versão>-x64.dmg` (Intel).
- Entitlements em `build/entitlements.mac.plist`: só `com.apple.security.cs.allow-jit` (o V8 precisa). O app não usa sandbox; as CLIs (claude, codex, gemini, opencode) rodam como processos filhos com a própria assinatura e não precisam de entitlement.
- Windows e Linux continuam sem assinatura.

## O que o mantenedor precisa

1. **Apple Developer Program** (pago, anual), conta individual ou de organização.
2. **Certificado "Developer ID Application"** (não "Apple Development" nem "Mac App Store"). Crie em developer.apple.com > Certificates ou no Xcode > Settings > Accounts > Manage Certificates. No Acesso às Chaves, exporte o certificado **com a chave privada** como `.p12`, com senha, e converta:

   ```bash
   base64 -i DeveloperID.p12 | pbcopy   # vai para o segredo CSC_LINK
   ```

3. **Chave da API do App Store Connect** para notarizar (appstoreconnect.apple.com > Usuários e Acesso > Integrações > Chaves da equipe, função "Developer"). Baixe o `AuthKey_XXXXXXXXXX.p8` (só dá para baixar uma vez) e anote o **Key ID** e o **Issuer ID**.

## Segredos do GitHub

Settings > Secrets and variables > Actions > New repository secret:

| Segredo | Conteúdo |
| --- | --- |
| `CSC_LINK` | o `.p12` em base64 |
| `CSC_KEY_PASSWORD` | senha do `.p12` |
| `APPLE_API_KEY` | o **conteúdo** do `.p8` (o CI grava num arquivo temporário) |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

- Sem nenhum deles: dmg sem assinatura Developer ID (é o caso de forks, que não recebem segredos).
- Só `CSC_*`: assinado, não notarizado (o Gatekeeper ainda bloqueia o download). O job avisa.
- Um grupo incompleto (`CSC_LINK` sem senha, ou só parte das `APPLE_API_*`) falha o job de propósito.

Os instaladores saem em Actions > CI > Run workflow (artefatos) ou numa tag `v*`, que também cria o Release do GitHub com os arquivos das três plataformas (tag com `-`, como `v1.2.0-beta.1`, vira pre-release).

## Assinar localmente

Com o certificado Developer ID já no seu Acesso às Chaves:

```bash
security find-identity -v -p codesigning             # confira o nome da identidade
export CSC_NAME="Fulano de Tal (ABCDE12345)"          # sem o prefixo "Developer ID Application:"
export APPLE_API_KEY=~/keys/AuthKey_XXXXXXXXXX.p8     # aqui é o caminho do arquivo
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
npm run dist
```

Sem `CSC_NAME` o electron-builder procura sozinho uma identidade válida no Acesso às Chaves; `CSC_IDENTITY_AUTO_DISCOVERY=false` desliga essa busca. Também dá para usar `CSC_LINK`/`CSC_KEY_PASSWORD` como no CI, ou notarizar com `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` em vez da chave da API. Sem as variáveis de notarização o build só avisa e segue.

## Conferir

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Orbita.app
codesign -dv --verbose=4 dist/mac-arm64/Orbita.app   # Authority=Developer ID Application..., flags=0x10000(runtime)
xcrun stapler validate dist/mac-arm64/Orbita.app     # ticket de notarização grampeado
spctl -a -vvv -t exec dist/mac-arm64/Orbita.app      # accepted, source=Notarized Developer ID
```

O que é notarizado e grampeado é o `.app`; o dmg em si não é assinado. Por isso `spctl -a -vvv -t install` rejeita o dmg mesmo com o app certo dentro: use `-t exec` no `.app` (inclusive depois de copiá-lo do dmg para /Applications).

## Uso pessoal, sem pagar a Apple

- **App compilado na própria máquina não recebe quarentena**: `npm run dist` e abrir `dist/mac-arm64/Orbita.app` (ou instalar o dmg gerado ali) funciona sem Gatekeeper, sem certificado.
- **Apple Silicon exige que todo código arm64 tenha ao menos assinatura ad-hoc**; sem ela o sistema mata o processo ao abrir. Trocar os fuses do Electron invalida a assinatura original do binário, por isso o `electron-builder.yml` usa `electronFuses.resetAdHocDarwinSignature: true`, que reassina ad-hoc logo depois. Com Developer ID, a assinatura real substitui essa.
- **Ad-hoc explícito** (`identity: '-'`): assina tudo sem certificado, mas não identifica o autor, não pode ser notarizado e **não passa pelo Gatekeeper em app baixado**. Com Hardened Runtime também exige `com.apple.security.cs.disable-library-validation` (ou `hardenedRuntime: false`), senão o app não abre:

  ```bash
  npx electron-builder -c.mac.identity=- -c.mac.hardenedRuntime=false
  ```

- Quem baixar um dmg sem assinatura Developer ID precisa liberar o app: tentar abrir uma vez e depois Ajustes do Sistema > Privacidade e Segurança > Abrir Mesmo Assim (no macOS 15+ o botão direito > Abrir já não basta), ou, sabendo a origem, `xattr -dr com.apple.quarantine /Applications/Orbita.app`.
