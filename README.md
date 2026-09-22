# xper

`xper` es un harness de desarrollo multiagente basado en prácticas de
Extreme Programming. Se integra en Pi como agente principal y añade una capa
de coordinación para gobernar el workflow, asignar modelos según el rol y
conservar evidencia local sobre calidad, tiempo, coste y rework.

> Estado: fundaciones ejecutables. El workspace y sus quality gates existen,
> pero el comportamiento de producto se implementará en las tareas siguientes.

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
pi --agent xper
```

También puede activarlo dentro de una sesión con `/agent xper`. El CLI de
`xper` configura, valida, diagnostica y exporta información; no sustituye la
ejecución interactiva de Pi con un comando `xper run`.

`xper init` y `xper doctor` deben verificar que Pi y `pi-open-agents` están
instalados y son compatibles. Si falta la extensión, deben explicar que es una
dependencia necesaria y mostrar el comando de instalación:

```bash
pi install npm:pi-open-agents
```

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
