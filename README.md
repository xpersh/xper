# xper

`xper` es un harness de desarrollo multiagente basado en prácticas de
Extreme Programming. Se integra en Pi como agente principal y añade una capa
de coordinación para gobernar el workflow, asignar modelos según el rol y
conservar evidencia local sobre calidad, tiempo, coste y rework.

> Estado: fundaciones ejecutables. El workspace, el kernel mínimo, el bridge
> Rust/TypeScript y el adaptador mínimo de Pi existen; el workflow completo
> sigue en desarrollo.

## Objetivo

Transformar una intención de desarrollo en incrementos pequeños, verificables
e integrables mediante:

- Un workflow XP con feedback y retrocesos explícitos.
- Roles multiagente con responsabilidades y permisos definidos.
- Routing multimodelo reproducible por contexto, rol y fase.
- Separación estricta entre identidades personales, corporativas y de cliente.
- Observabilidad local para comparar ejecuciones, modelos y estrategias.

La unidad principal de trabajo no es el proyecto completo, sino un
**incremento vertical de valor** que pueda definirse, implementarse, verificar
y aceptar de forma independiente.

## Documentos de diseño

- [RFC 0001: Producto y workflow](docs/rfcs/0001-producto-y-workflow.md)
- [RFC 0002: Configuración y routing multimodelo](docs/rfcs/0002-configuracion-multimodelo.md)
- [RFC 0003: Observabilidad y métricas](docs/rfcs/0003-observabilidad-y-metricas.md)
- [RFC 0004: Integración con Pi y agente principal](docs/rfcs/0004-integracion-con-pi.md)
- [RFC 0005: Arquitectura modular y adaptadores de harness](docs/rfcs/0005-arquitectura-modular.md)

## Camino de implementación

El backlog técnico está organizado como una secuencia de tareas pequeñas y
verificables en [docs/tasks/README.md](docs/tasks/README.md). La primera meta no
es implementar todo el workflow, sino validar una vertical slice completa
desde Pi hasta el core y SQLite.

## Definición resumida

> xper es un harness XP multiagente, multimodelo y observable que coordina
> incrementos de software, enruta cada rol hacia el modelo apropiado y registra
> evidencia local para medir tiempo, coste, rework, calidad y rendimiento de
> forma reproducible.

## Principios

- Las fases son gates de conocimiento, no silos ni un waterfall.
- El coordinador gobierna el proceso; no actúa como desarrollador jefe.
- Los agentes se comunican mediante artefactos y contratos estructurados.
- Verify se ejecuta continuamente junto con Implementation.
- Un fallo vuelve a la fase donde se originó, no siempre a Implementation.
- El routing de modelos es determinista y auditable por defecto.
- Las credenciales y los datos de trabajo y personales nunca se mezclan de
  forma implícita.
- La observabilidad nunca debe impedir que el workflow continúe.
- Las métricas miden el comportamiento del sistema, no el valor humano ni la
  productividad individual.

## Relación con Pi

Pi permanece como runtime y experiencia interactiva. En la primera versión,
`xper` se materializa como un agente `primary` de Pi mediante
[`pi-open-agents`](https://pi.dev/packages/pi-open-agents), acompañado de una
extensión propia para el workflow, los comandos, el estado, la observabilidad
y el lifecycle durable de las delegaciones. El
[spike XP-001](docs/spikes/001-integracion-pi.md) descartó usar la API interna
de `pi-open-agents` como plano de control de attempts.

Pi es el primer adaptador, no una dependencia del dominio. El núcleo de xper
se diseña en Rust y se comunica mediante un protocolo versionado con
adaptadores externos, que pueden estar escritos en la tecnología requerida por
cada harness. La extensión TypeScript de Pi traduce su API, hooks y TUI a ese
contrato sin introducir tipos ni conceptos de Pi en la máquina de estados XP.

El usuario inicia Pi con `xper` como agente principal:

```bash
pi --approve --agent xper
```

En este checkout, prepara el bridge y la extensión antes del primer arranque:

```bash
npm ci
npm run build --workspace @xper/adapter-pi
cargo build -p xper-cli
pi install -l npm:pi-open-agents@0.1.22
pi --approve --agent xper
```

La definición `primary` está en `.pi/agents/xper.md`; `.pi/settings.json` fija
`pi-open-agents@0.1.22` para este proyecto. La extensión de `.pi/extensions`
usa `target/debug/xper` cuando existe y permite seleccionar otro binario con
`XPER_BRIDGE_COMMAND`. Inicia y cierra el proceso con la sesión de Pi. El
comando `/xper status` muestra las versiones del adapter, protocolo y bridge,
además del estado de la conexión y los contadores de `subagent`. Una caída del
bridge deja la sesión de Pi utilizable y aparece como `offline`.

Para conservar observaciones entre sesiones del prototipo `0.0.1`:

```bash
mkdir -p .xper/observations
XPER_PI_OBSERVATIONS_FILE="$PWD/.xper/observations/pi.jsonl" pi --approve --agent xper
```

El logger Winston escribe JSONL con rotación por tamaño: 5 MiB por archivo y
cinco archivos como máximo (el actual y cuatro anteriores). Conserva el inicio
y fin de sesión, el estado del bridge, las invocaciones de `/xper` (sin
argumentos) y las señales de `subagent`; no guarda tareas, prompts ni salidas.
Si no se configura el archivo, los contadores de la sesión siguen disponibles.
`reported done` sólo refleja lo comunicado por `pi-open-agents`: el
[spike](docs/spikes/001-integracion-pi.md)
demostró que una cancelación temprana puede parecer un éxito. La decisión de
usarlo provisionalmente y los criterios para revisarla están en el
[RFC 0004](docs/rfcs/0004-integracion-con-pi.md).

También puede activarlo dentro de una sesión con `/agent xper`. El CLI de
`xper` configura, valida, diagnostica y exporta información; no sustituye la
ejecución interactiva de Pi con un comando `xper run`.

`xper doctor` inspecciona Pi, `pi-open-agents`, el adapter, el agente principal,
conflictos y configuración sin modificar archivos ni paquetes. `--json` devuelve
checks con IDs estables y sale con código distinto de cero si alguno falla:

```bash
xper doctor
xper doctor --json
```

`xper init` prepara el proyecto actual; `xper init --global` prepara el scope
del usuario. Crea la configuración y la definición `primary` sólo tras pasar el
preflight. Pide confirmación para crear o reparar el agente; en scripts se puede
autorizar con `--yes`. Una reparación guarda la definición anterior como
`xper.md.bak`. Los archivos existentes válidos se preservan y repetir `init` es
idempotente. Si falta una dependencia, el comando indica cómo instalarla y no
instala paquetes automáticamente:

```bash
pi install npm:pi-open-agents
```

La configuración se combina por claves: defaults, global
(`${XDG_CONFIG_HOME:-~/.config}/xper/config.yaml`), proyecto
(`.xper/config.yaml`) y local (`.xper/config.local.yaml`), en ese orden. Los
arrays y escalares del scope superior reemplazan los inferiores. La configuración
local se añade a `.gitignore` durante `init`. Las claves de credenciales se
rechazan; se usan el almacén de Pi o variables de entorno. El lector admite
mapas y listas YAML por indentación, escalares y JSON; rechaza características
YAML avanzadas como anclas y tags.

Referencias:

- [Pi](https://pi.dev/)
- [SDK de Pi](https://pi.dev/docs/latest/sdk)
- [Extensiones y eventos](https://pi.dev/docs/latest/extensions)
- [Modelos personalizados](https://pi.dev/docs/latest/models)
- [pi-open-agents](https://pi.dev/packages/pi-open-agents)

## Desarrollo

El repositorio requiere Rust `1.97.0`, Node.js `24` y npm `11`. El toolchain
de Rust está fijado en `rust-toolchain.toml` y las dependencias JavaScript en
`package-lock.json`.

Una instalación limpia ejecuta todas las comprobaciones así:

```bash
npm ci
npm run check
```

Los gates también pueden ejecutarse por separado:

```bash
npm run format:check  # rustfmt + Biome
npm run lint          # Clippy + Biome + límites de dependencias
npm run typecheck     # TypeScript estricto
npm test              # tests Rust + TypeScript
```

`npm run format` aplica el formato de Rust y TypeScript/JavaScript/JSON. El
mismo conjunto de gates se ejecuta en CI.

## Layout inicial

XP-002 crea sólo los módulos necesarios para M1:

```text
crates/
├── xper-domain/         # dominio puro
├── xper-application/    # casos de uso y puertos
├── xper-protocol/       # contrato público neutral
├── xper-config/         # infraestructura de configuración
├── xper-store-sqlite/   # infraestructura de persistencia
└── xper-cli/            # binario xper
adapters/
└── pi/                  # paquete TypeScript del adaptador
schemas/                 # límite público de JSON Schema
fixtures/                # mensajes neutrales para contract tests
```

El layout coincide con RFC 0005, por lo que no requiere un ADR adicional. Los
crates futuros (`xper-workspaces`, `xper-observability` y `xper-tui`) se
añadirán cuando una tarea necesite comportamiento real en esas capas.

`scripts/check-boundaries.mjs` valida el grafo del workspace: el dominio no
puede tener dependencias ni usar APIs de I/O, la aplicación sólo depende del
dominio, la infraestructura y el CLI apuntan hacia dentro, y el adaptador Pi
no puede importar internals del core. Entre paquetes propios, el único límite
admitido para el adaptador es el protocolo público.

## Bridge v1

El bridge se inicia con `xper bridge --stdio` (o
`cargo run -p xper-cli -- bridge --stdio` durante el desarrollo). Usa un frame
JSON-RPC 2.0 por línea, hasta 64 KiB por mensaje. `stdout` transporta sólo
frames; los diagnósticos se escriben en `stderr`. El contrato público está en
[schemas/protocol-v1.schema.json](schemas/protocol-v1.schema.json), con mensajes
compartidos para tests en [fixtures/protocol-v1.json](fixtures/protocol-v1.json).

El cliente TypeScript exporta `connectBridge` desde `@xper/adapter-pi`. Envía
`initialize` con nombre, versión y capacidades del adaptador; el bridge pide
`capabilities` al cliente y el cliente consulta las capacidades del bridge.
Tras el handshake, ambos pares pueden iniciar peticiones. `ping` comprueba la
conexión y `shutdown` responde antes de terminar el proceso. Cada nuevo
proceso negocia desde cero, sin estado residente del protocolo.

El adaptador mínimo añade `session.attach`, `session.detach` y `event.ingest`
para errores de tools o compactación. El bridge valida la sesión y confirma
estos mensajes; la persistencia y las decisiones del workflow pertenecen a
tareas posteriores.
